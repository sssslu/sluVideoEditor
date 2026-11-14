import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessEnhancementHardware,enhancementRequirements,parseEnhancementGPU,validateEnhancementRequest} from '../electron/enhancement-hardware';

const GIB=1024**3;
const machine={gpuName:'RTX 4080 SUPER',gpuUuid:'GPU-11111111-2222-3333-4444-555555555555',vramTotal:16*GIB,vramAvailable:14*GIB,ramTotal:32*GIB,ramAvailable:24*GIB,commitAvailable:64*GIB};
const request={width:960,height:540,scale:2 as const};

test('supported hardware exposes the actual input and output resource budget',()=>{
  const result=assessEnhancementHardware(request,machine);
  assert.equal(result.canRun,true);assert.equal(result.deviceSupported,true);
  assert.equal(result.vramBudgetBytes,Math.floor(16*GIB*.6));
  assert.equal(result.requiredVramBytes,enhancementRequirements(request,result.vramBudgetBytes!).vram);
});
test('8 and 12 GiB GPUs are blocked before model initialization',()=>{
  for(const capacity of [8,12]){
    const result=assessEnhancementHardware(request,{...machine,vramTotal:capacity*GIB,vramAvailable:capacity*GIB});
    assert.equal(result.deviceSupported,false);assert.equal(result.canRun,false);assert.match(result.message!,/GPU 메모리 부족/);
  }
});
test('another GPU task blocks inference without declaring the device permanently unsupported',()=>{
  const result=assessEnhancementHardware(request,{...machine,vramAvailable:6*GIB});
  assert.equal(result.deviceSupported,true);assert.equal(result.canRun,false);assert.match(result.message!,/GPU 메모리 부족/);
});
test('physical and commit memory shortages each block and show required and available values',()=>{
  assert.match(assessEnhancementHardware(request,{...machine,ramAvailable:2*GIB}).message!,/RAM 부족/);
  const commit=assessEnhancementHardware(request,{...machine,commitAvailable:2*GIB});
  assert.equal(commit.canRun,false);assert.match(commit.message!,/Windows 메모리 여유 부족/);
});
test('the selected output size changes the memory budget',()=>{
  const small=assessEnhancementHardware(request,{...machine,ramAvailable:9*GIB});
  const large=assessEnhancementHardware({...request,scale:4},{...machine,ramAvailable:9*GIB});
  assert.equal(small.canRun,true);assert.equal(large.canRun,false);assert.ok(large.requiredRamBytes!>small.requiredRamBytes!);
});
test('invalid geometry and unavailable GPU telemetry fail closed',()=>{
  for(const invalid of [{...request,width:0},{...request,height:Infinity},{...request,scale:3},{...request,width:7680}])assert.throws(()=>validateEnhancementRequest(invalid as typeof request));
  for(const output of ['', 'NVIDIA, GPU-123, N/A, N/A', 'NVIDIA, GPU-123, 16, 20'])assert.throws(()=>parseEnhancementGPU(output));
  assert.equal(parseEnhancementGPU('RTX 4080 SUPER, GPU-abcd, 16376, 14000\nOther, GPU-eeee, 8000, 4000').vramAvailable,14000*1024**2);
});
