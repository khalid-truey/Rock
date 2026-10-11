import test from 'node:test';
import assert from 'node:assert/strict';
import {controller} from './chrome-extension/controller.js';
function mock() {
  const events={created:[],removed:[],detach:[]}; const all=[{id:1,url:'https://example.com/',title:'Private tab'}];let next=2;
  const calls=[];
  const api={storage:{session:{get:async()=>({}),set:async()=>{}}},tabs:{
    query:async()=>all,get:async id=>{const t=all.find(t=>t.id===id);if(!t)throw new Error('No tab');return t;},
    create:async options=>{calls.push(['create',options]);const t={id:next++,...options,title:'Rock'};all.push(t);return t;},
    remove:async id=>{calls.push(['remove',id]);all.splice(all.findIndex(t=>t.id===id),1);},
    onCreated:{addListener:f=>events.created.push(f)},onRemoved:{addListener:f=>events.removed.push(f)}},
    debugger:{attach:async target=>{calls.push(['attach',target]);},detach:async()=>{},
      sendCommand:async(target,method,params)=>{calls.push(['command',target,method,params]);return {ok:true};},
      onDetach:{addListener:f=>events.detach.push(f)}}};
  return {api,calls,events};
}
test('private tabs cannot be listed or controlled until shared',async()=>{
  const {api}=mock();const c=controller(api);assert.deepEqual(await c.tabs(),[]);
  await assert.rejects(c.command('Runtime.evaluate',{expression:'1'},'1'),/not been shared/);
  await c.share(1);assert.equal((await c.tabs())[0].id,'1');assert.deepEqual(await c.command('Runtime.evaluate',{},'1'),{ok:true});
});
test('agent tabs open in background; user tabs cannot be replaced or closed',async()=>{
  const {api,calls}=mock();const c=controller(api);await c.share(1);
  await assert.rejects(c.command('Page.navigate',{url:'https://example.org'},'1'),/not replaced/);
  await assert.rejects(c.command('Target.closeTarget',{targetId:'1'}),/only tabs it created/);
  const tab=await c.command('Target.createTarget',{url:'about:blank',background:false});
  assert.equal(calls[0][1].active,false);
  await c.command('Page.navigate',{url:'https://example.org'},tab.targetId);
  await c.command('Target.closeTarget',{targetId:tab.targetId});
});
test('revocation and user cancellation prevent reattachment',async()=>{
  const {api,events}=mock();const c=controller(api);await c.share(1);await c.command('Runtime.evaluate',{},'1');
  events.detach[0]({tabId:1},'canceled_by_user');
  await assert.rejects(c.command('Runtime.evaluate',{},'1'),/not been shared/);
  await c.share(1);await c.disconnect();assert.deepEqual(await c.tabs(),[]);
});
test('restricted URLs and unrelated CDP methods are rejected',async()=>{
  const {api}=mock();const c=controller(api);
  await assert.rejects(c.command('Target.createTarget',{url:'file:///C:/private'}),/normal website/);
  await c.share(1);
  await assert.rejects(c.command('Network.getAllCookies',{},'1'),/Unsupported page/);
  await assert.rejects(c.command('Page.bringToFront',{},'1'),/Unsupported page/);
});
