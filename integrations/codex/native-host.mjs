// Chrome native messaging <-> the CDP subset used by POK's user_browser tools.
// stdout is exclusively the length-framed native protocol, never log output.
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {readFileSync} from 'node:fs';
const registration=JSON.parse(readFileSync(new URL('./chrome-native-host.json',import.meta.url),'utf8'));
if(!registration.allowed_origins.includes(process.argv[2]))process.exit(1);
const port=9222, pending=new Map();let sequence=0, buffer=Buffer.alloc(0);
function send(value) {
  const bytes=Buffer.from(JSON.stringify(value));
  if(bytes.length>1024*1024)throw new Error('Native message exceeds 1 MiB');
  const header=Buffer.alloc(4);header.writeUInt32LE(bytes.length);process.stdout.write(Buffer.concat([header,bytes]));
}
function command(method,params={},tabId=null) {
  return new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Chrome extension did not answer in time'));},15000);
    pending.set(id,{resolve,reject,timer});send({kind:'command',id,method,params,tabId});
  });
}
process.stdin.on('data',data=>{
  buffer=Buffer.concat([buffer,data]);
  while(buffer.length>=4){const size=buffer.readUInt32LE(0);if(size>32*1024*1024)process.exit(1);if(buffer.length<size+4)return;
    let message;try{message=JSON.parse(buffer.subarray(4,4+size).toString());}catch{process.exit(1);}
    buffer=buffer.subarray(4+size);
    const item=pending.get(message.id);if(!item)continue;pending.delete(message.id);clearTimeout(item.timer);
    message.error?item.reject(new Error(message.error)):item.resolve(message.result);
  }
});
const trusted=req=>!req.headers.origin && req.headers.host===`127.0.0.1:${port}`;
const server=createServer(async(req,res)=>{
  const reply=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  if(!trusted(req))return reply(403,{error:'Local CDP clients only'});
  try{
    if(req.url==='/json/version')return reply(200,{Browser:'Chrome/Rock extension','Protocol-Version':'1.3',webSocketDebuggerUrl:`ws://127.0.0.1:${port}/devtools/browser/rock`});
    if(req.url==='/json/list'||req.url==='/json'){
      const result=await command('Target.getTargets');
      return reply(200,result.targetInfos.map(t=>({...t,id:t.targetId,webSocketDebuggerUrl:`ws://127.0.0.1:${port}/devtools/page/${t.targetId}`})));
    }
    const close=req.url?.match(/^\/json\/close\/(\d+)$/);
    if(close)return reply(200,await command('Target.closeTarget',{targetId:close[1]}));
    reply(404,{error:'Unknown route'});
  }catch(e){reply(502,{error:e.message});}
});
const ws=new WebSocketServer({noServer:true,maxPayload:1024*1024});
server.on('upgrade',(req,socket,head)=>{
  if(!trusted(req)||!/^\/devtools\/(browser\/rock|page\/\d+)$/.test(req.url||'')){socket.destroy();return;}
  ws.handleUpgrade(req,socket,head,client=>ws.emit('connection',client,req));
});
ws.on('connection',(client,req)=>{
  const tabId=req.url.match(/\/page\/(\d+)$/)?.[1] ?? null;
  client.on('message',async bytes=>{
    let message;try{message=JSON.parse(bytes.toString());if(message.id===undefined)throw new Error('Request ID required');
      const result=await command(message.method,message.params||{},tabId);
      if(client.readyState===1)client.send(JSON.stringify({id:message.id,result}));
    }catch(e){if(client.readyState===1)client.send(JSON.stringify({id:message?.id ?? null,error:{code:-32000,message:e.message}}));}
  });
});
server.on('error',e=>{send({kind:'status',error:`Rock browser bridge: ${e.message}`});setTimeout(()=>process.exit(1),50);});
server.listen(port,'127.0.0.1',()=>send({kind:'status',connected:true}));
process.stdin.on('end',()=>{for(const c of ws.clients)c.close();server.close();process.exit(0);});
