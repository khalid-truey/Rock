// The only network boundary for shared inference. Desktop/browser tools remain local.
import http from 'node:http';
import https from 'node:https';
import {timingSafeEqual, createHash, X509Certificate} from 'node:crypto';
import {readFile} from 'node:fs/promises';

export const hashToken = token => createHash('sha256').update(token).digest('hex');
export function sameSecret(a, b) {
  const x=Buffer.from(a || ''), y=Buffer.from(b || '');
  return x.length===y.length && timingSafeEqual(x,y);
}
export function reply(res, code, value) {
  if(res.destroyed)return;
  res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});
  res.end(JSON.stringify(value));
}
export async function bodyJson(req, limit=2*1024*1024) {
  const chunks=[];let length=0;
  for await(const chunk of req) {
    length+=chunk.length;
    if(length>limit)throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function validatePairing(config) {
  const url=new URL(config.url);
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)
    throw new Error('Laya host must be an HTTPS origin, for example https://192.168.1.100:43129');
  if(typeof config.token!=='string' || config.token.length<32)throw new Error('Missing Laya device credential');
  new X509Certificate(config.certificatePem);
  return config;
}
export async function loadPairing(file) {
  return validatePairing(JSON.parse(await readFile(file,'utf8')));
}
export function requestJson(url, {token, certificatePem, body, timeout=25000, signal}={}) {
  const target=new URL(url);
  if(target.protocol!=='https:' && !(target.protocol==='http:' && target.hostname==='127.0.0.1'))
    throw new Error('Plain HTTP is allowed only for the local sidecar');
  const payload=body===undefined ? undefined : Buffer.from(JSON.stringify(body));
  const tls=certificatePem ? {
    ca:certificatePem, rejectUnauthorized:true,
    // Pairing pins the host certificate, allowing a reserved LAN IP or hostname.
    // Chain validation remains enabled; unrelated certificates are never trusted.
    checkServerIdentity:(_host, cert)=>sameSecret(cert.fingerprint256,new X509Certificate(certificatePem).fingerprint256)
      ? undefined : new Error('Laya host certificate does not match pairing'),
  } : {};
  return new Promise((resolve,reject)=>{
    const controller=new AbortController();
    const abort=()=>controller.abort();
    const timer=setTimeout(abort,timeout);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    const req=(target.protocol==='https:'?https:http).request(target,{
      ...tls,method:payload?'POST':'GET',signal:controller.signal,
      headers:{Authorization:`Bearer ${token}`,...(payload?{'Content-Type':'application/json','Content-Length':payload.length}:{})},
    },res=>{
      const chunks=[];let length=0;
      res.on('data',chunk=>{length+=chunk.length;if(length>4*1024*1024)res.destroy(new Error('Response too large'));else chunks.push(chunk);});
      res.on('error',error=>{finish();reject(error);});
      res.on('end',()=>{
        finish();
        try {
          const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if(res.statusCode<200 || res.statusCode>=300)throw new Error(value.error?.message || value.detail || `Laya HTTP ${res.statusCode}`);
          resolve(value);
        }catch(error){reject(error);}
      });
    });
    req.on('error',error=>{finish();reject(error);});
    req.end(payload);
  });
}

// No retries: a timed-out decision must not be replayed after the screen changes.
export function createLayaProxy({token, pairingFile, timeout=25000}) {
  return http.createServer(async(req,res)=>{
    if(req.headers.origin || !sameSecret(req.headers.authorization,`Bearer ${token}`))return reply(res,401,{error:{message:'Local authentication required'}});
    if(!((req.method==='GET' && req.url==='/health') || (req.method==='POST' && req.url==='/v1/systemone')))
      return reply(res,404,{error:{message:'Unknown route'}});
    const controller=new AbortController();
    res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try {
      const config=await loadPairing(pairingFile);
      const body=req.method==='POST'?await bodyJson(req):undefined;
      const result=await requestJson(new URL(req.url,config.url),{...config,body,timeout:req.method==='GET'?2000:timeout,signal:controller.signal});
      reply(res,200,result);
    }catch(error){
      reply(res,503,{status:'offline',error:{message:`Laya host unavailable: ${error.message}. Manually open Start Laya on the host PC. No action is automatically resumed.`}});
    }
  });
}

// A bounded FIFO queue shared by all devices. Expired/disconnected jobs never run.
export function createDecisionQueue({limit=8, timeout=25000}={}) {
  const jobs=[];let running=false;
  const drain=async()=>{
    if(running)return;
    const job=jobs.shift();if(!job)return;
    if(job.signal?.aborted || Date.now()>=job.deadline){job.reject(new Error('Decision cancelled or expired in queue'));return drain();}
    running=true;
    try{job.resolve(await job.work(job.deadline-Date.now()));}catch(error){job.reject(error);}
    finally{running=false;drain();}
  };
  return {
    run(work,signal){
      if(jobs.length>=limit)return Promise.reject(new Error('Laya is busy; queue is full'));
      return new Promise((resolve,reject)=>{jobs.push({work,signal,resolve,reject,deadline:Date.now()+timeout});drain();});
    },
    get pending(){return jobs.length;},
  };
}

export function createHostGateway({tls, credentials, sidecarToken, sidecarUrl, controlToken, shutdown, ready=()=>true, queue=createDecisionQueue()}) {
  return https.createServer(tls,async(req,res)=>{
    if(req.headers.origin)return reply(res,403,{error:{message:'Browser-origin requests are not allowed'}});
    const supplied=(req.headers.authorization || '').replace(/^Bearer /,'');
    const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if(req.url==='/admin/shutdown' && req.method==='POST') {
      if(!local || !sameSecret(supplied,controlToken))return reply(res,403,{error:{message:'Host-local control required'}});
      reply(res,200,{stopping:true});setImmediate(shutdown);return;
    }
    try {
      const allowed=await credentials();
      if(!allowed.some(device=>sameSecret(device.tokenHash,hashToken(supplied))))return reply(res,401,{error:{message:'Invalid or revoked device credential'}});
      if(!((req.method==='GET' && req.url==='/health') || (req.method==='POST' && req.url==='/v1/systemone')))
        return reply(res,404,{error:{message:'Unknown route'}});
      if(!ready())return reply(res,503,{status:'loading',error:{message:'Laya is loading'}});
      const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
      if(req.method==='GET') {
        const health=await requestJson(new URL('/health',sidecarUrl),{token:sidecarToken,timeout:2000});
        return reply(res,200,{...health,shared:true,queued_requests:queue.pending});
      }
      const body=await bodyJson(req);
      if(!body || typeof body.questions!=='object' || body.questions===null || typeof body.model!=='string' || body.state===undefined)
        return reply(res,400,{error:{message:'Expected model, state and questions'}});
      const result=await queue.run(timeout=>requestJson(new URL('/v1/systemone',sidecarUrl),{token:sidecarToken,body,timeout,signal:controller.signal}),controller.signal);
      reply(res,200,result);
    }catch(error){reply(res,503,{error:{message:error.message}});}
  });
}
