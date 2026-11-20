/** Non-drop frame timecode. Nominal fps names the frame counter; real fps
 * converts that integer counter to the project's exact seek time. */
function nominalRate(fps:number):number {
  if(!Number.isFinite(fps)||fps<1||fps>120)throw new RangeError('지원하지 않는 프로젝트 프레임 속도입니다.');
  return Math.round(fps);
}
const frameAt=(time:number,fps:number)=>Math.floor(Math.max(0,time)*fps+1e-7);
export function formatProgramTimecode(time:number,fps:number):string {
  const nominal=nominalRate(fps),frame=frameAt(Number.isFinite(time)?time:0,fps),whole=Math.floor(frame/nominal);
  const field=(value:number,width=2)=>String(value).padStart(width,'0');
  return `${field(Math.floor(whole/3600))}:${field(Math.floor(whole/60)%60)}:${field(whole%60)}:${field(frame%nominal,nominal>100?3:2)}`;
}
export type ProgramTimecodeResult={ok:true;time:number;frame:number}|{ok:false;error:string};
export function parseProgramTimecode(text:string,fps:number,duration:number):ProgramTimecodeResult {
  const nominal=nominalRate(fps);
  if(!Number.isFinite(duration)||duration<0||duration>86400)throw new RangeError('프로젝트 길이가 올바르지 않습니다.');
  const match=/^(\d{1,2}):(\d{2}):(\d{2}):(\d{1,3})$/.exec(text.trim());
  if(!match)return {ok:false,error:'시:분:초:프레임 형식으로 입력하세요.'};
  const [hours,minutes,seconds,frames]=match.slice(1).map(Number);
  if(minutes>59||seconds>59)return {ok:false,error:'분과 초는 00–59 사이로 입력하세요.'};
  if(frames>=nominal)return {ok:false,error:`${fps} fps에서 프레임 번호는 0–${nominal-1} 사이입니다.`};
  const frame=((hours*60+minutes)*60+seconds)*nominal+frames;
  if(frame>frameAt(duration,fps))return {ok:false,error:`프로젝트 끝 ${formatProgramTimecode(duration,fps)} 이내로 입력하세요.`};
  return {ok:true,frame,time:Math.min(frame/fps,duration)};
}
