"""Exercise Rock's headless browser without any desktop mouse/keyboard input."""
import ctypes
import http.server
import json
from pathlib import Path
import subprocess
import threading

repo = Path(__file__).resolve().parents[2]
page = b'''<!doctype html><title>Rock browser test</title>
<h1>Background browser test</h1><label>Name <input id="name"></label>
<label>Color <select id="color" aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select></label>
<button id="verify" onclick="document.getElementById('result').textContent='VERIFIED '+document.getElementById('name').value+' '+document.getElementById('color').value">Verify</button>
<p id="result">READY</p><div style="height:2000px"></div><p>Page bottom</p>'''

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(page)
    def log_message(self, *args): pass

server = http.server.ThreadingHTTPServer(('127.0.0.1',0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
process = subprocess.Popen(['node',str(Path(__file__).with_name('runtime.mjs')),'mcp'],cwd=repo,
    stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
seq = 0
def rpc(method, params={}):
    global seq
    seq += 1
    process.stdin.write(json.dumps({'jsonrpc':'2.0','id':seq,'method':method,'params':params})+'\n'); process.stdin.flush()
    while True:
        line=process.stdout.readline()
        if not line: raise RuntimeError('Rock exited')
        message=json.loads(line)
        if message.get('id') == seq:
            if 'error' in message: raise RuntimeError(message['error'])
            return message['result']
def call(name,args={}):
    result=rpc('tools/call',{'name':'rock_'+name,'arguments':args})
    if result.get('isError'): raise RuntimeError(result['content'][0]['text'])
    return json.loads(result['content'][0]['text'])
def target(snapshot,label):
    return next(e['id'] for e in snapshot['elements'] if e['name']==label and e['actionable'])

try:
    init=rpc('initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'rock-browser-test','version':'1'}})
    assert init['serverInfo']['name']=='rock'
    tools=rpc('tools/list')['tools']
    assert len(tools)==33, len(tools)
    assert all(t['name'].startswith('rock_') for t in tools)
    foreground_before=ctypes.windll.user32.GetForegroundWindow()
    snapshot=call('managed_browser_open',{'url':f'http://127.0.0.1:{server.server_port}/'})
    snapshot=call('managed_browser_type',{'snapshot_id':snapshot['snapshot_id'],'target_id':target(snapshot,'Name'),'value':'Rock'})
    snapshot=call('managed_browser_select',{'snapshot_id':snapshot['snapshot_id'],'target_id':target(snapshot,'Color'),'value':'blue'})
    result=call('fast_actions',{'goal':'Click Verify in the background browser', 'target_hint':'button "Verify"',
        'done_when':'text "VERIFIED Rock blue" is visible','allowed_operations':['browser_click'],'max_steps':2})
    snapshot=call('managed_browser_snapshot')
    assert 'VERIFIED Rock blue' in snapshot['text'], (result,snapshot['text'])
    foreground_after=ctypes.windll.user32.GetForegroundWindow()
    assert foreground_before==foreground_after, 'Foreground window changed during background test'
    print('PASS: 33 Rock tools; headless navigation, typing, dropdown selection, Laya click plan, page verification; foreground unchanged',flush=True)
    # Old page snapshots must not be accepted for subsequent browser input.
    stale=rpc('tools/call',{'name':'rock_managed_browser_click','arguments':{'snapshot_id':'stale','target_id':target(snapshot,'Verify')}})
    assert stale['isError']
    status=call('user_browser_status')
    (repo.parent/'data/rock-browser-verification.json').write_text(json.dumps({
        'foreground_unchanged':True,'page_text':snapshot['text'],'plan_status':result.get('status'),
        'tools':len(tools),'signed_in_browser_status':status},indent=2))
    print('PASS: stale-action rejection and signed-in browser status',flush=True)
finally:
    process.stdin.close()
    try: process.wait(timeout=5)
    except subprocess.TimeoutExpired: process.terminate()
    server.shutdown()
