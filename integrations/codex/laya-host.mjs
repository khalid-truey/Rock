// Only `start` may spawn Python or load the model. MCP never imports this launcher.
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createHostGateway,hashToken,requestJson} from './shared-laya.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const data=path.resolve(process.env.ROCK_DATA_DIR || path.join(repo,'.rock-data'));
const config=JSON.parse(await readFile(path.join(data,'host.json'),'utf8'));
const certificatePem=await readFile(config.certificatePem,'utf8');
const mode=process.argv[2] || 'status';
const readDevices=async()=>JSON.parse(await readFile(path.join(data,'host-devices.json'),'utf8'));
const localUrl=`https://127.0.0.1:${config.port}`;
if(mode==='pair') {
  const name=process.argv[3],address=process.argv[4];
  if(!name || !/^[a-zA-Z0-9_-]{1,48}$/.test(name))throw new Error('Provide a device name containing letters, digits, _ or -');
  const url=new URL(address);
  if(url.protocol!=='https:' || url.pathname!=='/' || url.username || url.password || url.search || url.hash)throw new Error('Provide the host HTTPS origin');
  const devices=await readDevices();
  if(devices.some(device=>device.name===name))throw new Error('Device exists. Revoke it before issuing a replacement.');
  const token=randomBytes(32).toString('hex');
  devices.push({name,tokenHash:hashToken(token)});
  const output=path.join(data,`${name}.rock-pairing.json`);
  await writeFile(output,JSON.stringify({url:url.origin,token,certificatePem},null,2),{flag:'wx',mode:0o600});
  await writeFile(path.join(data,'host-devices.json'),JSON.stringify(devices,null,2));
  console.log(`Pairing file: ${output}\nTransfer it privately to this device; it contains its access credential.`);
} else if(mode==='revoke') {
  const devices=await readDevices();
  if(!devices.some(device=>device.name===process.argv[3]))throw new Error('Device not found');
  await writeFile(path.join(data,'host-devices.json'),JSON.stringify(devices.filter(device=>device.name!==process.argv[3]),null,2));
  console.log('Device revoked. Already running inference may finish.');
} else if(mode==='stop') {
  const token=(await readFile(path.join(data,'host-control-token'),'utf8')).trim();
  console.log(await requestJson(new URL('/admin/shutdown',localUrl),{token,certificatePem,body:{},timeout:3000}));
} else if(mode==='status') {
  const pairing=JSON.parse(await readFile(path.join(data,'laya-client.json'),'utf8'));
  try{console.log(await requestJson(new URL('/health',localUrl),{...pairing,timeout:2000}));}
  catch(error){console.log(`Laya host offline or loading: ${error.message}. Open Start Laya manually.`);process.exitCode=1;}
} else if(mode==='start') {
  const sidecarToken=randomBytes(32).toString('hex');
  const controlToken=(await readFile(path.join(data,'host-control-token'),'utf8')).trim();
  let child,closing=false,isReady=false;
  const shutdown=()=>{
    if(closing)return;closing=true;isReady=false;
    child?.kill();gateway.close();gateway.closeAllConnections();
  };
  const gateway=createHostGateway({
    tls:{pfx:await readFile(config.pfx),passphrase:(await readFile(config.passwordFile,'utf8')).trim()},
    credentials:readDevices,sidecarToken,sidecarUrl:`http://127.0.0.1:${config.sidecarPort}`,
    controlToken,shutdown,ready:()=>isReady,
  });
  // Reserve the public listener before spawning Python. Sidecar also reserves
  // its own fixed port before loading weights: two launches cannot load duplicates.
  await new Promise((resolve,reject)=>{gateway.once('error',reject);gateway.listen(config.port,'0.0.0.0',resolve);});
  console.log(`Loading Laya. Shared host port: ${config.port}. Ctrl+C or Stop Laya stops the host.`);
  child=spawn(config.python,[path.join(repo,'scripts/laya_sidecar.py'),'--model-dir',config.model,
    '--port',String(config.sidecarPort),'--device',process.env.ROCK_LAYA_DEVICE || config.device || 'auto'],
    {cwd:repo,windowsHide:true,stdio:['ignore','inherit','inherit'],env:{...process.env,POK_LAYA_TOKEN:sidecarToken}});
  child.on('error',error=>{console.error(error.message);process.exitCode=1;shutdown();});
  child.on('exit',code=>{if(!closing){console.error(`Laya exited (${code}). Host stopped; it will not restart automatically.`);process.exitCode=1;}shutdown();});
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);process.on('exit',()=>child?.kill());
  while(!closing && !isReady) {
    try {const health=await requestJson(`http://127.0.0.1:${config.sidecarPort}/health`,{token:sidecarToken,timeout:1500});
      if(health.status==='ready'){isReady=true;console.log(`READY — ${health.device}. PC and laptop share this one model.`);}}
    catch {}
    if(!isReady && !closing)await new Promise(resolve=>setTimeout(resolve,1000));
  }
} else throw new Error('Use start, status, stop, pair <device> <https://host:43129>, or revoke <device>');
