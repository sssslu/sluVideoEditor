import type {Geometry} from './renderer';

/** On-canvas transform handles for the program monitor. Points are project pixels; `unit` is project pixels per CSS pixel. */
export type Point=[number,number];
export type Corner='nw'|'ne'|'se'|'sw';
export type Handle=Corner|'rotate';
export interface Box {minX:number;minY:number;maxX:number;maxY:number}
export interface Guide {axis:'x'|'y';position:number}
export interface TransformValues {x:number;y:number;scale:number;rotation:number}

export const HANDLE_RADIUS=5,HANDLE_HIT=9,ROTATE_RADIUS=10,ROTATE_GAP=24,SNAP_DISTANCE=6;
export const MIN_SCALE=.01,MAX_SCALE=8,MAX_ROTATION=3600;
const CORNERS:Record<Corner,Point>={nw:[-1,-1],ne:[1,-1],se:[1,1],sw:[-1,1]};
const clamp=(n:number,min:number,max:number)=>Math.min(max,Math.max(min,n));
const distance=(a:Point,b:Point)=>Math.hypot(a[0]-b[0],a[1]-b[1]);

/** Maps a region-local point (before offset, scale and rotation) to project space; the inverse of hitTest. */
export function regionPoint(g:Geometry,[lx,ly]:Point):Point{const c=Math.cos(g.rotation),s=Math.sin(g.rotation),x=(lx+g.offset[0])*g.scale[0],y=(ly+g.offset[1])*g.scale[1];return [g.center[0]+c*x-s*y,g.center[1]+s*x+c*y];}
/** Visual centre of the box. Differs from geometry.center (the transform origin) for left/right aligned text. */
export const regionCenter=(g:Geometry)=>regionPoint(g,[0,0]);
export function regionCorners(g:Geometry):Record<Corner,Point>{return Object.fromEntries(Object.entries(CORNERS).map(([key,[sx,sy]])=>[key,regionPoint(g,[sx*g.size[0]/2,sy*g.size[1]/2])])) as Record<Corner,Point>;}
export function regionBounds(g:Geometry):Box{const points=Object.values(regionCorners(g)),xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);return {minX:Math.min(...xs),minY:Math.min(...ys),maxX:Math.max(...xs),maxY:Math.max(...ys)};}
const inside=(box:Box,[x,y]:Point,margin:number)=>x>=box.minX+margin&&x<=box.maxX-margin&&y>=box.minY+margin&&y<=box.maxY-margin;

/** Below the box like CapCut; above it, then just inside the bottom edge when the visible area would clip it. */
export function rotateHandle(g:Geometry,unit:number,view:Box):Point{
  const center=regionCenter(g),down:Point=[-Math.sin(g.rotation),Math.cos(g.rotation)],half=Math.abs(g.size[1]*g.scale[1])/2,gap=ROTATE_GAP*unit;
  const offsets=[half+gap,-(half+gap),Math.max(0,half-gap)],at=(offset:number):Point=>[center[0]+down[0]*offset,center[1]+down[1]*offset];
  return at(offsets.find(offset=>inside(view,at(offset),(ROTATE_RADIUS+2)*unit))??offsets[2]);
}
export function pickHandle(g:Geometry,point:Point,unit:number,view:Box):Handle|undefined{
  if(distance(point,rotateHandle(g,unit,view))<=(ROTATE_RADIUS+3)*unit)return 'rotate';
  // Small boxes keep their middle draggable instead of being covered by corner targets.
  const corners=regionCorners(g),shortest=Math.min(distance(corners.nw,corners.ne),distance(corners.nw,corners.sw))/unit;
  let best:Corner|undefined,limit=Math.min(HANDLE_HIT,Math.max(4,shortest/4))*unit;
  for(const [key,corner]of Object.entries(corners) as [Corner,Point][]){const d=distance(point,corner);if(d<=limit){limit=d;best=key;}}
  return best;
}
/** Resize cursor matching the corner's on-screen diagonal, including rotation and flips. */
export function handleCursor(g:Geometry,handle:Handle):string{
  if(handle==='rotate')return 'grab';
  const center=regionCenter(g),corner=regionCorners(g)[handle],angle=((Math.atan2(corner[1]-center[1],corner[0]-center[0])*180/Math.PI)%180+180)%180;
  return angle<22.5||angle>=157.5?'ew-resize':angle<67.5?'nwse-resize':angle<112.5?'ns-resize':'nesw-resize';
}

/** Uniform corner scaling around the visual centre; `dragScale` converts screen motion to clip offsets during zoom transitions. */
export function scaleTransform(g:Geometry,start:TransformValues,from:Point,to:Point,dragScale=1):Pick<TransformValues,'x'|'y'|'scale'>{
  const pivot=regionCenter(g),scale=clamp(start.scale*distance(to,pivot)/Math.max(1e-6,distance(from,pivot)),MIN_SCALE,MAX_SCALE),ratio=scale/Math.max(1e-6,start.scale);
  const shift=1-ratio,offset:Point=[pivot[0]-g.center[0],pivot[1]-g.center[1]];
  return {scale,x:start.x+offset[0]*shift/dragScale,y:start.y+offset[1]*shift/dragScale};
}
/** Rotation around the visual centre. `rotation` is the new absolute clip rotation in degrees. */
export function rotationTransform(g:Geometry,start:TransformValues,rotation:number,dragScale=1):Pick<TransformValues,'x'|'y'|'rotation'>{
  const value=clamp(rotation,-MAX_ROTATION,MAX_ROTATION),pivot=regionCenter(g),offset:Point=[pivot[0]-g.center[0],pivot[1]-g.center[1]],delta=(value-start.rotation)*Math.PI/180,c=Math.cos(delta),s=Math.sin(delta);
  const turned:Point=[c*offset[0]-s*offset[1],s*offset[0]+c*offset[1]];
  return {rotation:value,x:start.x+(offset[0]-turned[0])/dragScale,y:start.y+(offset[1]-turned[1])/dragScale};
}
/** Signed angle in degrees, normalised to (-180, 180], swept from `from` to `to` around `pivot`. */
export function sweepAngle(pivot:Point,from:Point,to:Point){const delta=(Math.atan2(to[1]-pivot[1],to[0]-pivot[0])-Math.atan2(from[1]-pivot[1],from[0]-pivot[0]))*180/Math.PI;return delta>180?delta-360:delta<=-180?delta+360:delta;}
/** Shift: fixed steps. Otherwise straight angles attract within `threshold` degrees. */
export function snapRotation(value:number,step?:number,threshold=4){if(step)return Math.round(value/step)*step;const straight=Math.round(value/90)*90;return Math.abs(value-straight)<=threshold?straight:value;}

/** Snaps a moved box's edges or centre to the frame's edges or centre lines. */
export function snapMove(bounds:Box,delta:Point,width:number,height:number,threshold:number):{delta:Point;guides:Guide[]}{
  const guides:Guide[]=[];
  const axis=(name:'x'|'y',min:number,max:number,move:number,size:number)=>{
    const edges=[(min+max)/2,min,max],targets=[size/2,0,size];let best:number|undefined;
    for(const edge of edges)for(const target of targets){const diff=target-(edge+move);if(Math.abs(diff)<=threshold&&(best===undefined||Math.abs(diff)<Math.abs(best)-1e-9))best=diff;}
    if(best===undefined)return move;const snapped=move+best;
    for(const target of targets)if(edges.some(edge=>Math.abs(edge+snapped-target)<1e-6))guides.push({axis:name,position:target});
    return snapped;
  };
  return {delta:[axis('x',bounds.minX,bounds.maxX,delta[0],width),axis('y',bounds.minY,bounds.maxY,delta[1],height)],guides};
}
