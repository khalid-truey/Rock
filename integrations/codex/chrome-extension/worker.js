import {controller} from './controller.js';
const control=controller(chrome);
let port=null, error='';
function connect() {
  if(port)return;
  error='';
  const current=chrome.runtime.connectNative('com.rock.browser');port=current;
  current.onMessage.addListener(async message=>{
    if(message.kind==='status'){error=message.error || '';return;}
    if(message.kind!=='command')return;
    try {
      const result=await control.command(message.method,message.params,message.tabId ?? null);
      if(port===current)current.postMessage({kind:'response',id:message.id,result});
    }catch(e){if(port===current)current.postMessage({kind:'response',id:message.id,error:e.message});}
  });
  current.onDisconnect.addListener(()=>{if(port===current){error=chrome.runtime.lastError?.message || 'Rock disconnected';port=null;control.disconnect();}});
  chrome.storage.local.set({enabled:true});
}
chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
  (async()=>{
    if(message.action==='connect')connect();
    if(message.action==='disconnect') {
      await chrome.storage.local.set({enabled:false});const old=port;port=null;old?.disconnect();await control.disconnect();error='';
    }
    if(message.action==='share'){if(!port)connect();await control.share(message.tabId);}
    if(message.action==='revoke')await control.revoke(message.tabId);
    return {connected:!!port,error,tabs:await control.tabs()};
  })().then(reply,e=>reply({connected:!!port,error:e.message,tabs:[]}));
  return true;
});
chrome.runtime.onInstalled.addListener(()=>connect());
chrome.runtime.onStartup.addListener(async()=>{if((await chrome.storage.local.get('enabled')).enabled!==false)connect();});
