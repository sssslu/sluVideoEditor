"""Bounded native-frame SeedVR2 worker. Media timing and muxing belong to the parent."""

import argparse
import contextlib
import ctypes
import faulthandler
import gc
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import site
import stat
import sys
import threading
import time
import traceback


# Installed runtime inventories are immutable. Python caches must not change them.
sys.dont_write_bytecode = True
SAFE_INTEGER = 9007199254740991
PROTOCOL_VERSION = 1
MAXIMUM_PIXELS = 33177600
MAXIMUM_DIMENSION = 7680
MODEL_NAME = "seedvr2_ema_3b_fp16.safetensors"
VAE_NAME = "ema_vae_fp16.safetensors"
PROTOCOL_OUTPUT = sys.stdout
OUTPUT_LOCK = threading.Lock()
GIB = 1024 ** 3
PHYSICAL_RESERVE = 3 * GIB
COMMIT_RESERVE = 4 * GIB
DIT_WEIGHT_BYTES = 6782952896
VAE_WEIGHT_BYTES = 501296454
CPU_BLOCK_WEIGHT_BYTES = 2538135888
ACTIVE_BLOCK_WEIGHT_BYTES = 317266986
PARTIAL_COMMIT_MARGIN = GIB


def send(value):
    with OUTPUT_LOCK:
        PROTOCOL_OUTPUT.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
        PROTOCOL_OUTPUT.flush()


def integer(value, name, minimum=0, maximum=SAFE_INTEGER):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"Invalid {name}")
    return value


def local_directory(value):
    candidate = Path(value)
    if not candidate.is_absolute() or str(candidate).startswith(("\\\\", "//")):
        raise ValueError("A local absolute directory is required")
    for component in [candidate, *candidate.parents]:
        info = component.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Linked or reparse-point directories are not accepted")
    if not candidate.is_dir():
        raise ValueError("Directory does not exist")
    return candidate.resolve(strict=True)


def regular_file(directory, filename, expected_bytes=None):
    if not isinstance(filename, str) or Path(filename).name != filename or any(c in filename for c in "\\/:"):
        raise ValueError("Invalid relative file name")
    candidate = directory / filename
    info = candidate.lstat()
    if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("A regular local file is required")
    if expected_bytes is not None and info.st_size != expected_bytes:
        raise ValueError("Input file size does not match the declared frame count")
    return candidate, info


def loaded_runtime_libraries(runtime):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetModuleHandleW.argtypes = [ctypes.c_wchar_p]
    kernel.GetModuleHandleW.restype = ctypes.c_void_p
    kernel.GetModuleFileNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_ulong]
    kernel.GetModuleFileNameW.restype = ctypes.c_ulong
    libraries = {}
    for name in ("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"):
        handle = kernel.GetModuleHandleW(name)
        filename = ctypes.create_unicode_buffer(32768)
        length = kernel.GetModuleFileNameW(handle, filename, len(filename)) if handle else 0
        if not length or length >= len(filename):
            raise RuntimeError("An app-local Microsoft C++ runtime library was not loaded")
        if os.path.normcase(str(Path(filename.value).resolve())) != os.path.normcase(str(runtime / "python" / name)):
            raise RuntimeError("The AI engine loaded a Microsoft C++ library outside its verified runtime")
        libraries[name] = filename.value
    return libraries


def available_memory():
    class PerformanceInfo(ctypes.Structure):
        _fields_ = [("size", ctypes.c_uint32)] + [(name, ctypes.c_size_t) for name in (
            "commit_total", "commit_limit", "commit_peak", "physical_total", "physical_available",
            "system_cache", "kernel_total", "kernel_paged", "kernel_nonpaged", "page_size")]
        _fields_ += [("handles", ctypes.c_uint32), ("processes", ctypes.c_uint32), ("threads", ctypes.c_uint32)]
    status = PerformanceInfo()
    status.size = ctypes.sizeof(status)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    psapi.GetPerformanceInfo.argtypes = [ctypes.POINTER(PerformanceInfo), ctypes.c_uint32]
    psapi.GetPerformanceInfo.restype = ctypes.c_int
    if not psapi.GetPerformanceInfo(ctypes.byref(status), ctypes.sizeof(status)):
        raise ctypes.WinError(ctypes.get_last_error())
    # These are system-wide page counts. GlobalMemoryStatusEx's available
    # pagefile field can instead be limited by the calling process's Job cap.
    return {"physical": status.physical_available * status.page_size,
            "commit": max(0, status.commit_limit - status.commit_total) * status.page_size}


def resource_requirements(config, blocks_to_swap=0):
    if type(blocks_to_swap) is not int or blocks_to_swap not in (0, 8):
        raise ValueError("Only zero or eight swapped blocks are supported")
    output_pixels = config["width"] * config["height"] * config["scale"] ** 2
    window = config["chunkFrames"]
    # Only one frame enters the model. Transport still retains four frames
    # and constructs a complete window on the CPU. Preserve the measured
    # nine-frame host/commit allowance instead of treating those buffers as one.
    transport_physical = 3 * GIB + output_pixels * (window * 24 + 80)
    # Bound cached/results/pending FP16 copies and per-frame encoding scratch.
    # Raw input covers 2*window+1 worker frames plus a conservative 15-frame
    # parent/decoder allowance used in the verified HD frame-one diagnostic.
    copy_bytes = output_pixels * ((2 * window + 4) * 6 + 64)
    copy_bytes += config["width"] * config["height"] * (2 * window + 16) * 3
    physical = transport_physical + copy_bytes
    initial_load = DIT_WEIGHT_BYTES + VAE_WEIGHT_BYTES + 9 * GIB // 4
    original_geometry_vram = initial_load + output_pixels * window * 64
    vram = initial_load + output_pixels * 64
    if blocks_to_swap:
        physical += CPU_BLOCK_WEIGHT_BYTES
        # The complete checkpoint is first materialized on CUDA. During
        # inference one of the CPU blocks returns to CUDA at a time.
        vram = max(initial_load, vram - CPU_BLOCK_WEIGHT_BYTES + ACTIVE_BLOCK_WEIGHT_BYTES)
    # At 640x360 output, 512-pixel VAE tiles exhausted the allocation
    # budget on the second temporal window. Its 256-pixel retry completed.
    tile_size = 256 if output_pixels >= 640 * 360 else 512
    return {"physical": physical, "vram": vram, "vaeTileSize": tile_size,
            "originalGeometryVram": original_geometry_vram, "copyBytes": copy_bytes}


def select_block_swap(config, vram_budget):
    blocks = 0 if resource_requirements(config)["vram"] <= vram_budget else 8
    required = resource_requirements(config, blocks)["vram"]
    if required > vram_budget:
        raise RuntimeError(f"GPU 메모리가 부족합니다. 필요 {required / GIB:.1f} GiB, 처리 한도 {vram_budget / GIB:.1f} GiB")
    return blocks


def check_memory_budget(config, available, vram_budget=None, current_rss=0, current_commit=0, blocks_to_swap=0):
    requirements = resource_requirements(config, blocks_to_swap)
    # Retain the complete direct-mode device allowance in Windows commit.
    # The measured 1080p partial mode also needs an additional commit margin.
    direct_vram = requirements["originalGeometryVram"]
    requirements["commit"] = requirements["physical"] + max(vram_budget or 0, direct_vram)
    if blocks_to_swap:
        requirements["commit"] += PARTIAL_COMMIT_MARGIN
    physical_needed = max(0, requirements["physical"] - current_rss) + PHYSICAL_RESERVE
    commit_needed = max(0, requirements["commit"] - current_commit) + COMMIT_RESERVE
    if available["physical"] < physical_needed:
        raise RuntimeError(f"화질 향상에 필요한 메모리가 부족합니다. 필요 {physical_needed / GIB:.1f} GiB, 사용 가능 {available['physical'] / GIB:.1f} GiB")
    if available["commit"] < commit_needed:
        raise RuntimeError(f"Windows 커밋 여유가 부족합니다. 필요 {commit_needed / GIB:.1f} GiB, 사용 가능 {available['commit'] / GIB:.1f} GiB")
    return requirements


def protocol_error(error):
    cuda = getattr(sys.modules.get("torch"), "cuda", None)
    if cuda is not None and isinstance(error, cuda.OutOfMemoryError):
        traceback.print_exception(error, file=sys.stderr)
        return "GPU 메모리가 부족합니다. 다른 GPU 작업이 끝난 뒤 다시 시도해 주세요."
    return str(error)


class Lifetime:
    """A process handle prevents PID reuse from extending an orphaned GPU job."""

    def __init__(self, parent_pid):
        if os.name != "nt":
            raise RuntimeError("This runtime requires Windows")
        if integer(parent_pid, "parent PID", 1) != os.getppid():
            raise ValueError("Parent PID does not match the spawning process")
        self.cancelled = threading.Event()
        self.finished = threading.Event()
        self.eof_at = None
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        self.kernel.OpenProcess.restype = ctypes.c_void_p
        self.kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        self.kernel.WaitForSingleObject.restype = ctypes.c_ulong
        self.kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        self.kernel.CloseHandle.restype = ctypes.c_int
        self.handle = self.kernel.OpenProcess(0x00100000, False, parent_pid)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        self.thread = threading.Thread(target=self._watch, daemon=True)
        self.thread.start()

    def _watch(self):
        while not self.finished.wait(0.1):
            state = self.kernel.WaitForSingleObject(self.handle, 0)
            if state != 0x102:
                os._exit(76)
            if self.eof_at is not None and time.monotonic() - self.eof_at >= 3:
                os._exit(77)

    def eof(self):
        self.cancelled.set()
        self.eof_at = time.monotonic()

    def check(self):
        if self.cancelled.is_set():
            raise InterruptedError("Enhancement cancelled")

    def close(self):
        self.finished.set()
        self.thread.join(timeout=1)
        self.kernel.CloseHandle(self.handle)


class SeedVRBackend:
    def __init__(self, runtime, config, lifetime, scratch_directory):
        self.runtime = runtime
        self.config = config
        self.lifetime = lifetime
        self.runner = None
        self.context = None
        self.frame_cache = []
        self.next_unique_frame = 0
        self.tile_size = resource_requirements(config)["vaeTileSize"]
        self.blocks_to_swap = 0
        # Reject an already impossible request before reading gigabytes of weights.
        # Recheck after imports below, because other applications can consume RAM.
        check_memory_budget(config, available_memory())
        for component in ("vendor", "upstream", "models"):
            local_directory(runtime / component)
        send({"type": "progress", "progress": 0, "message": "AI 모델 검사"})
        self._verify_models()
        site.addsitedir(str(runtime / "vendor"))
        sys.path.insert(0, str(runtime / "upstream"))
        cache_directory = scratch_directory / "worker-cache"
        cache_directory.mkdir()
        for variable, component in (("HF_HOME", "huggingface"), ("TORCH_HOME", "torch"), ("MPLCONFIGDIR", "matplotlib")):
            os.environ[variable] = str(cache_directory / component)
        temporary = cache_directory / "temporary"
        temporary.mkdir()
        os.environ["TEMP"] = str(temporary)
        os.environ["TMP"] = str(temporary)
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "backend:cudaMallocAsync")
        os.environ.setdefault("MPLBACKEND", "Agg")
        send({"type": "progress", "progress": 0, "message": "AI 실행 환경 준비"})
        import torch
        import numpy as np
        import psutil
        from src.core import generation_phases, generation_utils, model_loader
        from src.core.model_cache import get_global_cache
        from src.optimization.memory_manager import complete_cleanup
        from src.utils.debug import Debug

        self.torch = torch
        self.np = np
        self.phases = generation_phases
        self.utils = generation_utils
        self.get_cache = get_global_cache
        self.complete_cleanup = complete_cleanup
        self.debug = Debug(enabled=False)
        self.psutil = psutil
        self.model_loader = model_loader
        loader_spec = importlib.util.spec_from_file_location("slu_enhancement_tensors", Path(__file__).with_name("tensor_loader.py"))
        loader_module = importlib.util.module_from_spec(loader_spec)
        loader_spec.loader.exec_module(loader_module)
        self.load_fp16_file = loader_module.load_fp16_file
        crt_libraries = loaded_runtime_libraries(runtime)
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA를 지원하는 NVIDIA GPU와 호환 드라이버가 필요합니다.")
        free_vram, total_vram = torch.cuda.mem_get_info(0)
        if free_vram < 2 * 1024 ** 3:
            raise RuntimeError(f"GPU 메모리 여유가 부족합니다. 필요 2.0 GiB, 사용 가능 {free_vram / GIB:.1f} GiB")
        # Keep the verified FP16 weights on CUDA and leave device memory for
        # other applications. The host budget excludes a duplicate DiT copy.
        fraction = min(0.60, free_vram * 0.70 / total_vram)
        # This limits the allocator's accounting. CUDA pool reservations and
        # driver allocations can exceed that amount, so record them separately.
        torch.cuda.set_per_process_memory_fraction(fraction, 0)
        vram_budget = int(total_vram * fraction)
        self.blocks_to_swap = select_block_swap(config, vram_budget)
        process_memory = psutil.Process().memory_info()
        memory = available_memory()
        requirements = check_memory_budget(config, memory, vram_budget, process_memory.rss, process_memory.private, self.blocks_to_swap)
        self.hardware = {
            "gpuName": torch.cuda.get_device_name(0), "availableVramBytes": free_vram,
            "vramBudgetBytes": vram_budget, "availableRamBytes": memory["physical"],
            "availableCommitBytes": memory["commit"], "estimatedRamBytes": requirements["physical"],
            "estimatedVramBytes": requirements["vram"], "estimatedCommitBytes": requirements["commit"],
            "directEstimatedVramBytes": resource_requirements(config, 0)["vram"],
            "partialEstimatedVramBytes": resource_requirements(config, 8)["vram"],
            "originalGeometryVramBytes": requirements["originalGeometryVram"],
            "frameCopyAllowanceBytes": requirements["copyBytes"],
            "inferenceStrategy": "independent-frames-v1", "modelTemporalFrames": 1,
            "transportWindowFrames": config["chunkFrames"], "overlapReuseFrames": 4,
            "memoryPolicy": "partial-cuda-8-v1" if self.blocks_to_swap else "direct-cuda-v1",
            "blocksToSwap": self.blocks_to_swap, "cpuWeightBytes": CPU_BLOCK_WEIGHT_BYTES if self.blocks_to_swap else 0,
            "partialCommitMarginBytes": PARTIAL_COMMIT_MARGIN if self.blocks_to_swap else 0,
            "vaeTileSize": self.tile_size,
            "vramBudgetKind": "torch-allocator-accounted-bytes", "vramEstimateKind": "reserved-device-memory",
            "cudaAllocator": torch.cuda.get_allocator_backend(), "torchVersion": torch.__version__,
            "cudnnVersion": torch.backends.cudnn.version(), "crtLibraries": crt_libraries,
        }
        self.original_model_loader = model_loader.load_safetensors_file
        self.loader_hook = self._load_model
        model_loader.load_safetensors_file = self.loader_hook

    def _verify_models(self):
        manifest_path = Path(__file__).with_name("backend-manifest.json")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.models = {}
        for artifact in manifest["artifacts"]:
            if artifact["id"] not in ("seedvr-3b", "seedvr-vae"):
                continue
            self.lifetime.check()
            filename, initial = regular_file(self.runtime / "models", artifact["filename"], artifact["bytes"])
            digest = hashlib.sha256()
            with filename.open("rb") as source:
                for data in iter(lambda: source.read(4 * 1024 ** 2), b""):
                    self.lifetime.check()
                    check_memory_budget(self.config, available_memory())
                    digest.update(data)
            final = filename.stat()
            if (initial.st_size, initial.st_mtime_ns, initial.st_ino) != (final.st_size, final.st_mtime_ns, final.st_ino):
                raise RuntimeError("AI model changed during verification")
            if digest.hexdigest() != artifact["sha256"]:
                raise RuntimeError("AI model checksum mismatch")
            self.models[artifact["filename"]] = artifact
        if set(self.models) != {MODEL_NAME, VAE_NAME}:
            raise RuntimeError("The pinned AI model manifest is incomplete")

    def _check_resources(self):
        self.lifetime.check()
        current = self.psutil.Process().memory_info()
        check_memory_budget(self.config, available_memory(), self.hardware["vramBudgetBytes"], current.rss, current.private, self.blocks_to_swap)
        free_vram, _ = self.torch.cuda.mem_get_info(0)
        additional = max(0, self.hardware["estimatedVramBytes"] - self.torch.cuda.memory_reserved(0))
        if additional > free_vram * 0.70:
            raise RuntimeError(f"처리 중 GPU 메모리 여유가 줄었습니다. 추가 필요 {additional / GIB:.1f} GiB, 사용 가능 {free_vram * 0.70 / GIB:.1f} GiB")

    def _load_model(self, filename, device="cpu"):
        filename = Path(filename).resolve(strict=True)
        if filename.parent != self.runtime / "models" or filename.name not in self.models:
            raise ValueError("Only the two pinned AI model files can be loaded")
        self._check_resources()
        artifact = self.models[filename.name]
        return self.load_fp16_file(filename, device, self.torch, artifact["sha256"], artifact["bytes"], self._check_resources)

    def _progress(self, current, total, frames, phase):
        self._check_resources()
        send({"type": "progress", "progress": current / max(total, 1), "message": str(phase)})

    def _release(self):
        self.context = None
        try:
            if self.runner is not None:
                # A failed cached prepare may have restored the CPU validation
                # target. Cleanup must never copy the complete DiT onto the CPU.
                self.runner._dit_offload_device = self.torch.device("cuda:0")
                self.complete_cleanup(self.runner, self.debug, dit_cache=False, vae_cache=False)
        finally:
            self.runner = None
            cache = self.get_cache()
            cache.remove_dit({"node_id": "slu_enhancement_dit"}, self.debug)
            cache.remove_vae({"node_id": "slu_enhancement_vae"}, self.debug)
            gc.collect()
            self.torch.cuda.empty_cache()

    def _configure_runner_devices(self, cache):
        runner = self.runner
        block_device = "cpu" if self.blocks_to_swap else "cuda:0"
        configured_offload = str(getattr(runner, "_dit_offload_device", None))
        # Pinned numz commit4490bd1 validates BlockSwap against the context,
        # then uses this separate field for materialization and cleanup.
        # Every cached prepare rewrites it, so restore CUDA on every return.
        runner._dit_offload_device = self.torch.device("cuda:0")
        config = getattr(runner, "_dit_block_swap_config", None)
        if (not isinstance(config, dict)
                or config.get("blocks_to_swap") != self.blocks_to_swap
                or config.get("swap_io_components") is not False
                or str(config.get("offload_device")) != block_device):
            raise RuntimeError("AI 모델의 블록 실행 구성이 예상과 다릅니다.")
        if (configured_offload != block_device
                or str(runner._vae_offload_device) != "cpu"
                or runner._compute_dtype != self.context["compute_dtype"]):
            raise RuntimeError("AI 모델의 장치 실행 구성이 예상과 다릅니다.")
        if (not cache.get("dit_cache") or not cache.get("vae_cache")
                or cache.get("dit_model") != MODEL_NAME or cache.get("vae_model") != VAE_NAME):
            raise RuntimeError("AI 모델의 캐시 구성이 예상과 다릅니다.")
        model = getattr(runner.dit, "dit_model", runner.dit)
        if len(model.blocks) != 32 or runner._dit_attention_mode != "sdpa":
            raise RuntimeError("AI 모델의 구조가 예상과 다릅니다.")
        cached = cache.get("cached_dit") is not None
        expected_dtype = self.torch.float16 if cached else self.torch.float32
        # Persistent RoPE frequencies are part of the pinned checkpoint too.
        for name, tensor in model.state_dict().items():
            expected_device = "meta"
            if cached:
                block = int(name.split(".")[1]) if name.startswith("blocks.") else None
                expected_device = "cpu" if block is not None and block < self.blocks_to_swap else "cuda"
            if tensor.dtype != expected_dtype or tensor.device.type != expected_device:
                raise RuntimeError("AI 모델의 정밀도 또는 메모리 배치가 예상과 다릅니다.")

    def _infer(self, raw, frame_count, seed):
        torch = self.torch
        array = self.np.frombuffer(raw, dtype=self.np.uint8).reshape(frame_count, self.config["height"], self.config["width"], 3)
        images = torch.from_numpy(array[..., ::-1].copy()).to(dtype=torch.float32).div_(255)
        block_device = "cpu" if self.blocks_to_swap else "cuda:0"
        ctx = self.utils.setup_generation_context("cuda:0", "cuda:0", block_device, "cpu", "cpu", self.debug)
        ctx["interrupt_fn"] = self.lifetime.check
        self.context = ctx
        self.runner, cache = self.utils.prepare_runner(
            dit_model=MODEL_NAME, vae_model=VAE_NAME, model_dir=str(self.runtime / "models"),
            debug=self.debug, ctx=ctx, dit_cache=True, vae_cache=True,
            dit_id="slu_enhancement_dit", vae_id="slu_enhancement_vae",
            block_swap_config={"blocks_to_swap": self.blocks_to_swap, "swap_io_components": False, "offload_device": torch.device(block_device)},
            encode_tiled=True, encode_tile_size=(self.tile_size, self.tile_size), encode_tile_overlap=(64, 64),
            decode_tiled=True, decode_tile_size=(self.tile_size, self.tile_size), decode_tile_overlap=(64, 64),
            tile_debug="false", attention_mode="sdpa",
        )
        self._configure_runner_devices(cache)
        ctx["cache_context"] = cache
        ctx["text_embeds"] = self.utils.load_text_embeddings(str(self.runtime / "upstream"), ctx["dit_device"], ctx["compute_dtype"], self.debug)
        resolution = min(self.config["width"], self.config["height"]) * self.config["scale"]
        batch_size = self.config["chunkFrames"]
        images, info = self.utils.compute_generation_info(ctx, images, resolution, 0, batch_size, False, seed, 0, 0, self.debug)
        if (info["true_w"], info["true_h"]) != (self.config["width"] * self.config["scale"], self.config["height"] * self.config["scale"]):
            raise RuntimeError("The model transform changed the requested frame dimensions")
        with torch.inference_mode():
            ctx = self.phases.encode_all_batches(self.runner, ctx, images, self.debug, batch_size=batch_size,
                seed=seed, progress_callback=self._progress, temporal_overlap=0, resolution=resolution,
                max_resolution=0, input_noise_scale=0.0, color_correction="wavelet")
            ctx = self.phases.upscale_all_batches(self.runner, ctx, self.debug, self._progress, seed=seed,
                latent_noise_scale=0.0, cache_model=True)
            ctx = self.phases.decode_all_batches(self.runner, ctx, self.debug, self._progress, cache_model=True)
            ctx = self.phases.postprocess_all_batches(ctx, self.debug, self._progress, color_correction="wavelet",
                prepend_frames=0, temporal_overlap=0, batch_size=batch_size)
        result = ctx.pop("final_video").to(device="cpu", dtype=torch.float16)
        self.context = None
        if tuple(result.shape) != (frame_count, self.config["height"] * self.config["scale"], self.config["width"] * self.config["scale"], 3):
            raise RuntimeError("The model returned an unexpected frame count or dimensions")
        return result

    def _infer_with_retry(self, raw, frame_count, seed):
        self._check_resources()
        try:
            return self._infer(raw, frame_count, seed)
        except self.torch.cuda.OutOfMemoryError:
            self._release()
            if self.tile_size == 256:
                raise
        self._check_resources()
        # Retry the same model input and seed before publishing any output.
        # A smaller VAE tile changes memory use without dropping or reordering frames.
        self.tile_size = 256
        send({"type": "progress", "progress": 0, "message": "GPU 메모리에 맞춰 작은 타일로 다시 처리합니다."})
        return self._infer(raw, frame_count, seed)

    def infer(self, raw, frame_count, seed):
        frame_bytes = self.config["width"] * self.config["height"] * 3
        integer(frame_count, "inference frame count", 1, self.config["chunkFrames"])
        overlap = len(self.frame_cache)
        if (len(raw) != frame_count * frame_bytes or seed != self.config["seed"]
                or overlap > 4 or frame_count <= overlap):
            raise ValueError("Invalid independent-frame inference window")
        first = self.next_unique_frame - overlap
        identities = []
        for offset in range(frame_count):
            self.lifetime.check()
            start = offset * frame_bytes
            identities.append(hashlib.sha256(raw[start:start + frame_bytes]).hexdigest())
        # Check every reused input before any new native work. Equal pixels at
        # different source indices are different frames, not deduplication keys.
        for offset, (index, digest, _) in enumerate(self.frame_cache):
            if index != first + offset or digest != identities[offset]:
                raise RuntimeError("Retained enhancement source frame changed")
        self._check_resources()
        output = self.torch.empty((frame_count, self.config["height"] * self.config["scale"],
            self.config["width"] * self.config["scale"], 3), dtype=self.torch.float16, device="cpu")
        retained = []
        for offset in range(frame_count):
            self.lifetime.check()
            if offset < overlap:
                prediction = self.frame_cache[offset][2]
            else:
                start = offset * frame_bytes
                prediction = self._infer_with_retry(raw[start:start + frame_bytes], 1, seed)[0]
                self.lifetime.check()
            # Copy into the response: EnhancementJob's overlap blend may mutate
            # it, while the cached prediction must remain the exact same frame.
            output[offset] = prediction
            if offset >= frame_count - 4:
                retained.append((first + offset, identities[offset], prediction))
        # Publish cache state only after the complete window succeeds. GPU-model
        # _release() is also used by OOM retry and must not clear this CPU cache.
        self.frame_cache = retained
        self.next_unique_frame = first + frame_count
        return output

    def blend(self, previous, current, count):
        return self.utils.blend_overlapping_frames(previous, current, count)

    def copy_tail(self, frames, count):
        return frames[-count:].clone() if count else None

    def bgra_frames(self, frames, count):
        for index in range(count):
            self.lifetime.check()
            frame = frames[index].float()
            if not self.torch.isfinite(frame).all().item():
                raise RuntimeError("The model returned non-finite pixels")
            rgb = frame.clamp_(0, 1).mul_(255).round_().to(self.torch.uint8).numpy()
            bgra = self.np.empty((*rgb.shape[:2], 4), dtype=self.np.uint8)
            bgra[..., :3] = rgb[..., ::-1]
            bgra[..., 3] = 255
            yield bgra.tobytes()

    def close(self):
        self.frame_cache = []
        self.next_unique_frame = 0
        try:
            self._release()
        finally:
            if self.model_loader.load_safetensors_file is self.loader_hook:
                self.model_loader.load_safetensors_file = self.original_model_loader


class EnhancementJob:
    def __init__(self, runtime, job_directory, lifetime, backend_factory=SeedVRBackend):
        self.runtime = runtime
        self.directory = job_directory
        self.lifetime = lifetime
        self.backend_factory = backend_factory
        self.backend = None
        self.config = None
        self.next_input = 0
        self.next_output = 0
        self.input_bytes = 0
        self.last_pts = None
        self.pending_raw = b""
        self.pending_pts = []
        self.pending_output = None
        self.complete = False

    def initialize(self, config):
        if self.config is not None or not isinstance(config, dict):
            raise ValueError("Invalid initialization state")
        if integer(config.get("protocolVersion"), "protocolVersion", 1, 1) != PROTOCOL_VERSION:
            raise ValueError("Unsupported enhancement protocol")
        width = integer(config.get("width"), "width", 1, MAXIMUM_DIMENSION)
        height = integer(config.get("height"), "height", 1, MAXIMUM_DIMENSION)
        scale = integer(config.get("scale"), "scale", 2, 4)
        if scale not in (2, 4) or max(width, height) * scale > MAXIMUM_DIMENSION or width * height * scale ** 2 > MAXIMUM_PIXELS:
            raise ValueError("Requested output dimensions exceed the supported limits")
        chunk = integer(config.get("chunkFrames"), "chunkFrames", 9, 13)
        if chunk not in (9, 13) or config.get("overlapFrames") != 4:
            raise ValueError("Unsupported temporal window configuration")
        integer(config.get("seed"), "seed", 0, 2147483647)
        maximum_frames = integer(config.get("maximumFrames"), "maximumFrames", 1, 999999999)
        maximum_bytes = integer(config.get("maximumBytes"), "maximumBytes", width * height * 3)
        if maximum_bytes < maximum_frames * width * height * 3:
            raise ValueError("Input byte budget is smaller than the declared frame budget")
        self.config = dict(config)
        self.capacity = chunk - 4
        self.frame_bytes = width * height * 3
        self.output_width = width * scale
        self.output_height = height * scale
        self.backend = self.backend_factory(self.runtime, self.config, self.lifetime, self.directory)
        return {"protocolVersion": PROTOCOL_VERSION, "backend": "cuda", "model": "seedvr2-3b-fp16",
                "inputCapacity": self.capacity, "chunkFrames": chunk, "overlapFrames": 4,
                "outputWidth": self.output_width, "outputHeight": self.output_height,
                "hardware": getattr(self.backend, "hardware", {})}

    def process(self, request):
        if self.backend is None or self.complete:
            raise ValueError("No active enhancement job")
        self.lifetime.check()
        first = integer(request.get("firstFrame"), "firstFrame")
        count = integer(request.get("frameCount"), "frameCount", 0, self.capacity)
        last = request.get("last")
        if type(last) is not bool or first != self.next_input or (not last and count != self.capacity):
            raise ValueError("Input chunks must be contiguous and respect inputCapacity")
        if count == 0 and (not last or not self.pending_pts or request.get("inputFile") is not None):
            raise ValueError("Invalid empty final flush")
        pts = request.get("pts")
        if not isinstance(pts, list) or len(pts) != count:
            raise ValueError("One timestamp is required for every input frame")
        previous = self.last_pts
        for timestamp in pts:
            integer(timestamp, "timestamp", -SAFE_INTEGER, SAFE_INTEGER)
            if previous is not None and timestamp <= previous:
                raise ValueError("Frame timestamps must be strictly increasing")
            previous = timestamp
        byte_count = count * self.frame_bytes
        if first + count > self.config["maximumFrames"] or self.input_bytes + byte_count > self.config["maximumBytes"]:
            raise ValueError("Input exceeds the declared job limits")
        if count:
            filename = f"input-{first:09d}.bgr"
            if request.get("inputFile") != filename:
                raise ValueError("Unexpected input file name")
            input_path, initial = regular_file(self.directory, filename, byte_count)
            with input_path.open("rb") as source:
                raw = source.read(byte_count + 1)
            final = input_path.stat()
            if len(raw) != byte_count or (initial.st_ino, initial.st_mtime_ns, initial.st_size) != (final.st_ino, final.st_mtime_ns, final.st_size):
                raise RuntimeError("Input changed while reading")
            window_raw = self.pending_raw + raw
            window_pts = self.pending_pts + pts
            output = self.backend.infer(window_raw, len(window_pts), self.config["seed"])
            overlap = len(self.pending_pts)
            if overlap:
                output[:overlap] = self.backend.blend(self.pending_output, output[:overlap], overlap)
        else:
            window_raw = self.pending_raw
            window_pts = self.pending_pts
            output = self.pending_output
        committed = len(window_pts) if last else max(0, len(window_pts) - self.config["overlapFrames"])
        result = self._write_output(output, committed, window_pts[:committed], last)
        retained = len(window_pts) - committed
        self.pending_output = self.backend.copy_tail(output, retained)
        self.pending_raw = window_raw[-retained * self.frame_bytes:] if retained else b""
        self.pending_pts = window_pts[committed:]
        self.next_input += count
        self.next_output += committed
        self.input_bytes += byte_count
        self.last_pts = previous
        self.complete = last
        if last and self.next_input != self.next_output:
            raise RuntimeError("Final output frame count does not match the input")
        return result

    def _write_output(self, output, count, pts, last):
        result = {"outputFirstFrame": self.next_output, "frameCount": count, "pts": pts,
                  "outputFile": None, "bytes": 0, "sha256": None, "width": self.output_width,
                  "height": self.output_height, "complete": last}
        if count == 0:
            return result
        filename = f"output-{self.next_output:09d}.bgra"
        destination = self.directory / filename
        partial = destination.with_suffix(".bgra.partial")
        if destination.exists() or partial.exists():
            raise ValueError("Output path already exists")
        digest = hashlib.sha256()
        written = 0
        try:
            with partial.open("xb") as target:
                for data in self.backend.bgra_frames(output, count):
                    self.lifetime.check()
                    target.write(data)
                    digest.update(data)
                    written += len(data)
                target.flush()
                os.fsync(target.fileno())
            if written != count * self.output_width * self.output_height * 4:
                raise RuntimeError("Output byte count is incorrect")
            self.lifetime.check()
            partial.rename(destination)
        except BaseException:
            partial.unlink(missing_ok=True)
            raise
        result.update(outputFile=filename, bytes=written, sha256=digest.hexdigest())
        return result

    def close(self):
        self.pending_raw = b""
        self.pending_output = None
        if self.backend is not None:
            self.backend.close()
            self.backend = None


def read_requests(messages, lifetime):
    pending = b""
    try:
        while True:
            # Avoid holding BufferedReader's lock on a daemon thread. Otherwise
            # CPython can abort during shutdown while the parent keeps stdin open.
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                lifetime.eof()
                messages.put(None)
                return
            pending += data
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                if len(line) > 1024 * 1024:
                    raise ValueError("Enhancement request exceeds the protocol limit")
                messages.put(json.loads(line.decode("utf-8")))
            if len(pending) > 1024 * 1024:
                raise ValueError("Enhancement request exceeds the protocol limit")
    except BaseException as error:
        lifetime.eof()
        messages.put(error)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--job-dir", required=True)
    parser.add_argument("--parent-pid", type=int, required=True)
    arguments = parser.parse_args()
    runtime = local_directory(arguments.runtime_root)
    directory = local_directory(arguments.job_dir)
    if runtime == directory or runtime in directory.parents or directory in runtime.parents:
        raise ValueError("Runtime and job directories must be separate")
    lifetime = Lifetime(arguments.parent_pid)
    lifetime.kernel.SetErrorMode(0x0001 | 0x0002 | 0x8000)
    faulthandler.enable(file=sys.stderr)
    # NumPy's Windows libgfortran initialization inspects stdin. A simultaneous
    # blocking pipe read can deadlock its DLL loader (numpy/numpy issue 24290).
    # Import it before the EOF reader, which remains active during inference.
    os.environ["OPENBLAS_NUM_THREADS"] = "1"
    os.environ["OMP_NUM_THREADS"] = "2"
    with contextlib.redirect_stdout(sys.stderr):
        site.addsitedir(str(local_directory(runtime / "vendor")))
        send({"type": "progress", "progress": 0, "message": "AI 수치 연산 준비"})
        import numpy
    messages = queue.Queue(maxsize=2)
    reader = threading.Thread(target=read_requests, args=(messages, lifetime), daemon=True)
    reader.start()
    job = EnhancementJob(runtime, directory, lifetime)
    exit_code = 0
    try:
        with contextlib.redirect_stdout(sys.stderr):
            while True:
                request = messages.get()
                if request is None:
                    break
                if isinstance(request, BaseException):
                    raise request
                identifier = request.get("id") if isinstance(request, dict) else None
                try:
                    integer(identifier, "request ID", 1)
                    method = request.get("method")
                    if method == "init":
                        result = job.initialize(request.get("config"))
                    elif method == "process":
                        result = job.process(request)
                    elif method == "close":
                        job.close()
                        send({"id": identifier, "result": {"closed": True}})
                        break
                    else:
                        raise ValueError("Unknown enhancement request")
                    send({"id": identifier, "result": result})
                except Exception as error:
                    send({"id": identifier, "error": protocol_error(error)})
                    exit_code = 1
                    break
    finally:
        with contextlib.redirect_stdout(sys.stderr):
            job.close()
        lifetime.close()
    return exit_code


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8", newline="\n", write_through=True)
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", write_through=True)
    try:
        sys.exit(main())
    except Exception as failure:
        print(str(failure), file=sys.stderr, flush=True)
        sys.exit(1)
