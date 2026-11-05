"""CPU-only protocol tests. Fake inference isolates file, timestamp and overlap rules."""

import hashlib
import importlib.util
import io
from pathlib import Path
import queue
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("seedvr_worker", Path(__file__).with_name("seedvr_worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class FakeLifetime:
    cancelled = False

    def check(self):
        if self.cancelled:
            raise InterruptedError("cancelled")

    def eof(self):
        self.cancelled = True


class FakeBackend:
    def __init__(self, runtime, config, lifetime, scratch_directory):
        self.config = config
        self.lifetime = lifetime
        self.calls = []

    def infer(self, raw, count, seed):
        frame_bytes = self.config["width"] * self.config["height"] * 3
        self.calls.append((count, seed, hashlib.sha256(raw).hexdigest()))
        return [raw[index * frame_bytes] for index in range(count)]

    def blend(self, previous, current, count):
        if previous != current:
            raise AssertionError("Overlap references different source frames")
        return list(current)

    def copy_tail(self, frames, count):
        return list(frames[-count:]) if count else None

    def bgra_frames(self, frames, count):
        pixels = self.config["width"] * self.config["height"] * self.config["scale"] ** 2
        for value in frames[:count]:
            yield bytes((value, value, value, 255)) * pixels

    def close(self):
        pass


class FakeFrameTensor(list):
    """Tiny CPU stand-in with tensor assignment's copy, not alias, semantics."""
    def __init__(self, rows):
        super().__init__([list(row) for row in rows])

    def __getitem__(self, index):
        value = super().__getitem__(index)
        return FakeFrameTensor(value) if isinstance(index, slice) else value

    def __setitem__(self, index, value):
        super().__setitem__(index, list(value))


class FramewiseBackend(FakeBackend):
    class AllocationFailure(RuntimeError):
        pass

    infer = worker.SeedVRBackend.infer
    _infer_with_retry = worker.SeedVRBackend._infer_with_retry

    def __init__(self, *args):
        super().__init__(*args)
        self.frame_cache = []
        self.next_unique_frame = 0
        self.tile_size = 512
        self.releases = 0
        self.torch = SimpleNamespace(float16="fp16",
            empty=lambda shape, **kwargs: FakeFrameTensor([[None] for _ in range(shape[0])]),
            cuda=SimpleNamespace(OutOfMemoryError=self.AllocationFailure))

    def _check_resources(self):
        self.lifetime.check()

    def _infer(self, raw, count, seed):
        if count != 1:
            raise AssertionError("The model must receive exactly one source frame")
        self.calls.append((raw, count, seed, self.tile_size))
        return FakeFrameTensor([[raw[0]]])

    def _release(self):
        self.releases += 1

    def copy_tail(self, frames, count):
        return frames[-count:] if count else None

    def bgra_frames(self, frames, count):
        return super().bgra_frames([row[0] for row in frames], count)

    def close(self):
        self.frame_cache = []
        self.next_unique_frame = 0
        self._release()


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="enhancement-worker-", dir=Path(__file__).parents[2] / ".test-artifacts")
        self.directory = Path(self.temporary.name)
        self.lifetime = FakeLifetime()
        self.config = {"protocolVersion": 1, "width": 2, "height": 1, "scale": 2, "seed": 42,
                       "chunkFrames": 9, "overlapFrames": 4, "maximumFrames": 100, "maximumBytes": 600}
        self.job = worker.EnhancementJob(self.directory, self.directory, self.lifetime, FakeBackend)
        self.job.initialize(self.config)

    def tearDown(self):
        self.job.close()
        self.temporary.cleanup()

    def request(self, first, count, last=False):
        filename = f"input-{first:09d}.bgr" if count else None
        if count:
            (self.directory / filename).write_bytes(b"".join(bytes([index]) * 6 for index in range(first, first + count)))
        return {"firstFrame": first, "frameCount": count, "pts": [-5000 + index * index * 17001 for index in range(first, first + count)],
                "inputFile": filename, "last": last}

    def check_output(self, results, count):
        pixels = b""
        timestamps = []
        for result in results:
            self.assertEqual(result["outputFirstFrame"], len(timestamps))
            timestamps.extend(result["pts"])
            if result["outputFile"]:
                payload = (self.directory / result["outputFile"]).read_bytes()
                self.assertEqual(len(payload), result["bytes"])
                self.assertEqual(hashlib.sha256(payload).hexdigest(), result["sha256"])
                pixels += payload
        expected = b"".join(bytes((index, index, index, 255)) * 8 for index in range(count))
        self.assertEqual(pixels, expected)
        self.assertEqual(timestamps, [-5000 + index * index * 17001 for index in range(count)])
        self.assertEqual(self.job.next_input, count)
        self.assertEqual(self.job.next_output, count)
        self.assertTrue(results[-1]["complete"])

    def test_disjoint_chunks_preserve_sparse_pts_and_every_pixel(self):
        results = [self.job.process(self.request(0, 5)), self.job.process(self.request(5, 5)),
                   self.job.process(self.request(10, 5)), self.job.process(self.request(15, 2, True))]
        self.assertEqual([item["frameCount"] for item in results], [1, 5, 5, 6])
        self.assertEqual([call[0] for call in self.job.backend.calls], [5, 9, 9, 6])
        self.check_output(results, 17)

    def test_empty_flush_does_not_repeat_inference(self):
        results = [self.job.process(self.request(0, 5)), self.job.process(self.request(5, 5)),
                   self.job.process(self.request(10, 0, True))]
        self.assertEqual(len(self.job.backend.calls), 2)
        self.check_output(results, 10)

    def test_single_frame_final(self):
        result = self.job.process(self.request(0, 1, True))
        self.check_output([result], 1)

    def test_short_terminal_windows(self):
        for tail in range(1, 6):
            with self.subTest(tail=tail):
                other = self.directory / f"tail-{tail}"
                other.mkdir()
                self.job = worker.EnhancementJob(other, other, self.lifetime, FakeBackend)
                self.job.initialize(self.config)
                old = self.directory
                self.directory = other
                results = [self.job.process(self.request(0, 5)), self.job.process(self.request(5, tail, True))]
                self.check_output(results, 5 + tail)
                self.directory = old

    def test_input_length_mismatch(self):
        request = self.request(0, 5)
        (self.directory / request["inputFile"]).write_bytes(b"short")
        with self.assertRaisesRegex(ValueError, "size"):
            self.job.process(request)
        self.assertFalse(list(self.directory.glob("output-*")))

    def test_non_monotonic_timestamps_and_repeated_chunks(self):
        request = self.request(0, 5)
        request["pts"][2] = request["pts"][1]
        with self.assertRaisesRegex(ValueError, "strictly"):
            self.job.process(request)
        self.job.process(self.request(0, 5))
        with self.assertRaisesRegex(ValueError, "contiguous"):
            self.job.process(self.request(0, 5))

    def test_traversal_input(self):
        request = self.request(0, 5)
        request["inputFile"] = "../input-000000000.bgr"
        with self.assertRaisesRegex(ValueError, "name"):
            self.job.process(request)

    def test_capacity_and_limits(self):
        with self.assertRaisesRegex(ValueError, "inputCapacity"):
            self.job.process(self.request(0, 4))
        self.job.config["maximumFrames"] = 4
        with self.assertRaisesRegex(ValueError, "limits"):
            self.job.process(self.request(0, 5))

    def test_cancel_leaves_no_output(self):
        self.lifetime.cancelled = True
        with self.assertRaises(InterruptedError):
            self.job.process(self.request(0, 5))
        self.assertFalse(list(self.directory.glob("output-*")))

    def test_mid_output_failure_removes_partial(self):
        def failing_frames(frames, count):
            yield bytes(32)
            raise InterruptedError("cancelled during output")
        self.job.backend.bgra_frames = failing_frames
        with self.assertRaises(InterruptedError):
            self.job.process(self.request(0, 5, True))
        self.assertFalse(list(self.directory.glob("output-*")))
        self.assertEqual(self.job.next_input, 0)

    def test_existing_output_is_preserved(self):
        output = self.directory / "output-000000000.bgra"
        output.write_bytes(b"preserve")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.job.process(self.request(0, 5, True))
        self.assertEqual(output.read_bytes(), b"preserve")

    def test_completed_job_rejects_more_input(self):
        self.job.process(self.request(0, 1, True))
        with self.assertRaisesRegex(ValueError, "active"):
            self.job.process(self.request(1, 1, True))

    def test_strict_integer_and_geometry_validation(self):
        for key, value in [("protocolVersion", True), ("width", True), ("scale", 3), ("chunkFrames", 10), ("maximumBytes", 599), ("seed", -1)]:
            with self.subTest(key=key):
                job = worker.EnhancementJob(self.directory, self.directory, self.lifetime, FakeBackend)
                with self.assertRaises(ValueError):
                    job.initialize({**self.config, key: value})
        job = worker.EnhancementJob(self.directory, self.directory, self.lifetime, FakeBackend)
        with self.assertRaisesRegex(ValueError, "dimensions"):
            job.initialize({**self.config, "width": 2000, "scale": 4})

    def test_thirteen_frame_window_preserves_same_contract(self):
        self.job = worker.EnhancementJob(self.directory, self.directory, self.lifetime, FakeBackend)
        initialized = self.job.initialize({**self.config, "chunkFrames": 13})
        self.assertEqual(initialized["inputCapacity"], 9)
        results = [self.job.process(self.request(0, 9)), self.job.process(self.request(9, 9)),
                   self.job.process(self.request(18, 1, True))]
        self.assertEqual([call[0] for call in self.job.backend.calls], [9, 13, 5])
        self.check_output(results, 19)

    def test_unbuffered_reader_handles_split_and_multiple_requests(self):
        messages = queue.Queue()
        chunks = [b'{"id":1,', b'"method":"init"}\n{"id":2,"method":"close"}\n', b'']
        with patch.object(worker.os, "read", side_effect=chunks):
            worker.read_requests(messages, self.lifetime)
        self.assertEqual(messages.get_nowait(), {"id": 1, "method": "init"})
        self.assertEqual(messages.get_nowait(), {"id": 2, "method": "close"})
        self.assertIsNone(messages.get_nowait())
        self.assertTrue(self.lifetime.cancelled)

    def test_unbuffered_reader_rejects_oversized_request(self):
        messages = queue.Queue()
        with patch.object(worker.os, "read", return_value=b"a" * (1024 * 1024 + 1)):
            worker.read_requests(messages, self.lifetime)
        self.assertIsInstance(messages.get_nowait(), ValueError)
        self.assertTrue(self.lifetime.cancelled)

    def test_ram_and_commit_budgets_are_independent(self):
        required = worker.resource_requirements(self.config)
        available = {"physical": required["physical"] + worker.PHYSICAL_RESERVE,
                     "commit": required["physical"] + required["originalGeometryVram"] + worker.COMMIT_RESERVE}
        actual = worker.check_memory_budget(self.config, available)
        self.assertEqual(actual["physical"], required["physical"])
        with self.assertRaisesRegex(RuntimeError, "메모리가 부족"):
            worker.check_memory_budget(self.config, {**available, "physical": available["physical"] - 1})
        with self.assertRaisesRegex(RuntimeError, "Windows 커밋"):
            worker.check_memory_budget(self.config, {**available, "commit": available["commit"] - 1})

    def test_existing_allocations_are_not_counted_twice(self):
        required = worker.resource_requirements(self.config)
        vram_budget = required["vram"] + worker.GIB
        current_rss = worker.GIB
        current_commit = 2 * worker.GIB
        available = {"physical": required["physical"] - current_rss + worker.PHYSICAL_RESERVE,
                     "commit": required["physical"] + max(vram_budget, required["originalGeometryVram"]) - current_commit + worker.COMMIT_RESERVE}
        actual = worker.check_memory_budget(self.config, available, vram_budget, current_rss, current_commit)
        self.assertEqual(actual["commit"], required["physical"] + max(vram_budget, required["originalGeometryVram"]))
        with self.assertRaisesRegex(RuntimeError, "메모리가 부족"):
            worker.check_memory_budget(self.config, available, vram_budget)
        worker.check_memory_budget(self.config, {"physical": worker.PHYSICAL_RESERVE, "commit": worker.COMMIT_RESERVE},
                                   vram_budget, required["physical"] + 1, actual["commit"] + 1)

    def test_resolution_and_window_increase_resource_estimates(self):
        baseline = worker.resource_requirements(self.config)
        for changes in ({"width": 4}, {"height": 2}, {"scale": 4}, {"chunkFrames": 13}):
            with self.subTest(changes=changes):
                changed = worker.resource_requirements({**self.config, **changes})
                self.assertGreater(changed["physical"], baseline["physical"])
                self.assertGreater(changed["originalGeometryVram"], baseline["originalGeometryVram"])
                if "chunkFrames" in changes:
                    self.assertEqual(changed["vram"], baseline["vram"])
                else:
                    self.assertGreater(changed["vram"], baseline["vram"])
        tiny = worker.resource_requirements({**self.config, "width": 160, "height": 90})
        self.assertGreater(tiny["physical"], 2216235008)
        self.assertGreater(tiny["vram"], 7918845952)

    def test_tile_policy_uses_the_measured_output_boundary(self):
        tiny = worker.resource_requirements({**self.config, "width": 160, "height": 90})
        below = worker.resource_requirements({**self.config, "width": 319, "height": 180})
        boundary = worker.resource_requirements({**self.config, "width": 320, "height": 180})
        self.assertEqual(tiny["vaeTileSize"], 512)
        self.assertEqual(below["vaeTileSize"], 512)
        self.assertEqual(boundary["vaeTileSize"], 256)
        self.assertGreater(tiny["vram"], 9462349824)

    def test_only_one_smaller_tile_retry_preserves_input_and_seed(self):
        class AllocationFailure(Exception):
            pass
        backend = worker.SeedVRBackend.__new__(worker.SeedVRBackend)
        backend.tile_size = 512
        backend.lifetime = self.lifetime
        backend.torch = SimpleNamespace(cuda=SimpleNamespace(OutOfMemoryError=AllocationFailure))
        backend._check_resources = lambda: None
        attempts = []
        releases = []
        backend._release = lambda: releases.append(True)
        def infer(raw, count, seed):
            attempts.append((raw, count, seed, backend.tile_size))
            if backend.tile_size == 512:
                raise AllocationFailure()
            return "complete"
        backend._infer = infer
        with patch.object(worker, "send"):
            self.assertEqual(backend._infer_with_retry(b"same input", 1, 42), "complete")
        self.assertEqual(attempts, [(b"same input", 1, 42, 512), (b"same input", 1, 42, 256)])
        self.assertEqual(len(releases), 1)
        attempts.clear()
        def fail(raw, count, seed):
            attempts.append((raw, count, seed, backend.tile_size))
            raise AllocationFailure()
        backend._infer = fail
        with self.assertRaises(AllocationFailure):
            backend._infer_with_retry(b"same input", 1, 42)
        self.assertEqual(attempts, [(b"same input", 1, 42, 256)])
        self.assertEqual(len(releases), 2)

    def use_framewise_backend(self):
        self.job.close()
        self.job = worker.EnhancementJob(self.directory, self.directory, self.lifetime, FramewiseBackend)
        self.job.initialize(self.config)
        return self.job.backend

    def test_framewise_fifteen_sources_use_fifteen_native_calls_and_four_cached_frames(self):
        backend = self.use_framewise_backend()
        results = [self.job.process(self.request(0, 5)), self.job.process(self.request(5, 5)),
                   self.job.process(self.request(10, 5, True))]
        self.assertEqual([row["frameCount"] for row in results], [1, 5, 9])
        self.assertEqual([row[0][0] for row in backend.calls], list(range(15)))
        self.assertTrue(all(count == 1 and seed == 42 for _, count, seed, _ in backend.calls))
        self.assertEqual([row[0] for row in backend.frame_cache], [11, 12, 13, 14])
        self.check_output(results, 15)

    def test_framewise_seventeen_sources_preserve_short_tail_and_sparse_pts(self):
        backend = self.use_framewise_backend()
        results = [self.job.process(self.request(0, 5)), self.job.process(self.request(5, 5)),
                   self.job.process(self.request(10, 5)), self.job.process(self.request(15, 2, True))]
        self.assertEqual([row["frameCount"] for row in results], [1, 5, 5, 6])
        self.assertEqual([row[0][0] for row in backend.calls], list(range(17)))
        self.check_output(results, 17)

    def test_framewise_ten_source_empty_flush_never_calls_model_again(self):
        backend = self.use_framewise_backend()
        results = [self.job.process(self.request(0, 5)), self.job.process(self.request(5, 5)),
                   self.job.process(self.request(10, 0, True))]
        self.assertEqual([row["frameCount"] for row in results], [1, 5, 4])
        self.assertEqual([row[0][0] for row in backend.calls], list(range(10)))
        self.check_output(results, 10)

    def test_framewise_single_frame_and_equal_pixels_keep_source_identity(self):
        backend = self.use_framewise_backend()
        result = self.job.process(self.request(0, 1, True))
        self.assertEqual(len(backend.calls), 1)
        self.check_output([result], 1)
        other = FramewiseBackend(self.directory, self.config, self.lifetime, self.directory)
        other.infer(bytes(5 * 6), 5, 42)
        other.infer(bytes(9 * 6), 9, 42)
        self.assertEqual(len(other.calls), 10)  # Equal pixels are not a deduplication key.
        self.assertEqual([row[0] for row in other.frame_cache], [6, 7, 8, 9])

    def test_framewise_checks_all_cached_hashes_and_ids_before_new_native_work(self):
        backend = self.use_framewise_backend()
        raw = lambda first, count: b"".join(bytes([index]) * 6 for index in range(first, first + count))
        backend.infer(raw(0, 5), 5, 42)
        retained = list(backend.frame_cache)
        changed = bytearray(raw(1, 9)); changed[3 * 6] ^= 1
        with self.assertRaisesRegex(RuntimeError, "source frame changed"):
            backend.infer(bytes(changed), 9, 42)
        self.assertEqual(len(backend.calls), 5)
        self.assertEqual(backend.next_unique_frame, 5)
        self.assertEqual(backend.frame_cache, retained)
        index, digest, prediction = backend.frame_cache[-1]
        backend.frame_cache[-1] = (index + 1, digest, prediction)
        with self.assertRaisesRegex(RuntimeError, "source frame changed"):
            backend.infer(raw(1, 9), 9, 42)
        self.assertEqual(len(backend.calls), 5)

    def test_framewise_returned_window_never_aliases_retained_predictions(self):
        backend = self.use_framewise_backend()
        raw = lambda first, count: b"".join(bytes([index]) * 6 for index in range(first, first + count))
        output = backend.infer(raw(0, 5), 5, 42)
        output[1][0] = 255
        self.assertEqual(backend.frame_cache[0][2], [1])
        next_output = backend.infer(raw(1, 9), 9, 42)
        self.assertEqual(next_output[0], [1])
        next_output[-1][0] = 254
        self.assertEqual(backend.frame_cache[-1][2], [9])

    def test_framewise_cancel_during_new_frame_does_not_publish_partial_window(self):
        backend = self.use_framewise_backend()
        self.job.process(self.request(0, 5))
        retained = list(backend.frame_cache)
        native = backend._infer
        def cancel_after_native(raw, count, seed):
            output = native(raw, count, seed)
            if raw[0] == 7:
                self.lifetime.cancelled = True
            return output
        backend._infer = cancel_after_native
        with self.assertRaises(InterruptedError):
            self.job.process(self.request(5, 5))
        self.assertEqual(backend.next_unique_frame, 5)
        self.assertEqual(backend.frame_cache, retained)
        self.assertFalse((self.directory / 'output-000000001.bgra').exists())
        self.assertEqual(list(self.directory.glob('*.partial')), [])

    def test_framewise_one_oom_retries_only_new_frame_and_preserves_cached_prefix(self):
        backend = self.use_framewise_backend()
        self.job.process(self.request(0, 5))
        retained = list(backend.frame_cache)
        native = backend._infer
        def fail_one(raw, count, seed):
            output = native(raw, count, seed)
            if raw[0] == 5 and backend.tile_size == 512:
                raise backend.AllocationFailure("one measured smaller-tile retry")
            return output
        backend._infer = fail_one
        with patch.object(worker, 'send'):
            result = self.job.process(self.request(5, 5, True))
        self.assertEqual(backend.releases, 1)
        self.assertEqual([row[0][0] for row in backend.calls], [0, 1, 2, 3, 4, 5, 5, 6, 7, 8, 9])
        self.assertEqual([row[3] for row in backend.calls[5:7]], [512, 256])
        self.assertEqual([row[2] for row in retained], [[1], [2], [3], [4]])
        self.assertEqual(result['frameCount'], 9)

    def test_framewise_hd_forecast_preserves_measured_host_and_original_commit(self):
        config = {**self.config, 'width': 960, 'height': 540}
        required = worker.resource_requirements(config)
        self.assertEqual(required['copyBytes'], 459302400)
        self.assertEqual(required['physical'], 4294313472)
        self.assertEqual(required['vram'], 9832878854)
        self.assertEqual(required['originalGeometryVram'], 10894562054)
        self.assertEqual(required['vaeTileSize'], 256)
        budget = 10302573772
        self.assertEqual(worker.select_block_swap(config, budget), 0)
        expected_commit = 15188875526
        for rss, private in ((0, 0), (2 * worker.GIB, 8 * worker.GIB)):
            available = {'physical': required['physical'] - rss + worker.PHYSICAL_RESERVE,
                         'commit': expected_commit - private + worker.COMMIT_RESERVE}
            self.assertEqual(worker.check_memory_budget(config, available, budget, rss, private)['commit'], expected_commit)
            for metric in ('physical', 'commit'):
                with self.subTest(metric=metric, rss=rss), self.assertRaises(RuntimeError):
                    worker.check_memory_budget(config, {**available, metric: available[metric] - 1}, budget, rss, private)

    def test_direct_plan_is_preserved_and_partial_plan_is_only_a_fallback(self):
        medium = {**self.config, "width": 640, "height": 360}
        hd = {**self.config, "width": 960, "height": 540}
        direct = worker.resource_requirements(medium)
        self.assertEqual(worker.resource_requirements(medium, 0), direct)
        self.assertEqual(worker.select_block_swap(medium, direct["vram"]), 0)
        self.assertEqual(worker.select_block_swap(medium, direct["vram"] - 1), 8)
        partial = worker.resource_requirements(hd, 8)
        self.assertEqual(worker.select_block_swap(hd, partial["vram"]), 8)
        with self.assertRaisesRegex(RuntimeError, "GPU 메모리"):
            worker.select_block_swap(hd, partial["vram"] - 1)
        self.assertEqual(worker.select_block_swap(hd, worker.resource_requirements(hd)["vram"]), 0)
        for blocks in (True, 1, 16):
            with self.subTest(blocks=blocks), self.assertRaises(ValueError):
                worker.resource_requirements(hd, blocks)

    def test_partial_plan_covers_initial_load_and_original_commit_with_margin(self):
        config = {**self.config, "width": 960, "height": 540}
        direct = worker.resource_requirements(config)
        partial = worker.resource_requirements(config, 8)
        self.assertEqual(partial["physical"], direct["physical"] + worker.CPU_BLOCK_WEIGHT_BYTES)
        initial_load = worker.DIT_WEIGHT_BYTES + worker.VAE_WEIGHT_BYTES + 9 * worker.GIB // 4
        self.assertEqual(partial["vram"], max(initial_load, direct["vram"] - worker.CPU_BLOCK_WEIGHT_BYTES + worker.ACTIVE_BLOCK_WEIGHT_BYTES))
        for budget in (partial["vram"], direct["vram"] + worker.GIB):
            for rss, private in ((0, 0), (4 * worker.GIB, 10 * worker.GIB)):
                expected_commit = partial["physical"] + max(budget, direct["originalGeometryVram"]) + worker.GIB
                available = {"physical": max(0, partial["physical"] - rss) + worker.PHYSICAL_RESERVE,
                             "commit": max(0, expected_commit - private) + worker.COMMIT_RESERVE}
                actual = worker.check_memory_budget(config, available, budget, rss, private, 8)
                self.assertEqual(actual["commit"], expected_commit)
                self.assertGreater(actual["commit"], 18085048320)
                for metric in ("physical", "commit"):
                    below = {**available, metric: available[metric] - 1}
                    with self.subTest(budget=budget, metric=metric), self.assertRaises(RuntimeError):
                        worker.check_memory_budget(config, below, budget, rss, private, 8)

    def runner_fixture(self, blocks=8, cached=False):
        backend = worker.SeedVRBackend.__new__(worker.SeedVRBackend)
        backend.blocks_to_swap = blocks
        backend.torch = SimpleNamespace(float16="fp16", float32="fp32", device=lambda value: value)
        backend.context = {"compute_dtype": "bf16"}
        names = [f"blocks.{index}.weight" for index in range(32)] + ["output.weight", "blocks.0.attn.rope.rope.freqs"]
        parameters = []
        for index, name in enumerate(names):
            block = int(name.split(".")[1]) if name.startswith("blocks.") else None
            device = "cpu" if cached and block is not None and block < blocks else "cuda" if cached else "meta"
            parameters.append((name, SimpleNamespace(dtype="fp16" if cached else "fp32", device=SimpleNamespace(type=device))))
        model = SimpleNamespace(blocks=list(range(32)),
            named_parameters=lambda: iter((name, value) for name, value in parameters if not name.endswith(".freqs")),
            state_dict=lambda: dict(parameters))
        block_device = "cpu" if blocks else "cuda:0"
        backend.runner = SimpleNamespace(dit=model, _dit_offload_device=block_device, _vae_offload_device="cpu",
            _compute_dtype="bf16", _dit_attention_mode="sdpa",
            _dit_block_swap_config={"blocks_to_swap": blocks, "swap_io_components": False, "offload_device": block_device})
        cache = {"dit_cache": True, "vae_cache": True, "dit_model": worker.MODEL_NAME,
                 "vae_model": worker.VAE_NAME, "cached_dit": model if cached else None}
        return backend, cache, parameters

    def test_pinned_runner_restores_cuda_for_each_meta_and_cached_prepare(self):
        for blocks in (0, 8):
            for cached in (False, True):
                with self.subTest(blocks=blocks, cached=cached):
                    backend, cache, parameters = self.runner_fixture(blocks, cached)
                    backend._configure_runner_devices(cache)
                    self.assertEqual(backend.runner._dit_offload_device, "cuda:0")
                    backend.runner._dit_offload_device = "cpu" if blocks else "cuda:0"
                    backend._configure_runner_devices(cache)
                    self.assertEqual(backend.runner._dit_offload_device, "cuda:0")

    def test_cached_runner_rejects_wrong_placement_dtype_and_config(self):
        changes = (lambda backend, parameters: setattr(parameters[0][1].device, "type", "cuda"),
                   lambda backend, parameters: setattr(parameters[8][1], "dtype", "fp32"),
                   lambda backend, parameters: backend.runner.dit.blocks.pop(),
                   lambda backend, parameters: backend.runner._dit_block_swap_config.update(blocks_to_swap=16))
        for change in changes:
            backend, cache, parameters = self.runner_fixture(cached=True)
            change(backend, parameters)
            with self.assertRaisesRegex(RuntimeError, "AI 모델"):
                backend._configure_runner_devices(cache)
            self.assertEqual(backend.runner._dit_offload_device, "cuda:0")

    def test_cached_persistent_buffer_device_and_dtype_are_validated(self):
        for fault in ("device", "dtype"):
            backend, cache, values = self.runner_fixture(cached=True)
            buffer = dict(values)["blocks.0.attn.rope.rope.freqs"]
            if fault == "device":
                buffer.device.type = "cuda"
            else:
                buffer.dtype = "fp32"
            with self.subTest(fault=fault), self.assertRaisesRegex(RuntimeError, "메모리 배치"):
                backend._configure_runner_devices(cache)
            self.assertEqual(backend.runner._dit_offload_device, "cuda:0")

    def test_failed_partial_cleanup_still_drops_caches_and_restores_loader(self):
        backend, cache, parameters = self.runner_fixture(cached=True)
        backend.debug = object()
        backend.context = object()
        emptied = Mock()
        backend.torch.cuda = SimpleNamespace(empty_cache=emptied)
        cached = SimpleNamespace(remove_dit=Mock(), remove_vae=Mock())
        backend.get_cache = lambda: cached
        def fail_cleanup(runner, *args, **kwargs):
            self.assertEqual(runner._dit_offload_device, "cuda:0")
            raise RuntimeError("cleanup failure")
        backend.complete_cleanup = fail_cleanup
        backend.loader_hook = object()
        backend.original_model_loader = object()
        backend.model_loader = SimpleNamespace(load_safetensors_file=backend.loader_hook)
        with self.assertRaisesRegex(RuntimeError, "cleanup failure"):
            backend.close()
        self.assertIsNone(backend.context)
        self.assertIsNone(backend.runner)
        cached.remove_dit.assert_called_once()
        cached.remove_vae.assert_called_once()
        emptied.assert_called_once()
        self.assertIs(backend.model_loader.load_safetensors_file, backend.original_model_loader)

    def test_terminal_cuda_error_is_short_but_full_details_reach_stderr(self):
        class AllocationFailure(Exception):
            pass
        module = SimpleNamespace(cuda=SimpleNamespace(OutOfMemoryError=AllocationFailure))
        details = "Original CUDA allocation details retained for diagnosis"
        stderr = io.StringIO()
        with patch.dict(worker.sys.modules, {"torch": module}), patch.object(worker.sys, "stderr", stderr):
            message = worker.protocol_error(AllocationFailure(details))
        self.assertEqual(message, "GPU 메모리가 부족합니다. 다른 GPU 작업이 끝난 뒤 다시 시도해 주세요.")
        self.assertIn(details, stderr.getvalue())
        self.assertNotIn(details, message)
        self.assertEqual(worker.protocol_error(ValueError("source changed")), "source changed")

    def test_memory_preflight_does_not_read_models(self):
        for available, message in (({"physical": worker.GIB, "commit": 30 * worker.GIB}, "메모리가 부족"),
                                   ({"physical": 20 * worker.GIB, "commit": worker.GIB}, "Windows 커밋")):
            with self.subTest(available=available), patch.object(worker, "available_memory", return_value=available), \
                    patch.object(worker.SeedVRBackend, "_verify_models") as verify:
                with self.assertRaisesRegex(RuntimeError, message):
                    worker.SeedVRBackend(self.directory, self.config, self.lifetime, self.directory)
                verify.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
