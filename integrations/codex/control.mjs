// Small UI adapter. Status is read-only; only an explicit Start action launches Laya.
import {readFile,open,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadPairing,requestJson} from './shared-laya.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const data=path.resolve(process.env.ROCK_DATA_DIR || path.join(repo,'.rock-data'));
const action=process.argv[2] || 'status';
async function hostStatus() {
  let pairing;
  try {pairing=await loadPairing(path.join(data,'laya-client.json'));}
  catch {return {status:'not configured',message:'Run Rock Host or Laptop setup first.'};}
  try {
    const health=await requestJson(new URL('/health',pairing.url),{...pairing,timeout:2000});
    return {status:health.status,device:health.device || '',message:`${health.device || 'Laya'} · ${health.queued_requests || 0} queued requests`};
  } catch(error) {
    if(/loading/i.test(error.message))return {status:'loading',message:'Loading the model. Please wait for Ready.'};
    if(/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|abort/i.test(error.message))
      return {status:'offline',message:'Laya is off or the host PC is unreachable. Start it manually on the host PC.'};
    return {status:'error',message:error.message};
  }
}
async function rockStatus() {
  try {
    const token=(await readFile(path.join(data,'local-runtime-token'),'utf8')).trim();
    const value=await requestJson('http://127.0.0.1:43128/health',{token,timeout:3000});
    if(value.mode!=='shared-laya-client')return {status:'error',message:'An older Rock bridge is using port 43128.'};
    return {status:'running',message:'Local MCP bridge is connected. Laya: '+value.laya?.status};
  } catch {return {status:'stopped',message:'The local bridge starts when your MCP client connects.'};}
}
try {
  let canControlHost=false;
  try {await access(path.join(data,'host.json'));canControlHost=true;}catch{}
  let message='';
  if(action==='start') {
    if(!canControlHost)throw new Error('This is a laptop client. Start Laya on the host PC.');
    const current=await hostStatus();
    if(current.status==='ready' || current.status==='loading')message='Laya is already '+current.status+'.';
    else if(current.status!=='offline')throw new Error(current.message);
    else {
      const stdout=await open(path.join(data,'host-console.log'),'a');
      const stderr=await open(path.join(data,'host-console-error.log'),'a');
      try {
        const child=spawn(process.execPath,[path.join(repo,'integrations/codex/laya-host.mjs'),'start'],{
          cwd:repo,detached:true,windowsHide:true,stdio:['ignore',stdout.fd,stderr.fd],env:process.env,
        });
        await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
        child.unref();message='Start requested. Loading may take a minute; the status will refresh.';
      } finally {await stdout.close();await stderr.close();}
    }
  } else if(action==='stop') {
    if(!canControlHost)throw new Error('Only the host PC can stop Laya.');
    const host=JSON.parse(await readFile(path.join(data,'host.json'),'utf8'));
    const token=(await readFile(path.join(data,'host-control-token'),'utf8')).trim();
    const certificatePem=await readFile(host.certificatePem,'utf8');
    try {
      await requestJson(`https://127.0.0.1:${host.port}/admin/shutdown`,{token,certificatePem,body:{},timeout:3000});
      message='Stop requested. Both computers will lose Laya until you start it again.';
    } catch(error) {if(error.code==='ECONNREFUSED')message='Laya is already stopped.';else throw error;}
  } else if(!['status','host-status','rock-status'].includes(action))throw new Error('Unknown control action');
  const [host,rock]=await Promise.all([hostStatus(),rockStatus()]);
  console.log(JSON.stringify({ok:true,canControlHost,hostStatus:host.status,hostMessage:host.message,device:host.device || '',rockStatus:rock.status,rockMessage:rock.message,message}));
} catch(error) {console.log(JSON.stringify({ok:false,message:error.message}));process.exitCode=1;}
