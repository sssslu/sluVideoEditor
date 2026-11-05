import path from 'node:path';
import {mkdir,open,readFile,rename,rm,stat} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {availableParallelism} from 'node:os';
import yauzl from 'yauzl';
import {run,modelReady,SPEECH_MODELS,type ServiceContext,type ServiceProgress} from './services';
import type {CaptionWord,MediaAsset,SpeechOptions,SubtitleCue} from '../shared/types';
import {publishRuntimeDirectory} from './project-store';
import {requireSourceRevision} from './source-revision';
import {assertCaptionWords,captionGraphemes} from '../shared/captions';

const CUDA={version:'1.8.7',url:'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.7/whisper-cublas-12.4.0-bin-x64.zip',sha256:'ce5e66c7e45985f497e3a81c9d33723f19b3118993b47f53b8351df5cbb20402'};
const cudaDirectory=(ctx:ServiceContext)=>path.join(ctx.modelDir,`whisper-cuda-${CUDA.version}`);
const cudaExecutable=(ctx:ServiceContext)=>path.join(cudaDirectory(ctx),'Release','whisper-cli.exe');
function abort(signal?:AbortSignal){if(signal?.aborted)throw Object.assign(new Error('작업이 취소되었습니다.'),{name:'AbortError'});}
export async function speechCudaReady(ctx:ServiceContext){try{if((await readFile(path.join(cudaDirectory(ctx),'.verified'),'utf8'))!==CUDA.sha256)return false;const files=['whisper-cli.exe','whisper.dll','ggml.dll','ggml-base.dll','ggml-cpu.dll','ggml-cuda.dll','cublas64_12.dll','cublasLt64_12.dll','cudart64_12.dll','nvrtc64_120_0.dll','nvrtc-builtins64_124.dll'];return (await Promise.all(files.map(file=>stat(path.join(cudaDirectory(ctx),'Release',file))))).every(file=>file.isFile()&&file.size>0);}catch{return false;}}
async function extractArchive(archive:string,destination:string,signal?:AbortSignal){
  const zip=await new Promise<yauzl.ZipFile>((resolve,reject)=>yauzl.open(archive,{lazyEntries:true,autoClose:true},(error,value)=>error?reject(error):resolve(value!)));
  let total=0;
  await new Promise<void>((resolve,reject)=>{
    let finished=false;const finish=(error?:unknown)=>{if(finished)return;finished=true;signal?.removeEventListener('abort',cancel);zip.close();error?reject(error):resolve();};
    const cancel=()=>finish(Object.assign(new Error('작업이 취소되었습니다.'),{name:'AbortError'}));signal?.addEventListener('abort',cancel,{once:true});
    zip.on('error',finish);zip.on('end',()=>finish());
    zip.on('entry',async(entry:yauzl.Entry)=>{try{
      abort(signal);total+=entry.uncompressedSize;if(total>2_000_000_000)throw new Error('음성 엔진 압축 크기가 유효하지 않습니다.');
      const target=path.resolve(destination,entry.fileName),relative=path.relative(destination,target);
      if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||entry.fileName.includes(':')||((entry.externalFileAttributes>>>16)&0xf000)===0xa000)throw new Error('음성 엔진 압축 경로가 유효하지 않습니다.');
      if(entry.fileName.endsWith('/'))await mkdir(target,{recursive:true});else{
        await mkdir(path.dirname(target),{recursive:true});const stream=await new Promise<NodeJS.ReadableStream>((res,rej)=>zip.openReadStream(entry,(err,s)=>err?rej(err):res(s!)));
        await pipeline(stream,createWriteStream(target,{flags:'wx'}),{signal});
      }
      if(!finished)zip.readEntry();
    }catch(error){finish(error);}});if(signal?.aborted)cancel();else zip.readEntry();
  });
}
export async function installSpeechEngine(ctx:ServiceContext,progress:ServiceProgress=()=>{},signal?:AbortSignal){
  abort(signal);if(await speechCudaReady(ctx)){progress(1,'CUDA 엔진 설치됨');return;}
  await mkdir(ctx.modelDir,{recursive:true});const folder=path.join(ctx.modelDir,`.cuda-${randomUUID()}`),archive=folder+'.zip';
  try{
    progress(0,'CUDA 음성 엔진 다운로드 · 약 439 MB');const response=await fetch(CUDA.url,{signal});if(!response.ok||!response.body)throw new Error(`CUDA 다운로드 실패 (HTTP ${response.status})`);
    const handle=await open(archive,'wx'),hash=createHash('sha256'),reader=response.body.getReader();let received=0,last=0;
    try{while(true){abort(signal);const {done,value}=await reader.read();if(done)break;received+=value.length;if(received>500_000_000)throw new Error('음성 엔진 크기 초과');hash.update(value);for(let written=0;written<value.length;)written+=(await handle.write(value,written,value.length-written)).bytesWritten;if(Date.now()-last>200){progress(Math.min(.85,received/439_000_000*.85),`CUDA 엔진 · ${Math.round(received/1e6)} MB`);last=Date.now();}}await handle.sync();}finally{await handle.close();await reader.cancel().catch(()=>{});}
    if(hash.digest('hex')!==CUDA.sha256)throw new Error('CUDA 엔진 무결성 검사 실패');
    progress(.87,'CUDA 엔진 압축 해제');await mkdir(folder);await extractArchive(archive,folder,signal);abort(signal);
    // The archive digest is pinned above; the marker is written only after extraction succeeds.
    const marker=await open(path.join(folder,'.verified'),'wx');await marker.writeFile(CUDA.sha256);await marker.close();
    await stat(path.join(folder,'Release','whisper-cli.exe'));await publishRuntimeDirectory(folder,cudaDirectory(ctx));progress(1,'CUDA 음성 엔진 설치 완료');
  }finally{await rm(archive,{force:true}).catch(()=>{});await rm(folder,{recursive:true,force:true}).catch(()=>{});}
}

export interface TimedText {start:number;end:number;text:string;timing?:CaptionWord['timing']}
const characters=(text:string)=>captionGraphemes(text).map(part=>part.text);
/** Token-derived words retain their provenance; a sentence timestamp is not a measured word timestamp. */
export function parseWhisperWords(data:unknown):TimedText[]{
  const rows=(data as {transcription?:unknown[]})?.transcription;if(!Array.isArray(rows))throw new Error('음성 인식 결과 형식 오류');
  const words:TimedText[]=[];
  for(const raw of rows){const row=raw as any;if(!row||typeof row!=='object')continue;const from=Math.max(0,Number(row.offsets?.from)/1000),to=Number(row.offsets?.to)/1000;if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)continue;
    const tokens=Array.isArray(row.tokens)?row.tokens.filter((t:any)=>typeof t?.text==='string'&&!/^\[_.*\]$/.test(t.text)):[];
    const fallback=()=>{const text=typeof row.text==='string'?row.text:tokens.map((t:any)=>t.text).join('');if(text.trim())words.push({start:from,end:to,text:text.trim()});};
    if(!tokens.length||tokens.some((t:any)=>!Number.isFinite(t.offsets?.from)||!Number.isFinite(t.offsets?.to)||t.offsets.to<t.offsets.from)){fallback();continue;}
    const rowWords:TimedText[]=[];
    let word:TimedText|undefined;
    for(const token of tokens){const text=token.text as string;if(!text)continue;if(!text.trim()){if(word)rowWords.push(word);word=undefined;continue;}const start=Math.min(to,Math.max(from,Number(token.offsets.from)/1000)),end=Math.max(start,Math.min(to,Number(token.offsets.to)/1000));
      if(word&&/^\s*[.!?。！？,，、:;…'"”’」』）)\]}]+$/u.test(text)&&!/^\s+['"]+$/u.test(text)){word.text+=text.trim();word.end=Math.max(word.end,end);continue;}
      if(word&&/^\s/.test(text)&&text.trim()){rowWords.push(word);word=undefined;}
      if(!word)word={start,end,text,timing:'measured'};else{word.text+=text;word.end=Math.max(word.end,end);}
    }if(word)rowWords.push(word);
    if(rowWords.some(w=>w.text.trim()&&w.end<=w.start)){fallback();continue;}
    words.push(...rowWords);
  }
  return words.filter(w=>w.text.trim()).map(w=>({...w,text:w.text.trim()}));
}

/** Each overlapped ASR chunk owns words by midpoint, then clips times to its half-open source interval. */
export function selectOwnedWhisperWords(words:TimedText[],chunkStart:number,ownershipStart:number,ownershipEnd:number,sourceStart=0):TimedText[]{
  if(![chunkStart,ownershipStart,ownershipEnd,sourceStart].every(Number.isFinite)||ownershipEnd<=ownershipStart)throw new Error('자막 소유 구간 오류');
  return words.map(w=>({...w,start:w.start+chunkStart,end:w.end+chunkStart}))
    .filter(w=>Number.isFinite(w.start)&&Number.isFinite(w.end)&&(w.start+w.end)/2>=ownershipStart&&(w.start+w.end)/2<ownershipEnd)
    .map(w=>({...w,start:Math.max(ownershipStart,w.start)+sourceStart,end:Math.min(ownershipEnd,w.end)+sourceStart}))
    .filter(w=>w.end>w.start);
}

/** Crop annotations without changing their UTF-16 spans; missing timing remains missing. */
function cropCueWords(cue:SubtitleCue):SubtitleCue{
  if(!cue.words)return cue;
  const words:CaptionWord[]=[];
  for(const word of cue.words){
    const start=Math.max(cue.start,word.start),end=Math.min(cue.end,word.end);
    if(end<=start)continue;
    while(words.length&&words.at(-1)!.end>start){const previous=words.at(-1)!;previous.end=start;if(previous.end>previous.start)break;words.pop();}
    words.push({...word,start,end});
  }
  assertCaptionWords(cue.text,words,cue.start,cue.end);
  return {...cue,words:words.length?words:undefined};
}

function splitCaptionText(chars:string[],maxChars:number,desiredParts:number):string[]{
  const whitespace=(index:number)=>/^\s+$/u.test(chars[index]??'');
  const wordEnds:number[]=[];
  for(let index=0;index<chars.length;index++)if(!whitespace(index)&&(index===chars.length-1||whitespace(index+1)))wordEnds.push(index+1);
  const pieces:string[]=[];let from=0,wordIndex=0;
  while(from<chars.length){
    while(whitespace(from))from++;
    if(from>=chars.length)break;
    while(wordEnds[wordIndex]<=from)wordIndex++;
    const remaining=Math.max(1,desiredParts-pieces.length),target=from+(chars.length-from)/remaining,limit=Math.min(chars.length,from+maxChars);
    const candidates:number[]=[];
    for(let index=wordIndex;index<wordEnds.length&&wordEnds[index]<=limit;index++)candidates.push(wordEnds[index]);
    let to:number;
    // Split within a grapheme sequence only for an unbroken overlong word.
    if(!candidates.length||(wordEnds.length===1&&remaining>1))to=Math.min(limit,Math.max(from+1,Math.round(target)));
    else{
      const choices=remaining>1&&candidates.length>1?candidates.filter(end=>end<chars.length):candidates;
      to=choices.reduce((best,end)=>Math.abs(end-target)<Math.abs(best-target)?end:best,choices[0]);
    }
    pieces.push(chars.slice(from,to).join('').trim());from=to;
  }
  return pieces;
}

export function groupCaptionWords(words:TimedText[],maxChars=28,maxDuration=4):SubtitleCue[]{
  if(!Number.isInteger(maxChars)||maxChars<8||maxChars>120||!Number.isFinite(maxDuration)||maxDuration<1||maxDuration>15)throw new Error('자막 길이 설정 오류');
  const units:TimedText[]=[];
  for(const w of words){
    if(!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.end<=w.start||!w.text.trim())continue;
    const chars=characters(w.text.trim());
    // A grapheme cannot be split safely, even when a single symbol outlasts maxDuration.
    const desiredParts=Math.min(chars.length,Math.max(1,Math.ceil(chars.length/maxChars),Math.ceil((w.end-w.start)/maxDuration)));
    const pieces=desiredParts>1?splitCaptionText(chars,maxChars,desiredParts):[w.text.trim()],parts=pieces.length;
    if(parts===1){units.push({...w,text:w.text.trim()});continue;}
    for(let i=0;i<parts;i++){
      const text=pieces[i];
      if(text)units.push({text,start:i===0?w.start:w.start+(w.end-w.start)*i/parts,end:i===parts-1?w.end:w.start+(w.end-w.start)*(i+1)/parts,timing:'estimated'});
    }
  }
  const cues:SubtitleCue[]=[];let current:SubtitleCue|undefined;
  const finish=()=>{if(current){cues.push(current);current=undefined;}};
  for(const w of units){
    if(current&&(characters(current.text).length+1+characters(w.text).length>maxChars||w.end-current.start>maxDuration||w.start-current.end>.65||/[.!?。！？][”’"'」』）)\]}]*$/u.test(current.text)))finish();
    const from=current?current.text.length+1:0;
    const annotation=w.timing?{from,to:from+w.text.length,start:w.start,end:w.end,timing:w.timing}:undefined;
    if(!current)current={start:w.start,end:w.end,text:w.text,...(annotation?{words:[annotation]}:{})};
    else{current.text+=' '+w.text;current.end=Math.max(current.end,w.end);if(annotation)(current.words??=[]).push(annotation);}
  }
  finish();for(let i=0;i<cues.length-1;i++)cues[i].end=Math.min(cues[i].end,cues[i+1].start);
  return cues.filter(c=>c.end>c.start).map(cropCueWords);
}

export async function transcribeWithCLI(media:MediaAsset,language:string,ctx:ServiceContext,progress:ServiceProgress,signal:AbortSignal|undefined,options:SpeechOptions):Promise<SubtitleCue[]>{
  const modelId=options.model??'base',device=options.device??'auto',start=options.start??0,duration=options.duration??(media.duration-start),maxChars=options.maxChars??28,maxDuration=options.maxDuration??4;
  if(!Object.hasOwn(SPEECH_MODELS,modelId)||!['auto','cpu','cuda'].includes(device)||![start,duration].every(Number.isFinite)||start<0||duration<=0||start+duration>media.duration+.15)throw new Error('음성 인식 구간 또는 모델 설정 오류');
  groupCaptionWords([],maxChars,maxDuration);abort(signal);const sourceRevision=await requireSourceRevision(media.path,media.sourceRevision);if(!await modelReady(ctx,modelId))throw new Error('선택한 음성 모델을 먼저 설치하세요.');
  const cuda=await speechCudaReady(ctx);if(device==='cuda'&&!cuda)throw new Error('CUDA 음성 엔진을 먼저 설치하세요.');
  let useCuda=device!=='cpu'&&cuda;const result:SubtitleCue[]=[];
  const work=path.join(ctx.cacheDir,`speech-${randomUUID()}`);await mkdir(work,{recursive:true});
  try{
    for(let offset=0;offset<duration;offset+=600){
      abort(signal);const ownershipEnd=Math.min(duration,offset+600),chunkStart=Math.max(0,offset-1),chunkEnd=Math.min(duration,ownershipEnd+1),chunkDuration=chunkEnd-chunkStart,wav=path.join(work,'audio.wav'),out=path.join(work,'result');
      progress(offset/duration,`음성 추출 · ${Math.round(offset)} / ${Math.round(duration)}초`);
      await requireSourceRevision(media.path,sourceRevision);abort(signal);
      await run(ctx.ffmpeg,['-hide_banner','-nostdin','-v','error','-y','-ss',String(start+chunkStart),'-t',String(chunkDuration),'-protocol_whitelist','file,pipe','-i',media.path,'-map','0:a:0','-vn','-ar','16000','-ac','1','-c:a','pcm_s16le',wav],{signal});
      await requireSourceRevision(media.path,sourceRevision);abort(signal);
      const args=['-m',path.join(ctx.modelDir,SPEECH_MODELS[modelId].filename),'-f',wav,'-l',language,'-ojf','-of',out,'-pp','-t',String(Math.min(8,Math.max(2,availableParallelism()-2)))];
      const execute=async()=>{let confirmedCuda=false;await run(useCuda?cudaExecutable(ctx):ctx.whisper!,[...args,...(!useCuda?['-ng']:[])],{cwd:work,signal,onLine(line){if(/using CUDA\d+ backend/.test(line))confirmedCuda=true;const m=/progress\s*=\s*(\d+)%/.exec(line);if(m)progress(Math.min(.99,(offset+(ownershipEnd-offset)*Number(m[1])/100)/duration),`음성 인식 · ${modelId} / ${useCuda&&confirmedCuda?'CUDA':'CPU'} · ${m[1]}%`);}});if(useCuda&&!confirmedCuda)throw new Error('CUDA 백엔드를 활성화하지 못했습니다.');};
      progress(offset/duration,`음성 인식 · ${modelId} / ${useCuda?'CUDA':'CPU'}`);
      try{await execute();}catch(error){abort(signal);if(device==='auto'&&useCuda){useCuda=false;progress(offset/duration,'CUDA 실행 실패 · CPU로 재시도');await execute();}else throw error;}
      await requireSourceRevision(media.path,sourceRevision);abort(signal);
      const words=selectOwnedWhisperWords(parseWhisperWords(JSON.parse(await readFile(out+'.json','utf8'))),chunkStart,offset,ownershipEnd,start);
      result.push(...groupCaptionWords(words,maxChars,maxDuration));
    }
    await requireSourceRevision(media.path,sourceRevision);abort(signal);progress(1,`자막 ${result.length}개`);return result;
  }finally{await rm(work,{recursive:true,force:true}).catch(()=>{});}
}
