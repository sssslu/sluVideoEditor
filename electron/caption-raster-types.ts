import type {Clip,ExportSettings,Project} from '../shared/types';

export interface CaptionRasterBounds {x:number;y:number;width:number;height:number}
export interface CaptionRasterGroup extends CaptionRasterBounds {id:string}
/** A single export owns the renderer. Requests are serialized and only one
 * RGBA frame is outstanding; neither movies nor PNG sequences
 * are materialized. Tests may provide this interface without loading Electron. */
export interface CaptionRasterSession {
  prepare(clips:Clip[]):Promise<CaptionRasterGroup>;
  frame(group:CaptionRasterGroup,globalFrame:number):Promise<Uint8Array>;
  release(group:CaptionRasterGroup):Promise<void>;
  close():Promise<void>;
}
export type CaptionRasterFactory=(project:Project,settings:ExportSettings,signal?:AbortSignal,diagnostics?:(event:Record<string,unknown>)=>void)=>Promise<CaptionRasterSession>;
export type CaptionRasterRequest={id:number;op:'init';project:Project;settings:ExportSettings}|{id:number;op:'prepare';group:string;clips:Clip[]}|{id:number;op:'frame';group:string;globalFrame:number;reuse?:string}|{id:number;op:'release';group:string};
export interface CaptionRasterResponse {id:number;error?:string;bounds?:CaptionRasterBounds;rgba?:ArrayBuffer;signature?:string;reused?:boolean}
