import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {trackingEvidence,cutoutEvidence} from './e2e-release-evidence.mjs';
import {BUILD_RECEIPT_PATH,validateBuildReceipt} from './build-receipt.mjs';
import {baseUIEvidencePath,validateBaseUIEvidence} from './check-base-ui.mjs';
import {featureEvidence,archiveFeatureEvidence} from './feature-evidence.mjs';

// Run after release-manifest.mjs. Preserve reports before the next version's
// checks overwrite their ordinary working paths. Does not alter shipped files.
const read=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
const version=(await read('package.json')).version,short=version;
const manifest=await read(`release/BUILD-INFO-${version}.json`);assert.equal(manifest.version,version);
const buildReceipt=await validateBuildReceipt(path.resolve('.'));
await validateBaseUIEvidence({packaged:true});
assert.equal(manifest.buildReceiptId,buildReceipt.contentId);
const root=path.resolve('.test-artifacts/packaged-verification',version);await fs.mkdir(root,{recursive:true});
await fs.copyFile(BUILD_RECEIPT_PATH,path.join(root,'build-receipt.json'));
await fs.copyFile(baseUIEvidencePath(true),path.join(root,'base-ui-packaged.json'));
await fs.copyFile('scripts/check-base-ui.mjs',path.join(root,'check-base-ui.mjs'));
const directories=['e2e','e2e-additional','editor-v2','editor-boundaries','speed-curve','stabilization-ui','stabilization-fidelity-ui','reverse-ui','job-locks-ui','transitions-ui','transition-jobs','source-revision/ipc','source-async','captions-ui','ipc-v2','color-ui','scopes-ui','audio-meter-ui','audio-eq-ui','eq-continuity-ui','media-clock-ui','freeze-frame-ui','media-alpha-ui','color-range-ui','packaged-transitions','packaged-captions','packaged-audio','portable','portable-payload','package-integrity',`manual-${short}`];
let uiChecks=0;
for(const [index,name] of directories.entries()){const source=path.join('.test-artifacts',name,'results.json'),evidence=await read(source);if(evidence.version)assert.equal(evidence.version,version);if(index<24)uiChecks+=evidence.checks.length;const destination=path.join(root,name);await fs.mkdir(destination,{recursive:true});await fs.copyFile(source,path.join(destination,'results.json'));}
for(const file of [`package-${short}.log`,`e2e-${short}-packaged.log`,`packaged-transitions-${short}.log`,`packaged-captions-${short}.log`,`packaged-audio-${short}.log`,`prepare-packaged-audio-${short}.log`,`portable-${short}.log`,`package-integrity-${short}.log`,`startup-${short}.log`,`manual-${short}.log`,'source-integrity.json'])await fs.copyFile(path.join('.test-artifacts',file),path.join(root,file));
await fs.copyFile('.test-artifacts/packaged-audio/oracle.json',path.join(root,'packaged-audio/oracle.json'));
await fs.copyFile(`release/BUILD-INFO-${version}.json`,path.join(root,'BUILD-INFO.json'));
await fs.copyFile(`release/SHA256SUMS-${version}.txt`,path.join(root,'SHA256SUMS.txt'));
const tracking=await trackingEvidence({packaged:true});
for(const report of tracking){const destination=path.join(root,report.name);await fs.mkdir(destination,{recursive:true});await fs.copyFile(path.join(report.directory,'results.json'),path.join(destination,'results.json'));}
await fs.copyFile(`.test-artifacts/tracking-${short}-packaged.log`,path.join(root,`tracking-${short}-packaged.log`));
const cutout=await cutoutEvidence({packaged:true});
const features=await featureEvidence({packaged:true,buildReceipt});
assert.deepEqual(features,manifest.verification.features,'Feature evidence differs from the release manifest');
await archiveFeatureEvidence(features,path.join(root,'features'));
const sourceFeatures=await featureEvidence({buildReceipt});
assert.deepEqual(sourceFeatures,manifest.verification.sourceFeatures,'Source feature evidence differs from the release manifest');
await archiveFeatureEvidence(sourceFeatures,path.join(root,'source-features'));
for(const report of cutout){
  const destination=path.join(root,report.name);
  await fs.mkdir(destination,{recursive:true});
  await fs.copyFile(path.join(report.directory,'results.json'),path.join(destination,'results.json'));
}
console.log(JSON.stringify({version,root,reports:directories.length+tracking.length+cutout.length,uiChecks,trackingChecks:tracking.reduce((n,r)=>n+r.checks.length,0),cutoutChecks:cutout.reduce((total,report)=>total+report.checks.length,0)},null,2));
