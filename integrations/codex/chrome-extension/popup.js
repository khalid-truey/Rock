async function update(action='status') {
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const state=await chrome.runtime.sendMessage({action,tabId:tab?.id});
  document.getElementById('status').textContent=state.error || (state.connected?'Connected to Rock on this PC':'Disconnected');
  document.getElementById('tabs').replaceChildren(...state.tabs.map(t=>{
    const li=document.createElement('li');li.textContent=(t.owned?'Rock: ':'Shared: ')+(t.title||t.url);return li;
  }));
}
for(const name of ['connect','share','revoke','disconnect'])document.getElementById(name).onclick=()=>update(name).catch(e=>document.getElementById('status').textContent=e.message);
update().catch(e=>document.getElementById('status').textContent=e.message);
