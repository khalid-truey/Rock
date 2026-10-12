"""A live extension test: creates, uses and closes only its own local test tab."""
import ctypes
import http.server
import json
import os
from pathlib import Path
import subprocess
import threading

repo=Path(__file__).resolve().parents[2]
class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body=b'''<!doctype html><title>Rock Chrome background test</title>
<h1>Rock background test</h1><label>Name <input id="name" aria-label="Name"></label>
<button onclick="document.getElementById('result').textContent='VERIFIED '+document.getElementById('name').value">Verify</button><p id="result">READY</p>'''
        self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(body)
    def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Page)
threading.Thread(target=server.serve_forever,daemon=True).start()
p=subprocess.Popen(['node',str(Path(__file__).with_name('runtime.mjs')),'mcp'],cwd=repo,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
sequence=0
def request(method,params):
    global sequence
    sequence+=1;p.stdin.write(json.dumps({'jsonrpc':'2.0','id':sequence,'method':method,'params':params})+'\n');p.stdin.flush()
    while True:
        line=p.stdout.readline()
        if not line:raise RuntimeError('Rock disconnected')
        m=json.loads(line)
        if m.get('id')==sequence:
            if 'error' in m:raise RuntimeError(m['error'])
            return m['result']
def call(name,args={}):
    r=request('tools/call',{'name':'rock_'+name,'arguments':args})
    if r.get('isError'):raise RuntimeError(r['content'][0]['text'])
    return json.loads(r['content'][0]['text'])
tab_id=None
try:
    request('initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'rock-chrome-live-test','version':'1'}})
    status=call('user_browser_status');assert status['connected'],status
    assert 'Rock extension' in status['browser'],status
    foreground=ctypes.windll.user32.GetForegroundWindow()
    opened=call('user_browser_navigate',{'url':f'http://127.0.0.1:{server.server_port}/'})
    tab_id=opened['tab']['tab_id']
    call('user_browser_type',{'target':'Name','text':'Rock in my Chrome'})
    result=call('fast_actions',{'goal':'Click Verify in the Chrome test tab','target_hint':'button "Verify"',
        'done_when':'text "VERIFIED Rock in my Chrome" is visible','allowed_operations':['user_browser_click'],'max_steps':2})
    page=call('user_browser_extract')
    assert 'VERIFIED Rock in my Chrome' in json.dumps(page),page
    unchanged=foreground==ctypes.windll.user32.GetForegroundWindow()
    report={'browser':status['browser'],'verified':True,'foreground_unchanged_during_test':unchanged,'plan_status':result.get('status')}
    output_dir = Path(os.environ.get('ROCK_DATA_DIR', repo / '.rock-data'))
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir/'rock-chrome-verification.json').write_text(json.dumps(report,indent=2))
    print('PASS:',json.dumps(report),flush=True)
finally:
    if tab_id:
        try:call('user_browser_tabs',{'action':'close','tab_id':tab_id})
        except Exception as error:print('Test tab could not be closed:',error)
    p.stdin.close()
    try:p.wait(timeout=5)
    except subprocess.TimeoutExpired:p.terminate()
    server.shutdown()
