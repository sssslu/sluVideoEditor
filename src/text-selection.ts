import {useEffect,useState} from 'react';

/** Which characters of a text clip are selected, read live from the text box the user last used
 * for that clip: the inspector's text box or the caption list row. A textarea keeps its selection
 * after losing focus, so the style controls can still apply to it; reading the element itself (not
 * a stored copy) keeps drags that end outside the box and keyboard selections exact. */
let current:{clipId:string;element:HTMLTextAreaElement}|null=null;
const listeners=new Set<()=>void>();
const notify=()=>{for(const listener of listeners)listener();};
export function trackTextSelection(clipId:string,element:HTMLTextAreaElement){current={clipId,element};notify();}
export function textSelectionFor(clipId:string,text:string):{from:number;to:number}|undefined{
  if(!current||current.clipId!==clipId||!current.element.isConnected||current.element.value!==text)return undefined;
  const from=current.element.selectionStart,to=current.element.selectionEnd;return to>from?{from,to}:undefined;
}
/** Collapses the selection so the style controls act on the whole text again. */
export function clearTextSelection(){if(current?.element.isConnected){const end=current.element.selectionEnd;current.element.setSelectionRange(end,end);}notify();}
const textBoxProps=(clipId:string)=>{const track=(event:{currentTarget:HTMLTextAreaElement})=>trackTextSelection(clipId,event.currentTarget);return {onFocus:track,onSelect:track,onMouseUp:track,onKeyUp:track};};
export {textBoxProps};
/** The current selection for a clip, re-read whenever the document selection changes. */
export function useTextSelection(clipId:string|undefined,text:string|undefined){
  const [,setTick]=useState(0);
  useEffect(()=>{const update=()=>setTick(n=>n+1);listeners.add(update);document.addEventListener('selectionchange',update);return()=>{listeners.delete(update);document.removeEventListener('selectionchange',update);};},[]);
  return clipId&&text!==undefined?textSelectionFor(clipId,text):undefined;
}
