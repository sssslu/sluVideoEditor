import hashlib
import gc
import weakref
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("loader", Path(__file__).with_name("tensor_loader.py"))
loader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)
import torch
from safetensors.torch import save_file, load_file

def container(header, data=b"\0\0\0\0"):
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    encoded += b" " * (-len(encoded) % 8)
    return struct.pack("<Q", len(encoded)) + encoded + data

class LoaderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="slu-tensor-", dir=Path(__file__).resolve().parents[2] / ".test-artifacts")
        self.file = Path(self.directory.name) / "fixture.safetensors"
        self.original = {"one": torch.tensor([0, -32768, 15360, 31744, -1024, 32257, 1, 32767], dtype=torch.int16).view(torch.float16).reshape(2, 4), "two": torch.tensor([[1.25, -2.5, 0.0001]], dtype=torch.float16)}
        save_file(self.original, self.file)
        self.size = self.file.stat().st_size
        self.sha = hashlib.sha256(self.file.read_bytes()).hexdigest()
    def tearDown(self):
        self.directory.cleanup()
    def load(self, **kwargs):
        return loader.load_fp16_file(self.file, "cpu", torch, kwargs.pop("expected_sha256", self.sha), kwargs.pop("expected_bytes", self.size), kwargs.pop("cancel", lambda: None), verify_transfer=kwargs.pop("verify_transfer", True), **kwargs)
    def test_cpu_exact_bits_and_official_equivalence(self):
        records = []
        actual = self.load(report=records.append)
        official = load_file(self.file)
        self.assertEqual(set(actual), set(official))
        for name in actual:
            self.assertEqual(actual[name].dtype, torch.float16)
            self.assertEqual(actual[name].shape, official[name].shape)
            self.assertEqual(actual[name].view(torch.int16).tolist(), official[name].view(torch.int16).tolist())
        self.assertEqual(len(records), 2)
        self.assertTrue(all(row["sourceSha256"] == row["readbackSha256"] for row in records))
    def test_production_transfer_skips_readback_and_preserves_bits(self):
        records = []
        actual = self.load(verify_transfer=False, report=records.append)
        for name in actual:
            self.assertEqual(actual[name].view(torch.int16).tolist(), self.original[name].view(torch.int16).tolist())
        self.assertTrue(all(row["sourceSha256"] is None and row["readbackSha256"] is None for row in records))

    def test_wrong_hash(self):
        with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
            self.load(expected_sha256="0" * 64)
    def test_wrong_size(self):
        with self.assertRaisesRegex(ValueError, "exact size"):
            self.load(expected_bytes=self.size + 1)
    def test_cancel_before_transfer(self):
        def cancel():
            raise InterruptedError("stop")
        with self.assertRaises(InterruptedError):
            self.load(cancel=cancel)
    def test_cancel_after_transfer_releases_partial_tensors(self):
        import safetensors.torch
        original_load = safetensors.torch.load
        references = []
        records = []
        def tracked_load(data):
            tensors = original_load(data)
            references.extend(weakref.ref(tensor) for tensor in tensors.values())
            return tensors
        def cancel():
            if records:
                raise InterruptedError("stop after first tensor")
        with patch.object(safetensors.torch, "load", side_effect=tracked_load):
            with self.assertRaises(InterruptedError):
                self.load(cancel=cancel, report=records.append)
        gc.collect()
        self.assertEqual(len(records), 1)
        self.assertTrue(references)
        self.assertTrue(all(reference() is None for reference in references))

    def test_revision_change_rejected(self):
        changed = False
        def mutate(record):
            nonlocal changed
            if not changed:
                previous = self.file.stat()
                os.utime(self.file, ns=(previous.st_atime_ns, previous.st_mtime_ns + 10000000))
                changed = True
        with self.assertRaisesRegex(RuntimeError, "Source changed"):
            self.load(report=mutate)
    def test_header_rejections(self):
        valid = {"dtype": "F16", "shape": [2], "data_offsets": [0, 4]}
        invalid = [
            {"a": {**valid, "dtype": "F32"}},
            {"a": {**valid, "shape": [True, 2]}},
            {"a": {**valid, "shape": [0]}},
            {"a": {**valid, "shape": []}},
            {"a": {**valid, "shape": [3]}},
            {"a": {**valid, "shape": [loader.MAXIMUM_TENSOR_BYTES]}},
            {"a": {**valid, "data_offsets": [-1, 3]}},
            {"a": {**valid, "data_offsets": [1, 5]}},
            {"a": {**valid, "data_offsets": [False, 4]}},
            {"a": {**valid, "extra": 1}},
            {"a": valid, "b": valid},
            {"a": valid, "__metadata__": {}},
            {}, [],
        ]
        for header in invalid:
            with self.subTest(header=header), self.assertRaises(ValueError):
                data = container(header)
                loader.read_header(io.BytesIO(data), len(data))
    def test_duplicate_keys_rejected(self):
        raw = b'{"a":{"dtype":"F16","shape":[2],"data_offsets":[0,4]},"a":{"dtype":"F16","shape":[2],"data_offsets":[0,4]}}'
        data = struct.pack("<Q", len(raw)) + raw + b"\0" * 4
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            loader.read_header(io.BytesIO(data), len(data))
    def test_truncated_and_oversized_header(self):
        for data in (b"\0" * 7, struct.pack("<Q", loader.MAXIMUM_HEADER_BYTES + 1), struct.pack("<Q", 20) + b"{}"):
            with self.subTest(data=data), self.assertRaises(ValueError):
                loader.read_header(io.BytesIO(data), len(data))
    def test_valid_header_and_trailing_payload_rejected(self):
        data = container({"a": {"dtype": "F16", "shape": [2], "data_offsets": [0, 4]}})
        offset, entries = loader.read_header(io.BytesIO(data), len(data))
        self.assertEqual(entries[0][:3], (0, 4, "a"))
        self.assertEqual(len(data) - offset, 4)
        with self.assertRaisesRegex(ValueError, "exactly cover"):
            loader.read_header(io.BytesIO(data + b"\0"), len(data) + 1)

if __name__ == "__main__":
    torch.set_num_threads(2)
    unittest.main(verbosity=2)
