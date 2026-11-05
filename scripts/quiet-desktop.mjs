import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const helperPath = fileURLToPath(new URL('./quiet-desktop-launch.ps1',import.meta.url));

// Export the protocol observer so its failure/cleanup paths can be checked with
// Node streams and a fake child, without creating a desktop or launching an app.
export async function observePrivateDesktop(child,{directory,helperSha256,specSha256,startupTimeoutMs=60000,stopTimeoutMs=10000}) {
  const evidence = {kind:'private-windows-desktop',helperPid:child.pid,helperSha256,specSha256,directory,verifiedPids:[],stopped:null};
  const protocol = [];
  const requests = new Map();
  let pending = '', stderr = '', failure, started = false, helperClosed = false, stopping, closing;
  let readyResolve, readyReject, closedResolve;
  const ready = new Promise((resolve,reject) => {readyResolve=resolve;readyReject=reject;});
  ready.catch(()=>{});
  const closed = new Promise(resolve => {closedResolve=resolve;});
  const fail = error => {
    failure ??= error;
    readyReject(error);
    for (const request of requests.values()) {clearTimeout(request.timer);request.reject(error);}
    requests.clear();
    if(started&&!stopping)queueMicrotask(()=>{void close().catch(()=>{});});
  };
  const receive = line => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      protocol.push(message);
      assert.ok(protocol.length<=100,'Too many private-desktop protocol messages');
      if (message.event === 'started') {
        assert.equal(started,false,'Private-desktop helper started twice');
        assert.ok(Number.isSafeInteger(message.pid)&&message.pid>0);
        assert.ok(typeof message.desktopName==='string'&&message.desktopName.length>0&&message.desktopName.toLowerCase()!=='default');
        assert.ok(typeof message.desktopPath==='string'&&message.desktopPath.endsWith('\\'+message.desktopName));
        assert.equal(message.jobKillOnClose,true);
        Object.assign(evidence,{pid:message.pid,desktopName:message.desktopName,desktopPath:message.desktopPath,jobKillOnClose:true});
        started=true;
        readyResolve();
      } else if (message.event === 'exited') {
        assert.equal(message.pid,evidence.pid);
        evidence.rootExitCode=message.exitCode;
        assert.equal(message.exitCode,0,'Private-desktop root application exited with an error');
      } else if (message.event === 'process') {
        const request=requests.get(String(message.requestId));
        assert.ok(request,'Unexpected private-desktop process response');
        assert.equal(message.pid,request.pid);
        assert.equal(typeof message.inJob,'boolean');
        clearTimeout(request.timer);requests.delete(String(message.requestId));
        request.resolve(message.inJob);
      } else if (message.event === 'stopped') {
        evidence.stopped=message;
        assert.equal(message.jobRemainingProcesses,0,'Private-desktop job still has processes');
        assert.ok(['stop','stdin-eof'].includes(message.reason),`Private-desktop helper stopped unexpectedly: ${message.reason}`);
      } else if (message.event === 'error') throw Error(`Private-desktop helper failed: ${message.message}`);
      else throw Error(`Unexpected private-desktop event: ${message.event}`);
    } catch (error) {fail(error);}
  };
  child.stdout.on('data',chunk => {
    pending+=chunk.toString();
    if(pending.length>65536){fail(Error('Private-desktop protocol line exceeded64KiB'));pending='';return;}
    const lines=pending.split(/\r?\n/);pending=lines.pop()??'';
    for(const line of lines)receive(line);
  });
  child.stderr.on('data',chunk => {stderr=(stderr+chunk.toString()).slice(-65536);});
  child.stdin.on('error',error => {if(!stopping)fail(error);});
  child.once('error',fail);
  child.once('close',(code,signal) => {
    if(pending.trim())receive(pending);
    helperClosed=true;
    if(code!==0||signal||!stopping)fail(Error(`Private-desktop helper exited unexpectedly (${code}, ${signal}) ${stderr}`));
    for(const request of requests.values()){clearTimeout(request.timer);request.reject(failure??Error('Private-desktop helper closed'));}
    requests.clear();
    void Promise.all([
      fs.writeFile(path.join(directory,'protocol.jsonl'),protocol.map(row=>JSON.stringify(row)).join('\n')+'\n'),
      fs.writeFile(path.join(directory,'helper.stderr.log'),stderr),
    ]).catch(fail).finally(closedResolve);
  });

  async function close({stdinEOF=false}={}) {
    return closing ??= (async () => {
      stopping=true;
      if(!helperClosed&&!child.stdin.destroyed&&!child.stdin.writableEnded)child.stdin.end(stdinEOF?undefined:'stop\n');
      let timer;
      try {
        await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Private-desktop cleanup timed out')),stopTimeoutMs);})]);
      } catch(error) {
        fail(error);
        // Terminating only this owned helper closes its kill-on-close job handle.
        if(!helperClosed)child.kill();
        let terminationTimer;
        try {await Promise.race([closed,new Promise((_,reject)=>{terminationTimer=setTimeout(()=>reject(Error('Owned private-desktop helper did not exit after termination')),5000);})]);}
        finally {clearTimeout(terminationTimer);}
      } finally {clearTimeout(timer);}
      if(failure)throw failure;
      assert.ok(evidence.stopped,'Private-desktop helper did not verify job cleanup');
      return evidence;
    })();
  }
  const interrupt = () => {fail(Error('Private-desktop run interrupted'));void close().catch(()=>{});};
  process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  closed.finally(()=>{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);});
  let startupTimer;
  try {
    await Promise.race([ready,new Promise((_,reject)=>{startupTimer=setTimeout(()=>reject(Error('Private-desktop startup timed out')),startupTimeoutMs);})]);
  } catch(error) {
    fail(error);await close().catch(()=>{});throw error;
  } finally {clearTimeout(startupTimer);}
  return {
    evidence,
    assertRunning(){if(failure)throw failure;if(helperClosed)throw Error('Private-desktop helper is no longer running');},
    async verifyProcess(pid){
      this.assertRunning();assert.ok(Number.isSafeInteger(pid)&&pid>0);
      const requestId=randomUUID();
      const inJob=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{requests.delete(requestId);reject(Error('Private-desktop ownership check timed out'));},5000);
        requests.set(requestId,{pid,resolve,reject,timer});
        child.stdin.write(JSON.stringify({command:'verify-process',requestId,pid})+'\n');
      });
      assert.equal(inJob,true,'CDP browser process is outside the owned private-desktop job');
      if(!evidence.verifiedPids.includes(pid))evidence.verifiedPids.push(pid);
    },
    close,
  };
}

export async function launchPrivateDesktop(executable,args,{env=process.env,cwd=process.cwd(),timeoutMs=300000}={}) {
  assert.equal(process.platform,'win32','Private desktop verification requires Windows');
  assert.ok(path.isAbsolute(executable),'Private desktop executable must be absolute');
  assert.ok(Array.isArray(args)&&args.every(value=>typeof value==='string'));
  assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>=1000&&timeoutMs<=3600000,'Private desktop timeout must be between1 second and1 hour');
  const root=path.resolve('.test-artifacts/quiet-desktop');await fs.mkdir(root,{recursive:true});
  const directory=await fs.mkdtemp(path.join(root,'run-'));
  const spec={executable,args,cwd:path.resolve(cwd),parentPid:process.pid,stdoutPath:path.join(directory,'application.stdout.log'),stderrPath:path.join(directory,'application.stderr.log'),maxLogBytes:8*1024*1024,timeoutMs};
  const specBytes=Buffer.from(JSON.stringify(spec,null,2)+'\n');
  const specFile=path.join(directory,'spec.json');await fs.writeFile(specFile,specBytes);
  const helperSha256=hash(await fs.readFile(helperPath));
  const childEnv={...env,SLU_TEST_BACKGROUND:'1'};delete childEnv.ELECTRON_RUN_AS_NODE;
  assert.ok(process.env.SystemRoot&&path.isAbsolute(process.env.SystemRoot),'Windows SystemRoot is required');
  const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  await fs.access(powershell);
  const child=spawn(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helperPath,'-Spec',specFile],{cwd:path.resolve(cwd),env:childEnv,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  const session=await observePrivateDesktop(child,{directory,helperSha256,specSha256:hash(specBytes)});
  session.evidence.helperRuntime=powershell;
  const close=session.close;
  session.close=async options=>{
    const evidence=await close(options);
    assert.equal(hash(await fs.readFile(helperPath)),helperSha256,'Private-desktop helper changed during verification');
    return evidence;
  };
  return session;
}
