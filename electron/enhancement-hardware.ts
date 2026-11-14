import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {freemem,totalmem} from 'node:os';
import path from 'node:path';
import type {EnhancementRequest,EnhancementHardware} from '../shared/types';

const execute=promisify(execFile);
const GIB=1024**3;

export interface EnhancementMachine {
  gpuName:string;
  gpuUuid:string;
  vramTotal:number;
  vramAvailable:number;
  ramTotal:number;
  ramAvailable:number;
  commitAvailable:number;
}

export function validateEnhancementRequest(request:EnhancementRequest) {
  if(!request||![2,4].includes(request.scale)||!Number.isInteger(request.width)||!Number.isInteger(request.height)||
    request.width<1||request.height<1||Math.max(request.width,request.height)*request.scale>7680||
    request.width*request.height*request.scale**2>33177600) {
    throw new Error('화질 향상 결과는 최대 7680픽셀, 3,318만 화소까지 지원합니다.');
  }
}

// Keep this preflight consistent with resource_requirements/check_memory_budget
// in seedvr_worker.py. Native inference repeats its checks before loading weights
// and before each model call, including changes made by other applications.
export function enhancementRequirements(request:EnhancementRequest,vramBudget:number) {
  validateEnhancementRequest(request);
  const pixels=request.width*request.height*request.scale**2;
  const initialLoad=6782952896+501296454+9*GIB/4;
  const directVram=initialLoad+pixels*64;
  const blocksToSwap=directVram<=vramBudget?0:8;
  const vram=blocksToSwap?Math.max(initialLoad,directVram-2538135888+317266986):directVram;
  const frameCopies=pixels*((2*9+4)*6+64)+request.width*request.height*(2*9+16)*3;
  const physical=3*GIB+pixels*(9*24+80)+frameCopies+(blocksToSwap?2538135888:0);
  const commit=physical+Math.max(vramBudget,initialLoad+pixels*9*64)+(blocksToSwap?GIB:0);
  return {vram,ram:physical+3*GIB,commit:commit+4*GIB,blocksToSwap};
}

export function assessEnhancementHardware(request:EnhancementRequest,machine:EnhancementMachine):EnhancementHardware {
  const vramBudget=Math.floor(Math.min(machine.vramTotal*.60,machine.vramAvailable*.70));
  const required=enhancementRequirements(request,vramBudget);
  const permanent=enhancementRequirements(request,Math.floor(machine.vramTotal*.60));
  const deviceSupported=permanent.vram<=machine.vramTotal*.60&&permanent.ram<=machine.ramTotal;
  const gaps:string[]=[];
  const gib=(bytes:number)=>(bytes/GIB).toFixed(1);
  if(required.vram>vramBudget)gaps.push(`GPU 메모리 부족 · 필요 ${gib(required.vram)} GiB / AI 사용 가능 ${gib(vramBudget)} GiB`);
  if(required.ram>machine.ramAvailable)gaps.push(`RAM 부족 · 필요 ${gib(required.ram)} GiB / 여유 ${gib(machine.ramAvailable)} GiB`);
  if(required.commit>machine.commitAvailable)gaps.push(`Windows 메모리 여유 부족 · 필요 ${gib(required.commit)} GiB / 여유 ${gib(machine.commitAvailable)} GiB`);
  return {
    deviceSupported,canRun:gaps.length===0,
    gpu:machine.gpuName,gpuUuid:machine.gpuUuid,
    vramTotalBytes:machine.vramTotal,vramAvailableBytes:machine.vramAvailable,vramBudgetBytes:vramBudget,
    ramTotalBytes:machine.ramTotal,ramAvailableBytes:machine.ramAvailable,commitAvailableBytes:machine.commitAvailable,
    requiredVramBytes:required.vram,requiredRamBytes:required.ram,requiredCommitBytes:required.commit,
    ...(gaps.length?{message:gaps.join('\n')}:{}),
  };
}

export function parseEnhancementGPU(output:string) {
  const fields=output.trim().split(/\r?\n/)[0]?.split(',').map(value=>value.trim());
  if(!fields||fields.length!==4||!fields[0]||!/^GPU-[a-f\d-]+$/i.test(fields[1]))throw new Error('NVIDIA GPU 정보를 확인할 수 없습니다.');
  const total=Number(fields[2])*1024**2,available=Number(fields[3])*1024**2;
  if(!Number.isFinite(total)||!Number.isFinite(available)||total<=0||available<0||available>total)throw new Error('GPU 메모리 정보를 확인할 수 없습니다.');
  return {gpuName:fields[0],gpuUuid:fields[1],vramTotal:total,vramAvailable:available};
}

export async function checkEnhancementHardware(request:EnhancementRequest):Promise<EnhancementHardware> {
  validateEnhancementRequest(request);
  try {
    const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const [gpu,memory]=await Promise.all([
      execute('nvidia-smi',['--query-gpu=name,uuid,memory.total,memory.free','--format=csv,noheader,nounits'],{windowsHide:true,timeout:15000,maxBuffer:65536}),
      execute(powershell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',
        '$m = Get-CimInstance Win32_PerfRawData_PerfOS_Memory -ErrorAction Stop; [pscustomobject]@{commitLimit=[double]$m.CommitLimit;committed=[double]$m.CommittedBytes} | ConvertTo-Json -Compress'],
        {windowsHide:true,timeout:15000,maxBuffer:65536}),
    ]);
    const status=JSON.parse(memory.stdout.replace(/^\uFEFF/,''));
    if(!Number.isFinite(status.commitLimit)||!Number.isFinite(status.committed)||status.commitLimit<=0||status.committed<0||status.committed>status.commitLimit)throw new Error('Windows 메모리 정보를 확인할 수 없습니다.');
    return assessEnhancementHardware(request,{...parseEnhancementGPU(gpu.stdout),ramTotal:totalmem(),ramAvailable:freemem(),commitAvailable:status.commitLimit-status.committed});
  } catch {
    return {deviceSupported:false,canRun:false,message:'실행 사양을 확인할 수 없습니다. NVIDIA GPU와 드라이버 상태를 확인한 뒤 다시 확인하세요.'};
  }
}

export async function requireEnhancementHardware(request:EnhancementRequest) {
  const hardware=await checkEnhancementHardware(request);
  if(!hardware.canRun)throw new Error(hardware.message||'현재 사양에서 AI 화질 향상을 실행할 수 없습니다.');
  return hardware;
}
