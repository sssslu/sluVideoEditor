import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hitTest,type Geometry} from '../src/preview/renderer';
import {handleCursor,pickHandle,regionBounds,regionCenter,regionCorners,regionPoint,rotateHandle,rotationTransform,scaleTransform,snapMove,snapRotation,sweepAngle,type Box} from '../src/preview/transform-handles';

const near=(actual:number,expected:number,tolerance=1e-6)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);
const frame:Box={minX:0,minY:0,maxX:1920,maxY:1080};
const wide:Box={minX:-200,minY:-200,maxX:2120,maxY:1280};
/** Geometry the renderer builds for a clip whose transform origin sits at `anchor` (text alignment). */
const geometry=(state:{x:number;y:number;scale:number;rotation:number},size:[number,number]=[400,200],offset:[number,number]=[0,0],anchor=960):Geometry=>({size,offset,center:[anchor+state.x,540+state.y],scale:[state.scale,state.scale],rotation:state.rotation*Math.PI/180,uv:[0,0,1,1]});

test('handle geometry mirrors the hit test transform, including offsets, flips and rotation',()=>{
  const g:Geometry={size:[300,120],offset:[40,-10],center:[700,400],scale:[-1.5,.8],rotation:.6,uv:[0,0,1,1]};
  for(const local of [[0,0],[149,59],[-149,-59],[100,-30]] as [number,number][]){const point=regionPoint(g,local);assert.ok(hitTest([{clip:{} as never,geometry:g}],...point),`inside ${local}`);}
  const corners=regionCorners(g),outside=regionPoint(g,[160,0]);assert.equal(hitTest([{clip:{} as never,geometry:g}],...outside),undefined);
  const bounds=regionBounds(g);for(const corner of Object.values(corners)){assert.ok(corner[0]>=bounds.minX-1e-9&&corner[0]<=bounds.maxX+1e-9);assert.ok(corner[1]>=bounds.minY-1e-9&&corner[1]<=bounds.maxY+1e-9);}
});

test('corner drag scales uniformly around the visual centre',()=>{
  const start={x:0,y:0,scale:1,rotation:0},g=geometry(start),corner=regionCorners(g).se,center=regionCenter(g);
  const out=scaleTransform(g,start,corner,[center[0]+(corner[0]-center[0])*2,center[1]+(corner[1]-center[1])*2]);
  near(out.scale,2);near(out.x,0);near(out.y,0);
  near(scaleTransform(g,start,corner,center).scale,.01);
  near(scaleTransform(g,{...start,scale:5},corner,[center[0]+(corner[0]-center[0])*3,center[1]+(corner[1]-center[1])*3]).scale,8);
});

test('scaling and rotating left-aligned text keep its box centred under the cursor',()=>{
  const start={x:30,y:-20,scale:1.2,rotation:15},anchor=96,offset:[number,number]=[180,0],g=geometry(start,[400,90],offset,anchor),center=regionCenter(g),corner=regionCorners(g).ne;
  const scaled=scaleTransform(g,start,corner,[center[0]+(corner[0]-center[0])*1.5,center[1]+(corner[1]-center[1])*1.5]);near(scaled.scale,1.8);
  const afterScale=regionCenter(geometry({...start,...scaled},[400,90],offset,anchor));near(afterScale[0],center[0]);near(afterScale[1],center[1]);
  const rotated=rotationTransform(g,start,75);near(rotated.rotation,75);
  const afterRotate=regionCenter(geometry({...start,...rotated},[400,90],offset,anchor));near(afterRotate[0],center[0]);near(afterRotate[1],center[1]);
});

test('zoom-transition drag scale converts visual compensation back into clip offsets',()=>{
  const start={x:0,y:0,scale:1,rotation:0},g=geometry(start,[400,90],[180,0],96),scaled=scaleTransform(g,start,regionCorners(g).se,regionPoint(g,[400,90]),2),plain=scaleTransform(g,start,regionCorners(g).se,regionPoint(g,[400,90]));
  near(scaled.x*2,plain.x);near(scaled.scale,plain.scale);
});

test('rotation sweeps continuously and attracts to straight angles',()=>{
  near(sweepAngle([0,0],[1,0],[0,1]),90);near(sweepAngle([0,0],[-1,.01],[-1,-.01]),1.1459,1e-3);near(sweepAngle([0,0],[1,0],[-1,-1e-9]),-180,1e-6);
  assert.equal(snapRotation(88),90);assert.equal(snapRotation(-183),-180);assert.equal(snapRotation(80),80);assert.equal(snapRotation(37,15),30);assert.equal(snapRotation(38,15),45);
});

test('moving snaps edges and centres to the frame and reports every aligned guide',()=>{
  const box={minX:760,minY:440,maxX:1160,maxY:640};
  const centred=snapMove(box,[4,-5],1920,1080,6);assert.deepEqual(centred.delta,[0,0]);assert.deepEqual(centred.guides,[{axis:'x',position:960},{axis:'y',position:540}]);
  const left=snapMove(box,[-757,30],1920,1080,6);assert.deepEqual(left.delta,[-760,30]);assert.deepEqual(left.guides,[{axis:'x',position:0}]);
  assert.deepEqual(snapMove(box,[20,20],1920,1080,6),{delta:[20,20],guides:[]});
  const full=snapMove({minX:0,minY:0,maxX:1920,maxY:1080},[3,0],1920,1080,6);assert.deepEqual(full.delta,[0,0]);assert.deepEqual(full.guides.filter(g=>g.axis==='x').map(g=>g.position).sort((a,b)=>a-b),[0,960,1920]);
});

test('handles are picked by screen distance and the rotate handle stays visible',()=>{
  const g=geometry({x:0,y:0,scale:1,rotation:0}),corners=regionCorners(g);
  assert.equal(pickHandle(g,[corners.nw[0]+3,corners.nw[1]+3],1,frame),'nw');assert.equal(pickHandle(g,corners.se,1,frame),'se');
  assert.equal(pickHandle(g,[960,540],1,frame),undefined);
  const below=rotateHandle(g,1,frame);near(below[0],960);near(below[1],640+24);assert.equal(pickHandle(g,below,1,frame),'rotate');
  // A full-frame clip has no room below or above, so the handle moves just inside the bottom edge.
  const full=geometry({x:0,y:0,scale:1,rotation:0},[1920,1080]),inside=rotateHandle(full,1,frame);near(inside[1],1080-24);
  near(rotateHandle(full,1,wide)[1],1080+24);
  // Small boxes keep their middle draggable.
  const tiny=geometry({x:0,y:0,scale:1,rotation:0},[20,20]);assert.equal(pickHandle(tiny,[960,540],1,frame),undefined);
});

test('resize cursors follow the rotated diagonal',()=>{
  const g=geometry({x:0,y:0,scale:1,rotation:0},[200,200]);
  assert.equal(handleCursor(g,'se'),'nwse-resize');assert.equal(handleCursor(g,'ne'),'nesw-resize');assert.equal(handleCursor(g,'rotate'),'grab');
  assert.equal(handleCursor({...g,rotation:Math.PI/4},'se'),'ns-resize');assert.equal(handleCursor({...g,scale:[-1,1]},'se'),'nesw-resize');
});
