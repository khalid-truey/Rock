import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan, writeCompletion, bundledCodex } from './planner.mjs';
import { createLayaProxy } from './shared-laya.mjs';
import { existsSync } from 'node:fs';

const file = fileURLToPath(import.meta.url);
export const repo = path.resolve(path.dirname(file),'../..');
export const root = path.dirname(repo);
export const data = path.resolve(process.env.ROCK_DATA_DIR || path.join(repo,'.rock-data'));
const runtimePort = Number(process.env.ROCK_RUNTIME_PORT || 43128);
const proxyPort = Number(process.env.ROCK_LAYA_PROXY_PORT || 43126);
const base = `http://127.0.0.1:${runtimePort}`;
const layaBase = `http://127.0.0.1:${proxyPort}`;
const bin = process.env.ROCK_BIN_DIR || (existsSync(path.join(repo,'bin/rock.exe')) ? path.join(repo,'bin') : path.join(repo,'target/debug'));
const secretFile = path.join(data,'local-runtime-token');
const sleep = ms => new Promise(r=>setTimeout(r,ms));

export async function secret() {
  await mkdir(data,{recursive:true});
  try { return (await readFile(secretFile,'utf8')).trim(); } catch(e) { if(e.code!=='ENOENT') throw e; }
  const token = randomBytes(32).toString('hex');
  try { await writeFile(secretFile, token, {flag:'wx',mode:0o600}); return token; }
  catch(e) { if(e.code==='EEXIST') return (await readFile(secretFile,'utf8')).trim(); throw e; }
}
export async function status(token, url = base) {
  const res = await fetch(url+'/health',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(2000)});
  if (!res.ok) throw new Error(`${url} health: ${res.status}`);
  return res.json();
}
export async function ensureRuntime() {
  const token = await secret();
  try { const s = await status(token); if(s.mode==='shared-laya-client') return token; } catch {}
  const out = await open(path.join(data,'runtime.log'),'a');
  const child = spawn(process.execPath,[file,'daemon'],{cwd:repo,detached:true,windowsHide:true,stdio:['ignore',out.fd,out.fd]});
  child.unref(); await out.close();
  for(let n=0;n<20;n++) {
    await sleep(1000);
    try { const s = await status(token); if(s.mode==='shared-laya-client') return token; } catch {}
  }
  throw new Error(`Local runtime did not start. Check ${path.join(data,'runtime.log')}`);
}
async function daemon() {
  const token = await secret();
  let closing = false;
  const proxy = createLayaProxy({token,pairingFile:path.join(data,'laya-client.json')});
  const plannerControllers = new Set();
  const shutdown = () => { if(closing)return; closing=true; for(const c of plannerControllers)c.abort(); proxy.close(); proxy.closeAllConnections(); server.close(); setTimeout(()=>process.exit(0),1000).unref(); };
  const authorized = req => {
    const supplied=Buffer.from(req.headers.authorization || ''); const expected=Buffer.from(`Bearer ${token}`);
    return !req.headers.origin && supplied.length===expected.length && timingSafeEqual(supplied,expected);
  };
  const server = createServer(async(req,res)=>{
    const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(!authorized(req))return json(401,{error:{message:'Local runtime authentication required'}});
    try {
      if(req.url==='/health') {
        let health; try {health=await status(token,layaBase);}catch{health={status:'offline',message:'Manually open Start Laya on the host PC. Basic MCP tools remain available.'};}
        return json(200,{service:'pok-local-runtime',mode:'shared-laya-client',laya:health,planner:'codex-app-server',active_planner_requests:plannerControllers.size});
      }
      if(req.url==='/shutdown' && req.method==='POST') {json(200,{stopping:true});shutdown();return;}
      if(req.url==='/v1/models') return json(200,{object:'list',data:[{id:'codex-default',object:'model',owned_by:'codex',
        capabilities:{vision:true,tool_use:true},architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools']}]});
      if(req.url!=='/v1/chat/completions'||req.method!=='POST')return json(404,{error:{message:'Not found'}});
      if(plannerControllers.size>=4)return json(429,{error:{message:'Planner busy; at most four requests at a time'}});
      const chunks=[];let size=0;
      for await(const chunk of req) {size+=chunk.length;if(size>32*1024*1024)return json(413,{error:{message:'Request too large'}});chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const controller=new AbortController();plannerControllers.add(controller);
      res.on('close',()=>{if(!res.writableEnded)controller.abort();});
      try {
        const result=await plan(body,{executable:process.env.POK_CODEX_BIN || bundledCodex,cwd:path.join(data,'planner-workspace'),signal:controller.signal});
        if(!res.destroyed)writeCompletion(res,result,body.stream===true);
      } finally {plannerControllers.delete(controller);}
    }catch(e){if(!res.headersSent&&!res.destroyed)json(502,{error:{message:e.message,type:'codex_planner_error'}});}
  });
  server.on('error',e=>{console.error(e.message);process.exit(1);});
  // This process never starts Python, even when the host is offline.
  proxy.on('error',e=>{console.error(e.message);shutdown();process.exitCode=1;});
  await new Promise(resolve=>proxy.listen(proxyPort,'127.0.0.1',resolve));
  await new Promise(resolve=>server.listen(runtimePort,'127.0.0.1',resolve));
  await writeFile(path.join(data,'runtime.pid'),String(process.pid));
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
async function main() {
  const mode=process.argv[2] || 'status';
  if(mode==='daemon')return daemon();
  if(mode==='stop') {const token=await secret();const r=await fetch(base+'/shutdown',{method:'POST',headers:{Authorization:`Bearer ${token}`}});console.log(await r.text());return;}
  if(mode==='status') {
    const token=await secret();
    try { console.log(JSON.stringify(await status(token),null,2)); }
    catch { console.log(JSON.stringify({service:'pok-local-runtime',status:'stopped',message:'Local MCP bridge is stopped. This check did not start Laya.'},null,2)); }
    return;
  }
  const token=await ensureRuntime();
  if(mode==='start') {console.log(JSON.stringify(await status(token),null,2));return;}
  const env={...process.env,POK_LAYA_TOKEN:token,POK_CODEX_BRIDGE_TOKEN:token,POK_LAYA_EXTERNAL:'1',ROCK_LAYA_HEALTH_URL:layaBase+'/health'};
  if(mode==='mcp') {
    // Each MCP process has its own anonymous browser profile and pages. The
    // signed-in Rock Browser profile is separate and persists across clients.
    env.POK_AI_BROWSER_HEADLESS='1';
    env.ROCK_CHROME_EXTENSION_DIR=path.join(path.dirname(file),'chrome-extension');
    env.POK_AI_BROWSER_PROFILE=path.join(data,'browser/profiles',`rock-background-${process.pid}`);
    const child=spawn(path.join(bin,'rock.exe'),['--config',path.join(repo,'pok-ai.toml'),'mcp','--workspace',repo],{cwd:repo,env,windowsHide:true,stdio:['pipe','pipe','inherit']});
    process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);
    process.stdin.on('end',()=>child.kill());process.on('SIGTERM',()=>child.kill());
    child.on('error',e=>{console.error(e.message);process.exit(1);});child.on('exit',code=>process.exit(code??1));
    return;
  }
  if(mode==='desktop') {
    const child=spawn(path.join(bin,'pok-ai-desktop.exe'),[],{cwd:repo,env,windowsHide:true,stdio:'ignore',detached:true});child.unref();return;
  }
  if(mode==='run') {
    const child=spawn(path.join(bin,'pok-ai.exe'),['--config',path.join(repo,'pok-ai.toml'),'run',...process.argv.slice(3)],{cwd:repo,env,windowsHide:true,stdio:'inherit'});
    child.on('exit',code=>process.exit(code??1));return;
  }
  throw new Error(`Unknown mode ${mode}`);
}
if(process.argv[1] && path.resolve(process.argv[1])===file)main().catch(e=>{console.error(e.message);process.exitCode=1;});
