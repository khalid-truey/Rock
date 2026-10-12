import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createHostGateway,createLayaProxy,hashToken,reply,bodyJson,requestJson,createDecisionQueue} from './shared-laya.mjs';

const dir=await mkdtemp(path.join(tmpdir(),'rock-shared-test-'));
let tls,certificatePem;
if(process.platform==='win32') {
  // Ephemeral certificate: no system trust changes and no checked-in private key.
  const script=path.join(dir,'certificate.ps1');
  await writeFile(script,`param([string]$Dir)\n$ErrorActionPreference='Stop'\nImport-Module Microsoft.PowerShell.Security\n$c=New-SelfSignedCertificate -DnsName localhost -CertStoreLocation Cert:\\CurrentUser\\My -KeyExportPolicy Exportable -Type SSLServerAuthentication\ntry {\nExport-PfxCertificate -Cert $c -FilePath (Join-Path $Dir 'test.pfx') -Password (ConvertTo-SecureString 'test-only-password' -AsPlainText -Force) | Out-Null\n[IO.File]::WriteAllText((Join-Path $Dir 'test.pem'),"-----BEGIN CERTIFICATE-----\n"+[Convert]::ToBase64String($c.RawData,[Base64FormattingOptions]::InsertLineBreaks)+"\n-----END CERTIFICATE-----")\n} finally { Remove-Item -LiteralPath "Cert:\\CurrentUser\\My\\$($c.Thumbprint)" }`);
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,dir],{windowsHide:true,stdio:'pipe',env:{...process.env,PSModulePath:path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/Modules')}});
  tls={pfx:await readFile(path.join(dir,'test.pfx')),passphrase:'test-only-password'};
} else {
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'test.pem'),'-subj','/CN=localhost','-days','1'],{stdio:'pipe'});
  tls={key:await readFile(path.join(dir,'key.pem')),cert:await readFile(path.join(dir,'test.pem'))};
}
certificatePem=await readFile(path.join(dir,'test.pem'),'utf8');
const listen=async(server,port=0)=>{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return server.address().port;};
const close=async server=>{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('shared Laya: TLS, two devices, serialized decisions, revocation, offline recovery and no replay',async()=>{
  const pc=randomBytes(32).toString('hex'),laptop=randomBytes(32).toString('hex');
  let devices=[{tokenHash:hashToken(pc)},{tokenHash:hashToken(laptop)}],active=0,maxActive=0,decisions=0,stopped=false;
  const sidecar=http.createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer sidecar-secret')return reply(res,401,{});
    if(req.url==='/health')return reply(res,200,{status:'ready',device:'fake-test-model'});
    const body=await bodyJson(req);active++;maxActive=Math.max(maxActive,active);decisions++;
    await sleep(30);active--;reply(res,200,{model:body.model,answer:body.state.device});
  });
  const sidecarPort=await listen(sidecar);
  const options={tls,credentials:async()=>devices,sidecarToken:'sidecar-secret',sidecarUrl:`http://127.0.0.1:${sidecarPort}`,controlToken:'host-control',shutdown:()=>{stopped=true;}};
  let host=createHostGateway(options);const port=await listen(host);const url=`https://127.0.0.1:${port}`;
  const pairingFile=path.join(dir,'client.json');await writeFile(pairingFile,JSON.stringify({url,token:laptop,certificatePem}));
  const proxy=createLayaProxy({token:'local-client-token',pairingFile});const proxyPort=await listen(proxy);
  const proxyUrl=`http://127.0.0.1:${proxyPort}`;
  try {
    assert.equal((await requestJson(`${url}/health`,{token:pc,certificatePem})).shared,true);
    await assert.rejects(requestJson(`${url}/health`,{token:'invalid',certificatePem}),/Invalid or revoked/);
    await assert.rejects(requestJson(`${url}/health`,{token:pc}),/certificate|self.signed/i);
    await assert.rejects(requestJson(`${url}/admin/shutdown`,{token:laptop,certificatePem,body:{}}),/Host-local/);
    assert.equal(stopped,false);
    await assert.rejects(requestJson(`${url}/v1/systemone`,{token:pc,certificatePem,body:{}}),/Expected/);
    const results=await Promise.all(['pc','laptop','pc','laptop'].map(device=>requestJson(`${url}/v1/systemone`,{
      token:device==='pc'?pc:laptop,certificatePem,body:{model:'laya',state:{device},questions:{}},
    })));
    assert.deepEqual(results.map(r=>r.answer),['pc','laptop','pc','laptop']);assert.equal(maxActive,1);
    devices=[{tokenHash:hashToken(pc)}];
    await assert.rejects(requestJson(`${proxyUrl}/health`,{token:'local-client-token'}),/revoked/);
    devices.push({tokenHash:hashToken(laptop)});
    await close(host);
    const before=decisions;
    await assert.rejects(requestJson(`${proxyUrl}/v1/systemone`,{token:'local-client-token',body:{model:'laya',state:{device:'offline'},questions:{}}}),/Manually open/);
    host=createHostGateway(options);await listen(host,port);
    assert.equal((await requestJson(`${proxyUrl}/health`,{token:'local-client-token'})).status,'ready');
    await sleep(50);assert.equal(decisions,before,'offline requests must never be replayed');
    assert.equal((await requestJson(`${proxyUrl}/v1/systemone`,{token:'local-client-token',body:{model:'laya',state:{device:'new-request'},questions:{}}})).answer,'new-request');
    await requestJson(`${url}/admin/shutdown`,{token:'host-control',certificatePem,body:{}});await sleep(10);assert.equal(stopped,true);
  } finally {await close(proxy);await close(host);await close(sidecar);}
});

test('queue rejects overload and skips cancelled or expired waiting work',async()=>{
  const queue=createDecisionQueue({limit:1,timeout:25});let release;let ran=false;
  const first=queue.run(()=>new Promise(resolve=>{release=resolve;}));
  const control=new AbortController();
  const second=queue.run(()=>{ran=true;},control.signal);
  const rejected=assert.rejects(second,/cancelled or expired/);
  await assert.rejects(queue.run(()=>{}),/queue is full/);
  control.abort();await sleep(30);release();await first;await rejected;assert.equal(ran,false);
});

test('MCP bridge starts without Python/model; status does not start a daemon',async()=>{
  const folder=path.join(dir,'no-python-no-model');
  const reserve1=http.createServer(),reserve2=http.createServer();
  const runtimePort=await listen(reserve1),proxyPort=await listen(reserve2);await close(reserve1);await close(reserve2);
  const file=fileURLToPath(new URL('./runtime.mjs',import.meta.url));
  const env={...process.env,ROCK_DATA_DIR:folder,ROCK_RUNTIME_PORT:String(runtimePort),ROCK_LAYA_PROXY_PORT:String(proxyPort)};
  const output=execFileSync(process.execPath,[file,'status'],{env,encoding:'utf8',windowsHide:true});
  assert.equal(JSON.parse(output).status,'stopped');
  await assert.rejects(readFile(path.join(folder,'runtime.pid')),{code:'ENOENT'});
  const child=spawn(process.execPath,[file,'daemon'],{env,windowsHide:true,stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  const token=(await readFile(path.join(folder,'local-runtime-token'),'utf8')).trim();
  try {
    let health;
    for(let n=0;n<60;n++){try{health=await requestJson(`http://127.0.0.1:${runtimePort}/health`,{token,timeout:500});break;}catch{await sleep(50);}}
    assert.equal(health?.mode,'shared-laya-client',errors);
    assert.equal(health.laya.status,'offline');
    await assert.rejects(readFile(path.join(folder,'laya/runtime/Scripts/python.exe')),{code:'ENOENT'});
    await requestJson(`http://127.0.0.1:${runtimePort}/shutdown`,{token,body:{}});
  } finally {child.kill();}
});

test.after(async()=>{await rm(dir,{recursive:true,force:true});});
