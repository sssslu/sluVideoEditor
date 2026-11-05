"""Extract the actual shipped adapter nodes for native boundary-value tests.

Build-only dependency: scripts/matting-build-requirements.txt. This fixture
contains no RVM network and is never an application resource.
"""
from pathlib import Path
import hashlib
import sys
import onnx
from onnx import helper as h, TensorProto as T

root = Path(__file__).resolve().parent.parent
source = root / 'resources/models/person-matting-rvm-bgr.onnx'
assert hashlib.sha256(source.read_bytes()).hexdigest() == '5292c6ccbfe2fdf9a2280532885605dfb3553b6b261cae4d63d3e47c7ddd49c1'
model = onnx.load(source)
target = Path(sys.argv[1])
nodes = [node for node in model.graph.node if node.name.startswith('slu_')]
graph = h.make_graph(nodes, 'actual-slu-adapter', [
    h.make_tensor_value_info('src_bgr', T.UINT8, [1, 16, 256, 3]),
    h.make_tensor_value_info('fgr', T.FLOAT, [1, 3, 16, 256]),
    h.make_tensor_value_info('pha', T.FLOAT, [1, 1, 16, 256]),
], [
    h.make_tensor_value_info('src', T.FLOAT, [1, 3, 16, 256]),
    h.make_tensor_value_info('frame_bgra', T.UINT8, [1, 16, 256, 4]),
    h.make_tensor_value_info('invalid_pixels', T.INT32, []),
], [i for i in model.graph.initializer if i.name.startswith('slu_')])
extracted = h.make_model(graph, opset_imports=list(model.opset_import), ir_version=model.ir_version)
onnx.checker.check_model(extracted)
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(extracted.SerializeToString(deterministic=True))

