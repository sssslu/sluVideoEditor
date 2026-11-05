import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MediaAsset, SubtitleCue, SpeechModelId, SpeechOptions } from '../shared/types';
import { transcribeWithCLI } from './speech';
import { replaceWithRetry } from './project-store';
import {requireSourceRevision} from './source-revision';

export interface ServiceContext {
  ffmpeg: string;
  ffprobe?: string;
  modelDir: string;
  cacheDir: string;
  whisper?: string;
}
export type ServiceProgress = (progress: number, message: string) => void;

// The upstream whisper.cpp model is public and immutable by its SHA-256 digest.
export const SPEECH_MODEL = {
  name: 'Whisper base · 다국어',
  filename: 'ggml-base.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  bytes: 147951465,
  sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
} as const;
export const SPEECH_MODELS={base:SPEECH_MODEL,small:{name:'Whisper small',filename:'ggml-small.bin',url:'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',bytes:487601967,sha256:'1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'},turbo:{name:'Whisper large-v3-turbo Q5',filename:'ggml-large-v3-turbo-q5_0.bin',url:'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',bytes:574041195,sha256:'394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'}} as const;
function speechModel(id:SpeechModelId){if(!Object.hasOwn(SPEECH_MODELS,id))throw new Error('지원하지 않는 음성 모델입니다.');return SPEECH_MODELS[id];}

function abortError(): Error { return Object.assign(new Error('작업이 취소되었습니다.'), { name: 'AbortError' }); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(); }

async function hashFile(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const block of createReadStream(filename)) hash.update(block);
  return hash.digest('hex');
}

export async function modelReady(ctx: ServiceContext,id:SpeechModelId='base'): Promise<boolean> {
  const model=speechModel(id);
  try { return (await stat(path.join(ctx.modelDir, model.filename))).size === model.bytes; }
  catch { return false; }
}

/** Download to a unique .part file, verify every byte, then atomically publish. */
export async function installSpeechModel(ctx: ServiceContext, progress: ServiceProgress = () => {}, signal?: AbortSignal,id:SpeechModelId='base'): Promise<string> {
  const model=speechModel(id);
  checkAbort(signal);
  await mkdir(ctx.modelDir, { recursive: true });
  const destination = path.join(ctx.modelDir, model.filename);
  if (await modelReady(ctx,id)) {
    progress(0.02, '설치된 음성 모델을 확인하고 있습니다.');
    if (await hashFile(destination) === model.sha256) { progress(1, '모델 확인 완료'); return destination; }
  }
  const temporary = path.join(ctx.modelDir, `.model-${randomUUID()}.part`);
  try {
    progress(0, `${model.name} 다운로드 · ${Math.round(model.bytes/1e6)} MB`);
    const response = await fetch(model.url, { signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`모델 다운로드 실패 (HTTP ${response.status})`);
    const writer = await open(temporary, 'wx');
    const reader = response.body.getReader();
    const hash = createHash('sha256');
    let received = 0;
    let lastReport = 0;
    try {
      while (true) {
        checkAbort(signal);
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > model.bytes) throw new Error('다운로드한 모델의 크기가 예상과 다릅니다.');
        hash.update(value);
        // FileHandle.write is permitted to make a partial write.
        let position = 0;
        while (position < value.byteLength) position += (await writer.write(value, position, value.byteLength - position)).bytesWritten;
        if (Date.now() - lastReport > 150) {
          progress(Math.min(0.98, received / model.bytes), `${model.name} · ${(received / 1e6).toFixed(1)} / ${Math.round(model.bytes/1e6)} MB`);
          lastReport = Date.now();
        }
      }
      await writer.sync();
    } finally { await writer.close(); await reader.cancel().catch(() => {}); }
    checkAbort(signal);
    if (received !== model.bytes || hash.digest('hex') !== model.sha256) throw new Error('모델 무결성 검사에 실패했습니다. 다시 다운로드해 주세요.');
    await replaceWithRetry(temporary, destination);
    progress(1, 'Whisper 다국어 모델 설치 완료');
    return destination;
  } catch (error) { if (signal?.aborted) throw abortError(); throw error; }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}

interface RunOptions { cwd?: string; signal?: AbortSignal; onLine?: (line: string) => void }
export async function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  checkAbort(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let log = '';
    const buffers = ['', ''];
    let completed = false;
    const abort = () => {
      if (child.pid && process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        killer.on('error', () => { child.kill(); });
      } else child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const finish = (error?: Error) => {
      if (completed) return;
      completed = true;
      options.signal?.removeEventListener('abort', abort);
      for (const remaining of buffers) if (remaining.trim()) options.onLine?.(remaining.trim());
      if (options.signal?.aborted) reject(abortError());
      else if (error) reject(error);
      else resolve(log);
    };
    [child.stdout, child.stderr].forEach((stream, index) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        log = (log + chunk).slice(-24000);
        buffers[index] += chunk;
        const lines = buffers[index].split(/[\r\n]+/);
        buffers[index] = lines.pop() || '';
        for (const line of lines) if (line) options.onLine?.(line);
        if (buffers[index].length > 64000) buffers[index] = buffers[index].slice(-64000);
      });
    });
    child.once('error', (error) => finish(new Error(`실행 파일을 시작할 수 없습니다: ${path.basename(command)}\n${error.message}`)));
    child.once('close', (code) => finish(code === 0 ? undefined : new Error(log.trim().slice(-5000) || `작업이 종료되었습니다 (코드 ${code}).`)));
  });
}

/** Transcribes original source time; UI maps cues onto an edited clip if needed. */
export async function transcribeMedia(media: MediaAsset, language: string, ctx: ServiceContext, progress: ServiceProgress = () => {}, signal?: AbortSignal,options:SpeechOptions={}): Promise<SubtitleCue[]> {
  checkAbort(signal);
  if (!media.hasAudio || media.kind === 'image') throw new Error('이 미디어에는 음성 트랙이 없습니다.');
  if (!/^(auto|[a-z]{2,3})$/.test(language)) throw new Error('지원하지 않는 언어 코드입니다.');
  if(ctx.whisper)return transcribeWithCLI(media,language,ctx,progress,signal,options);
  const sourceRevision=await requireSourceRevision(media.path,media.sourceRevision);
  if (!await modelReady(ctx)) throw new Error('먼저 자동 자막 모델을 설치해 주세요.');
  const resultName = `captions-${randomUUID()}.srt`;
  const resultPath = path.join(ctx.modelDir, resultName);
  progress(0, '로컬 음성 인식 준비 중 · Whisper base / CPU');
  try {
    await requireSourceRevision(media.path,sourceRevision);checkAbort(signal);
    // Both model and output are simple relative filenames: no Windows drive/filter escaping.
    const filter = `aresample=16000,whisper=model=${SPEECH_MODEL.filename}:language=${language}:queue=20:use_gpu=false:destination=${resultName}:format=srt`;
    await run(ctx.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-protocol_whitelist', 'file,pipe', '-i', path.resolve(media.path), '-map', '0:a:0', '-vn', '-af', filter, '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'], {
      cwd: ctx.modelDir, signal,
      onLine(line) {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match) {
          const seconds = Number(match[1]) / 1e6;
          progress(Math.min(0.98, seconds / Math.max(1, media.duration)), `로컬 음성 인식 중 · ${Math.round(seconds)} / ${Math.round(media.duration)}초`);
        }
      },
    });
    checkAbort(signal);
    let text = '';
    try { text = await readFile(resultPath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const cues = parseSrt(text).map(cue => ({ ...cue, start: Math.max(0, cue.start), end: Math.min(media.duration || Infinity, cue.end) })).filter(cue => cue.end > cue.start);
    await requireSourceRevision(media.path,sourceRevision);checkAbort(signal);
    progress(1, cues.length ? `자동 자막 ${cues.length}개 생성 완료` : '인식된 음성이 없습니다.');
    return cues;
  } finally { await rm(resultPath, { force: true }).catch(() => {}); }
}

function parseTimestamp(text: string): number | undefined {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(text);
  if (!match) return undefined;
  const hours = Number(match[1] || 0), minutes = Number(match[2]), seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return undefined;
  return hours * 3600 + minutes * 60 + seconds + Number(match[4].padEnd(3, '0')) / 1000;
}
function subtitleText(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }[entity] || entity)).trim();
}

/** Parse SRT and WebVTT as plain text, discarding subtitle control markup. */
export function parseSrt(input: string): SubtitleCue[] {
  if (input.length > 20_000_000) throw new Error('자막 파일이 너무 큽니다 (최대 20 MB).');
  const normalized = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues: SubtitleCue[] = [];
  for (const block of normalized.split(/\n[\t ]*\n/)) {
    const lines = block.trim().split('\n');
    if (!lines.length || /^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue;
    const timing = lines.findIndex(line => line.includes('-->'));
    if (timing < 0) continue;
    const match = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[timing]);
    if (!match) continue;
    const start = parseTimestamp(match[1]), end = parseTimestamp(match[2]);
    if (start === undefined || end === undefined || end <= start) continue;
    const text = subtitleText(lines.slice(timing + 1).join('\n'));
    if (text) cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

function timestamp(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hh = String(Math.floor(milliseconds / 3_600_000)).padStart(2, '0');
  const mm = String(Math.floor(milliseconds / 60_000) % 60).padStart(2, '0');
  const ss = String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss},${String(milliseconds % 1000).padStart(3, '0')}`;
}
export function formatSrt(cues: SubtitleCue[]): string {
  return cues.filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.end > c.start && c.text.trim()).sort((a, b) => a.start - b.start).map((cue, index) => `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text.replace(/\r\n?/g, '\n').replace(/\n\s*\n/g, '\n').trim()}\n`).join('\n');
}
