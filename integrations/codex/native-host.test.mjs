import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {WebSocket} from 'ws';

test('native Windows launcher bridges framed messages and CDP, rejects web origins',async()=>{
  const registration=JSON.parse(await readFile(new URL('./chrome-native-host.json',import.meta.url),'utf8'));
  const child=spawn(registration.path,[registration.allowed_origins[0]],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,ROCK_CHROME_BRIDGE_PORT:'0'}});
  let buffer=Buffer.alloc(0);const received=[];
  const ready=new Promise((resolve,reject)=>{
    child.on('error',reject);child.on('exit',code=>reject(new Error(`Host exited: ${code}`)));
    child.stdout.on('data',bytes=>{
      buffer=Buffer.concat([buffer,bytes]);
      while(buffer.length>=4){const n=buffer.readUInt32LE();if(buffer.length<n+4)return;const m=JSON.parse(buffer.subarray(4,n+4));buffer=buffer.subarray(n+4);
        if(m.kind==='status'){m.error?reject(new Error(m.error)):resolve(m.port);continue;}
        received.push(m);
        const result=m.method==='Target.getTargets'?{targetInfos:[{targetId:'7',type:'page',title:'Shared test',url:'https://example.com'}]}:
          m.method==='Target.createTarget'?{targetId:'8'}:{result:{value:'Rock ✓'}};
        const data=Buffer.from(JSON.stringify({kind:'response',id:m.id,result}));const header=Buffer.alloc(4);header.writeUInt32LE(data.length);
        // Fragmented native frames exercise partial header/body handling.
        child.stdin.write(header.subarray(0,2));child.stdin.write(Buffer.concat([header.subarray(2),data]));
      }
    });
  });
  let client;
  try{
    const port=await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Startup timed out')),10000).unref())]);
    const base=`http://127.0.0.1:${port}`;
    assert.equal((await fetch(base+'/json/version',{headers:{Origin:'https://evil.example'}})).status,403);
    const tabs=await (await fetch(base+'/json/list')).json();assert.equal(tabs[0].id,'7');
    client=new WebSocket(tabs[0].webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{client.once('open',resolve);client.once('error',reject);});
    const response=new Promise(resolve=>client.once('message',bytes=>resolve(JSON.parse(bytes))));
    client.send(JSON.stringify({id:42,method:'Runtime.evaluate',params:{expression:'1'}}));
    assert.equal((await response).result.result.value,'Rock ✓');
    assert.equal(received.at(-1).tabId,'7');
    // Persistent clients send more than one request through the same socket.
    const second=new Promise(resolve=>client.once('message',bytes=>resolve(JSON.parse(bytes))));
    client.send(JSON.stringify({id:43,method:'Runtime.evaluate',params:{expression:'2'}}));
    assert.equal((await second).id,43);
  }finally{client?.close();child.stdin.end();setTimeout(()=>child.kill(),1000).unref();}
});
