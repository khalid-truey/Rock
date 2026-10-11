// Pure controller with an injectable Chrome API for permission/lifecycle tests.
export function controller(api) {
  const owned = new Set(), shared = new Set(), attached = new Set();
  const attaching = new Map();
  const methods = new Set(['Runtime.evaluate','Page.navigate','Page.captureScreenshot',
    'Input.dispatchMouseEvent','Input.dispatchKeyEvent','Input.insertText']);
  const allowed = id => owned.has(id) || shared.has(id);
  const save = () => api.storage.session.set({owned:[...owned],shared:[...shared]});
  const ready = api.storage.session.get(['owned','shared']).then(s=>{
    (s.owned || []).forEach(id=>owned.add(id)); (s.shared || []).forEach(id=>shared.add(id));
  });
  const webURL = url => {
    if(url === 'about:blank') return url;
    const parsed = new URL(url);
    if(!['http:','https:'].includes(parsed.protocol)) throw new Error('Only normal website tabs can be controlled.');
    return parsed.href;
  };
  async function attach(id) {
    if(!allowed(id)) throw new Error('This tab has not been shared with Rock.');
    const tab = await api.tabs.get(id); webURL(tab.url);
    if(attached.has(id)) return;
    if(!attaching.has(id)) attaching.set(id,api.debugger.attach({tabId:id},'1.3').then(()=>attached.add(id)).finally(()=>attaching.delete(id)));
    await attaching.get(id);
  }
  async function tabs() {
    await ready;
    return (await api.tabs.query({})).filter(t=>allowed(t.id)).map(t=>({id:String(t.id),targetId:String(t.id),type:'page',
      url:t.url || '',title:t.title || '',owned:owned.has(t.id),...(allowed(t.openerTabId)?{openerId:String(t.openerTabId)}:{})}));
  }
  async function revoke(id) {
    owned.delete(id);shared.delete(id);
    if(attached.delete(id))try{await api.debugger.detach({tabId:id});}catch{}
    await save();
  }
  async function share(id) {await ready;webURL((await api.tabs.get(id)).url);shared.add(id);await save();}
  async function command(method,params={},tabId=null) {
    await ready;
    if(tabId===null) {
      if(method==='Target.getTargets')return {targetInfos:await tabs()};
      if(method==='Target.createTarget') {
        const tab=await api.tabs.create({url:webURL(params.url || 'about:blank'),active:false});
        owned.add(tab.id);await save();return {targetId:String(tab.id)};
      }
      if(method==='Target.closeTarget') {
        const id=Number(params.targetId);
        if(!owned.has(id))throw new Error('Rock can close only tabs it created.');
        await api.tabs.remove(id);await revoke(id);return {success:true};
      }
      throw new Error(`Unsupported browser command: ${method}`);
    }
    const id=Number(tabId);
    if(!Number.isInteger(id)||!allowed(id))throw new Error('This tab has not been shared with Rock.');
    if(!methods.has(method))throw new Error(`Unsupported page command: ${method}`);
    if(method==='Page.navigate') {
      if(!owned.has(id))throw new Error('Open a Rock-owned tab before navigating; shared user tabs are not replaced.');
      webURL(params.url);
    }
    await attach(id);
    return api.debugger.sendCommand({tabId:id},method,params);
  }
  async function disconnect() {
    await ready;
    for(const id of new Set([...owned,...shared]))await revoke(id);
  }
  // A new tab opened by an authorized page belongs to that same workflow.
  api.tabs.onCreated.addListener(async t=>{await ready;if(allowed(t.openerTabId)){owned.add(t.id);await save();}});
  api.tabs.onRemoved.addListener(id=>{revoke(id).catch(()=>{});});
  api.debugger.onDetach.addListener(({tabId},reason)=>{
    attached.delete(tabId);
    if(reason==='canceled_by_user'){owned.delete(tabId);shared.delete(tabId);save();}
  });
  return {tabs,share,revoke,command,disconnect};
}
