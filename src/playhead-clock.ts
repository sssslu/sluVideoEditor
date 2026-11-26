/** The program monitor's playback position on every displayed frame. React state only gets the
 * position ten times a second; the timeline playhead and the monitor's scrub bar follow this
 * instead, so they glide with the picture without re-rendering the editor every frame. */
type Listener=(time:number)=>void;
const listeners=new Set<Listener>();
export function publishPlayhead(time:number){for(const listener of listeners)listener(time);}
export function subscribePlayhead(listener:Listener){listeners.add(listener);return()=>{listeners.delete(listener);};}
