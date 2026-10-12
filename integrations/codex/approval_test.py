"""Live MCP approval contract check against a local, disposable Send button.

Never sends an external message. Needs the Rock Chrome extension connected.
The test client supplies synthetic approval responses only for its own fixture.
"""
import argparse
import http.server
import json
from pathlib import Path
import queue
import subprocess
import threading

repo = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--exe', default=str(repo / 'target/release/rock.exe'))
args = parser.parse_args()
page = b'''<!doctype html><title>Rock approval fixture</title>
<h1>Disposable Rock approval test</h1><label>Message <input aria-label="Message"></label>
<button onclick="document.getElementById('result').textContent='SENT '+(++window.sent)">Send</button>
<p id="result">SENT 0</p><script>window.sent=0</script>'''

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(page)

    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
process = subprocess.Popen([args.exe, '--config', str(repo / 'pok-ai.toml'), 'mcp', '--workspace', str(repo)],
                           cwd=repo, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
received = queue.Queue()
def read_output():
    for line in process.stdout:
        received.put(json.loads(line))
    received.put(None)
threading.Thread(target=read_output, daemon=True).start()
sequence = 0
tab = None
def write(message):
    process.stdin.write(json.dumps(message) + '\n')
    process.stdin.flush()

def request(method, params, approval=None, permission_expected=False, cancel_unknown=False):
    global sequence
    sequence += 1
    request_id = sequence
    write({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params})
    prompts = 0
    while True:
        message = received.get(timeout=30)
        assert message is not None, 'MCP process closed'
        if message.get('method') == 'elicitation/create':
            assert approval is not None, 'Unexpected approval outside fixture Send'
            prompts += 1
            prompt = message['params']
            assert prompt['requestedSchema'] == {'type': 'object', 'properties': {}}
            assert ('Only for this disposable test' in prompt['message']) == permission_expected
            if cancel_unknown:
                write({'jsonrpc':'2.0','method':'notifications/cancelled','params':{'requestId':'not-an-active-request'}})
            write({'jsonrpc': '2.0', 'id': message['id'], **approval})
        elif message.get('id') == request_id:
            if approval is not None:
                assert prompts == 1, prompts
            return message

def tool(name, arguments=None, **kwargs):
    return request('tools/call', {'name':'rock_'+name,'arguments':arguments or {}}, **kwargs)['result']

def value(result):
    assert not result.get('isError'), result
    return json.loads(result['content'][0]['text'])

try:
    init=request('initialize', {'protocolVersion':'2025-06-18','capabilities':{'elicitation':{'form':{}}},'clientInfo':{'name':'rock-local-approval-test','version':'1'}})
    assert init['result']['serverInfo']['version'] == '0.2.1'
    catalog=request('tools/list', {})['result']['tools']
    click=next(t for t in catalog if t['name']=='rock_user_browser_click')
    assert '_user_permission' in click['inputSchema']['properties']
    assert value(tool('user_browser_status'))['connected']
    snapshot=value(tool('user_browser_navigate', {'url':f'http://127.0.0.1:{server.server_port}/'}))
    tab=snapshot['tab']['tab_id']
    value(tool('user_browser_wait_for', {'text':'SENT 0'}))
    for response, code, expected, quoted, cancel_unknown in [
        ({'result':{'action':'accept','content':{}}}, None, 'SENT 1', True, True),
        ({'result':{'action':'decline'}}, 'approval_client_declined', 'SENT 1', True, False),
        ({'result':{'action':'cancel'}}, 'approval_cancelled', 'SENT 1', False, False),
        ({'error':{'code':-32601,'message':'fixture: unsupported'}}, 'approval_client_error', 'SENT 1', False, False),
        ({'result':{'action':'accept','content':{'approve':False}}}, 'approval_not_granted', 'SENT 1', False, False),
        ({'result':{'action':'accept','content':{}}}, None, 'SENT 2', False, False),
    ]:
        arguments={'target':'Send'}
        if quoted:
            arguments['_user_permission']='Only for this disposable test, click Send once.'
        result=tool('user_browser_click', arguments, approval=response, permission_expected=quoted, cancel_unknown=cancel_unknown)
        if code:
            assert result['isError'] and code in result['content'][0]['text'],result
            assert 'the user declined' not in result['content'][0]['text'],result
        else:
            assert not result.get('isError'),result
        snapshot=value(tool('user_browser_extract'))
        assert expected in snapshot['text'],snapshot['text']
    print('PASS: real MCP accepts explicit consent; rejects decline/cancel/client error/false; no permission leakage; unrelated cancellation does not erase approval; only local fixture clicks executed.')
finally:
    if tab:
        try: tool('user_browser_tabs', {'action':'close','tab_id':tab})
        except Exception: pass
    process.stdin.close()
    try: process.wait(timeout=5)
    except subprocess.TimeoutExpired: process.terminate()
    server.shutdown()
