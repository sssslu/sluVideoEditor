"""Add lossless byte input/output adapters to the pinned RVM ONNX graph.

Build-only environment: Python 3.9-3.12, onnx==1.17.0, numpy==2.0.2,
protobuf==5.29.5. The application needs no Python. Upstream weights and recurrent
network are unchanged. The additional operations run in the selected ORT EP.
"""
from pathlib import Path
import argparse
import hashlib
import numpy as np
import onnx
from onnx import helper as h, TensorProto as T, numpy_helper as nh

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('target', nargs='?', type=Path)
parser.add_argument('--variant', choices=('mobilenetv3', 'resnet50'), default='mobilenetv3')
args = parser.parse_args()
variants = {
    'mobilenetv3': ('person-matting-rvm', 'MobileNetV3', '88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828'),
    'resnet50': ('person-matting-rvm-resnet50', 'ResNet50', '25db300fcb6ee27f941a1b52c97856e8d1f13c7f35817f81a612f89af0e8a85c'),
}
basename, label, source_sha = variants[args.variant]
source = root / 'resources/models' / (basename + '.onnx')
target = args.target or root / 'resources/models' / (basename + '-bgr.onnx')
assert onnx.__version__ == '1.17.0' and np.__version__ == '2.0.2'
assert hashlib.sha256(source.read_bytes()).hexdigest() == source_sha
model = onnx.load(source)
assert model.ir_version == 6 and [(o.domain, o.version) for o in model.opset_import] == [('', 12)]
assert not any(n.name.startswith('slu_') for n in model.graph.node)

nodes = []
def node(op, inputs, output, **attrs):
    nodes.append(h.make_node(op, inputs, [output], name='slu_' + output, **attrs))

def constant(name, data, dtype):
    model.graph.initializer.append(nh.from_array(np.asarray(data, dtype=dtype), name))

constant('slu_rgb_order', [2, 1, 0], np.int64)
constant('slu_bgra_order', [2, 1, 0, 3], np.int64)
# Lookup rather than reciprocal multiplication keeps the exact Float32 value
# of each normalized input byte identical across CPU and GPU implementations.
constant('slu_normalized_byte', [n / 255 for n in range(256)], np.float32)
constant('slu_zero', 0, np.float32)
constant('slu_one', 1, np.float32)
constant('slu_half', .5, np.float32)
constant('slu_255', 255, np.float32)

# FP32 multiply/add can round a value just below a byte boundary up to it.
# Correct that candidate against the least Float32 value whose EXACT product
# with 255 rounds to the candidate byte. This reproduces the CPU byte mapping,
# including 0.5 -> 128, without moving full Float32 frames across the bus.
thresholds = [np.float32(0)]
for n in range(1, 256):
    exact = (n - .5) / 255
    value = np.float32(exact)
    if float(value) < exact:
        value = np.nextafter(value, np.float32(np.inf))
    thresholds.append(value)
constant('slu_byte_threshold', thresholds, np.float32)

node('Gather', ['src_bgr', 'slu_rgb_order'], 'slu_rgb_bytes', axis=3)
node('Transpose', ['slu_rgb_bytes'], 'slu_rgb_planar', perm=[0, 3, 1, 2])
node('Cast', ['slu_rgb_planar'], 'slu_rgb_indices', to=T.INT32)
node('Gather', ['slu_normalized_byte', 'slu_rgb_indices'], 'src', axis=0)
before = list(nodes)
nodes.clear()

node('Concat', ['fgr', 'pha'], 'slu_rgba', axis=1)
node('IsNaN', ['slu_rgba'], 'slu_nan')
node('IsInf', ['slu_rgba'], 'slu_inf')
node('Or', ['slu_nan', 'slu_inf'], 'slu_nonfinite')
node('Cast', ['slu_nonfinite'], 'slu_invalid_int', to=T.INT32)
node('ReduceMax', ['slu_invalid_int'], 'invalid_pixels', axes=[0, 1, 2, 3], keepdims=0)
node('Gather', ['slu_rgba', 'slu_bgra_order'], 'slu_bgra_planar', axis=1)
node('Transpose', ['slu_bgra_planar'], 'slu_bgra_hwc', perm=[0, 2, 3, 1])
node('Clip', ['slu_bgra_hwc', 'slu_zero', 'slu_one'], 'slu_clamped')
node('Mul', ['slu_clamped', 'slu_255'], 'slu_scaled')
node('Add', ['slu_scaled', 'slu_half'], 'slu_rounded')
node('Cast', ['slu_rounded'], 'slu_candidate', to=T.INT32)
node('Gather', ['slu_byte_threshold', 'slu_candidate'], 'slu_threshold', axis=0)
node('Less', ['slu_clamped', 'slu_threshold'], 'slu_correct_down')
node('Cast', ['slu_correct_down'], 'slu_correct_int', to=T.INT32)
node('Sub', ['slu_candidate', 'slu_correct_int'], 'slu_exact_byte')
node('Cast', ['slu_exact_byte'], 'frame_bgra', to=T.UINT8)

original_nodes = list(model.graph.node)
original_inputs = [i for i in model.graph.input if i.name != 'src']
state_outputs = [o for o in model.graph.output if o.name not in ('fgr', 'pha')]
del model.graph.node[:]
model.graph.node.extend(before + original_nodes + nodes)
del model.graph.input[:]
model.graph.input.extend([h.make_tensor_value_info('src_bgr', T.UINT8, [1, 'height', 'width', 3])] + original_inputs)
del model.graph.output[:]
model.graph.output.extend([h.make_tensor_value_info('frame_bgra', T.UINT8, [1, 'height', 'width', 4]), h.make_tensor_value_info('invalid_pixels', T.INT32, [])] + state_outputs)
model.doc_string = f'SLU byte-input/BGRA-output adapter v1. RVM v1.0.0 {label} FP32 weights unchanged. GPL-3.0. See scripts/build-matting-model.py and RVM-provenance.json.'
onnx.checker.check_model(model)
target.parent.mkdir(parents=True, exist_ok=True)
data = model.SerializeToString(deterministic=True)
target.write_bytes(data)
print({'path': str(target), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
