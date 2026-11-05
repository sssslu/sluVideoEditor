"""Load pinned FP16 models without a whole-file Windows copy-on-write mapping."""
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import struct

MAXIMUM_HEADER_BYTES = 1024 * 1024
MAXIMUM_TENSOR_BYTES = 75 * 1024 * 1024

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate safetensors header key")
        result[key] = value
    return result

def revision(info):
    return info.st_size, info.st_mtime_ns, info.st_ino

def read_exact(source, length):
    data = source.read(length)
    if len(data) != length:
        raise ValueError("Truncated safetensors file")
    return data

def read_header(source, expected_bytes):
    length = struct.unpack("<Q", read_exact(source, 8))[0]
    if not 2 <= length <= MAXIMUM_HEADER_BYTES or length + 8 > expected_bytes:
        raise ValueError("Invalid safetensors header length")
    header = json.loads(read_exact(source, length).decode("utf-8"), object_pairs_hook=unique_object)
    if not isinstance(header, dict) or not 1 <= len(header) <= 1024:
        raise ValueError("Invalid safetensors tensor count")
    entries = []
    for name, entry in header.items():
        if not isinstance(name, str) or not name or name == "__metadata__" or not isinstance(entry, dict):
            raise ValueError("Only named pinned FP16 tensors are accepted")
        if set(entry) != {"dtype", "shape", "data_offsets"} or entry["dtype"] != "F16":
            raise ValueError("Only exact FP16 tensor entries are accepted")
        shape = entry["shape"]
        if not isinstance(shape, list) or not 1 <= len(shape) <= 8 or any(type(size) is not int or not 1 <= size <= MAXIMUM_TENSOR_BYTES // 2 for size in shape):
            raise ValueError("Invalid tensor shape")
        offsets = entry["data_offsets"]
        if not isinstance(offsets, list) or len(offsets) != 2 or any(type(offset) is not int or offset < 0 for offset in offsets):
            raise ValueError("Invalid tensor offsets")
        size = math.prod(shape) * 2
        if not 1 <= size <= MAXIMUM_TENSOR_BYTES or offsets[1] - offsets[0] != size:
            raise ValueError("Tensor shape and byte count disagree")
        entries.append((offsets[0], offsets[1], name, entry))
    entries.sort(key=lambda entry: entry[0])
    position = 0
    for start, end, name, entry in entries:
        if start != position:
            raise ValueError("Overlapping or non-contiguous tensor offsets")
        position = end
    if position != expected_bytes - length - 8:
        raise ValueError("Tensor payload does not exactly cover the file")
    return length + 8, entries

def load_fp16_file(filename, device, torch, expected_sha256, expected_bytes, cancel, verify_transfer=False, report=None):
    from safetensors.torch import load
    if not isinstance(expected_sha256, str) or re.fullmatch("[0-9a-f]{64}", expected_sha256) is None:
        raise ValueError("A pinned SHA256 is required")
    if type(expected_bytes) is not int or expected_bytes < 10:
        raise ValueError("A pinned file size is required")
    filename = Path(filename)
    initial = filename.lstat()
    if not stat.S_ISREG(initial.st_mode) or getattr(initial, "st_file_attributes", 0) & 0x400 or initial.st_size != expected_bytes:
        raise ValueError("Pinned source must be a regular file with the exact size")
    state = {}
    cpu_tensor = tensor = readback = raw = encoded = None
    try:
        with filename.open("rb") as source:
            if revision(os.fstat(source.fileno())) != revision(initial):
                raise RuntimeError("Source changed before opening")
            digest = hashlib.sha256()
            while True:
                cancel()
                block = source.read(4 * 1024 * 1024)
                if not block:
                    break
                digest.update(block)
            if digest.hexdigest() != expected_sha256:
                raise ValueError("Pinned model SHA256 mismatch")
            source.seek(0)
            payload_offset, entries = read_header(source, expected_bytes)
            for start, end, name, entry in entries:
                cancel()
                source.seek(payload_offset + start)
                raw = read_exact(source, end - start)
                expected_tensor_hash = hashlib.sha256(raw).hexdigest() if verify_transfer else None
                single = {name: {"dtype": "F16", "shape": entry["shape"], "data_offsets": [0, len(raw)]}}
                header = json.dumps(single, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
                header += b" " * (-len(header) % 8)
                encoded = struct.pack("<Q", len(header)) + header + raw
                # Reuse the official parser and dtype/shape interpretation. No
                # whole-file mapping is created by its in-memory load() API.
                cpu_tensor = load(encoded)[name]
                if cpu_tensor.dtype != torch.float16 or list(cpu_tensor.shape) != entry["shape"]:
                    raise RuntimeError("Official parser returned unexpected tensor metadata")
                tensor = cpu_tensor.to(device=device, non_blocking=False)
                cpu_tensor = encoded = raw = None
                cancel()
                actual_hash = None
                if verify_transfer:
                    readback = tensor.detach().to(device="cpu", non_blocking=False).contiguous()
                    actual_hash = hashlib.sha256(memoryview(readback.numpy()).cast("B")).hexdigest()
                    if actual_hash != expected_tensor_hash:
                        raise RuntimeError("Tensor bytes changed during device transfer")
                if report is not None:
                    report({"name": name, "shape": entry["shape"], "dtype": "F16", "bytes": end - start,
                            "sourceSha256": expected_tensor_hash, "readbackSha256": actual_hash, "device": str(tensor.device)})
                state[name] = tensor
                tensor = readback = None
            if revision(os.fstat(source.fileno())) != revision(initial) or revision(filename.stat()) != revision(initial):
                raise RuntimeError("Source changed while loading tensors")
        return state
    except BaseException:
        state.clear()
        cpu_tensor = tensor = readback = raw = encoded = None
        gc.collect()
        raise
