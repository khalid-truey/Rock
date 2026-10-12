"""Repeatable MCP latency/regression checks against disposable local fixtures.

No account pages are opened. Reports contain timings and synthetic test data.
Use --binary to compare two builds; --user-browser also tests the Rock extension.
"""
import argparse
import ctypes
import http.server
import json
import os
from pathlib import Path
import queue
import statistics
import subprocess
import tempfile
import threading
import time

REPO = Path(__file__).resolve().parents[1]
PAGE = b'''<!doctype html><title>Rock performance fixture</title>
<label>Name <input id="name" aria-label="Name"></label>
<label>Color <select aria-label="Color"><option>Red</option><option>Blue</option></select></label>
<button onclick="document.querySelector('#result').textContent='Clicked '+(++window.count)">Update</button>
<button onclick="document.querySelector('#result').textContent='Loading';document.body.setAttribute('aria-busy','true');setTimeout(()=>{document.querySelector('#result').textContent='Delayed result';document.body.removeAttribute('aria-busy')},650)">Delayed</button>
<a href="/child" target="_blank" rel="opener">Open child</a>
<p id="result">Ready</p><script>window.count=0;</script>'''


class Page(http.server.BaseHTTPRequestHandler):
    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            pass  # A browser's speculative connection can close during cleanup.

    def do_GET(self):
        body = b'<!doctype html><title>Rock child fixture</title><p>Child ready</p>' if self.path == '/child' else PAGE
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class Client:
    def __init__(self, binary, profile):
        env = {**os.environ, 'POK_AI_BROWSER_HEADLESS': '1', 'POK_AI_BROWSER_PROFILE': str(profile), 'POK_LAYA_EXTERNAL': '1'}
        token = REPO / '.rock-data/local-runtime-token'
        if token.exists():
            env['POK_LAYA_TOKEN'] = token.read_text().strip()
            env['POK_CODEX_BRIDGE_TOKEN'] = env['POK_LAYA_TOKEN']
        self.process = subprocess.Popen([str(binary), '--config', str(REPO / 'pok-ai.toml'), 'mcp', '--workspace', str(REPO)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True, encoding='utf-8', env=env, cwd=REPO)
        self.messages = queue.Queue()
        self.errors = []
        threading.Thread(target=lambda: [self.messages.put(json.loads(line)) for line in self.process.stdout], daemon=True).start()
        threading.Thread(target=lambda: [self.errors.append(line) for line in self.process.stderr], daemon=True).start()
        self.seq = 0
        self.samples = {}
        self.capabilities = {}
        self.telemetry = {}
        self.rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'rock-performance', 'version': '1'}})
        self.catalog = self.rpc('tools/list', {})['tools']

    def rpc(self, method, params):
        self.seq += 1
        self.process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': self.seq, 'method': method, 'params': params}) + '\n')
        self.process.stdin.flush()
        deadline = time.monotonic() + 60
        while True:
            try:
                message = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                raise TimeoutError(f'{method} timed out; process exit={self.process.poll()}') from None
            if message.get('id') == self.seq:
                if 'error' in message:
                    raise RuntimeError(message['error'])
                return message['result']

    def call(self, name, args=None, sample=None):
        started = time.perf_counter()
        result = self.rpc('tools/call', {'name': 'rock_' + name, 'arguments': args or {}})
        elapsed = (time.perf_counter() - started) * 1000
        if sample:
            self.samples.setdefault(sample, []).append(round(elapsed, 2))
        if result.get('isError'):
            raise RuntimeError(result['content'][0]['text'])
        value = json.loads(next(c['text'] for c in result['content'] if c['type'] == 'text'))
        if sample:
            self.telemetry.setdefault(sample, []).append({
                'mcp': result.get('_meta'), 'timings_ms': value.get('timings_ms'),
                'input_method': value.get('input_method'), 'state_change': value.get('state_change'),
                'result_bytes': len(json.dumps(result)),
            })
        return value

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)


def target(page, label):
    matches = [e for e in page['elements'] if e['name'] == label and e['actionable']]
    assert len(matches) == 1, (label, len(matches))
    return matches[0]['id']


def browsers(client, url, count, personal):
    tabs = set()
    prefix = 'user' if personal else 'managed'
    def remember(page):
        if personal and page.get('tab', {}).get('opened_by_agent', True):
            tabs.add(page['tab']['tab_id'])
        return page
    try:
        page = remember(client.call('user_browser_navigate' if personal else 'managed_browser_open', {'url': url}))
        for i in range(count + 1):
            sample = i > 0  # Warm up browser attachment, OCR, encoders and caches.
            for op, label, value in [('type', 'Name', f'Example {i}'), ('select', 'Color', 'Blue'), ('click', 'Update', None)]:
                args = {'target': label} if personal else {'snapshot_id': page['snapshot_id'], 'target_id': target(page, label)}
                if value is not None:
                    args[('text' if op == 'type' else 'option') if personal else 'value'] = value
                page = remember(client.call(prefix + '_browser_' + op, args, prefix + '_' + op if sample else None))
                if op == 'type':
                    assert any(e['name'] == label and e['value'] == value for e in page['elements'])
                if op == 'click':
                    assert f'Clicked {i + 1}' in page['text'], page['text']
            page = remember(client.call('user_browser_extract' if personal else 'managed_browser_snapshot', sample=prefix + '_read' if sample else None))
        old_id = page['snapshot_id']
        old_target = target(page, 'Update')
        page = remember(client.call('user_browser_extract' if personal else 'managed_browser_snapshot'))
        if not personal:
            rejected = client.rpc('tools/call', {'name': 'rock_managed_browser_click', 'arguments': {'snapshot_id': old_id, 'target_id': old_target}})
            assert rejected.get('isError'), 'A stale target was accepted'
        args = {'target': 'Delayed'} if personal else {'snapshot_id': page['snapshot_id'], 'target_id': target(page, 'Delayed')}
        page = remember(client.call(prefix + '_browser_click', args, prefix + '_delayed'))
        client.capabilities[prefix + '_waits_for_busy'] = 'Delayed result' in page['text']
        args = {'target': 'Open child'} if personal else {'snapshot_id': page['snapshot_id'], 'target_id': target(page, 'Open child')}
        child = remember(client.call(prefix + '_browser_click', args))
        follows_child = child['url'].endswith('/child') and 'Child ready' in child['text']
        client.capabilities[prefix + '_follows_child_tab'] = follows_child
        if not personal:
            assert follows_child, 'Managed browser did not follow its child tab'
    finally:
        if personal:
            # Navigation may fail after creation but before returning its tab
            # id. Recover only this MCP session's owned tabs for cleanup.
            for tab in client.call('user_browser_tabs', {'action': 'list'})['tabs']:
                if tab.get('opened_by_agent'):
                    tabs.add(tab['tab_id'])
        for tab in tabs:
            client.call('user_browser_tabs', {'action': 'close', 'tab_id': tab})


def desktop(client, count):
    fixture = subprocess.Popen(['powershell.exe', '-NoProfile', '-STA', '-File', str(REPO / 'integrations/codex/test-window.ps1'), '-CountClicks'],
                               creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        window = None
        for _ in range(30):
            window = next((w for w in client.call('list_windows')['windows'] if w['title'] == 'POK Laya smoke test'), None)
            if window:
                break
            time.sleep(0.2)
        assert window, 'Desktop fixture did not open'
        for i in range(count + 1):
            page = client.call('capture_screen', {'scope': 'window', 'window_id': window['id']}, 'desktop_capture' if i else None)
            assert 'Verify' in json.dumps(page)
        client.capabilities['desktop_click_verified'] = True
        for i in range(count + 1):
            page = client.call('capture_screen', {'scope': 'window', 'window_id': window['id']})
            target_id = next(t['id'] for t in page['targets'] if t['label'] == 'Verify')
            page = client.call('click_target', {'target_id': target_id, 'expected_label': 'Verify', 'observation_id': page['observation_id']}, 'desktop_click' if i else None)
            expected = f'PASSED {i + 1}'
            if expected not in json.dumps(page):
                page = client.call('capture_screen', {'scope': 'window', 'window_id': window['id']})
            client.capabilities['desktop_click_verified'] &= expected in json.dumps(page)
    finally:
        fixture.terminate()
        fixture.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=REPO / 'target/release/rock.exe')
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--user-browser', action='store_true')
    parser.add_argument('--desktop', action='store_true')
    parser.add_argument('--skip-browser', action='store_true')
    parser.add_argument('--iterations', type=int, default=5)
    args = parser.parse_args()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    foreground = ctypes.windll.user32.GetForegroundWindow() if os.name == 'nt' else None
    (REPO / 'work').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='rock-bench-', dir=REPO / 'work', ignore_cleanup_errors=True) as temporary:
        client = Client(args.binary.resolve(), Path(temporary) / 'browser')
        try:
            url = f'http://127.0.0.1:{server.server_port}/'
            if not args.skip_browser:
                browsers(client, url, args.iterations, False)
            if args.user_browser:
                assert client.call('user_browser_status')['connected']
                browsers(client, url, args.iterations, True)
            unchanged = foreground is None or foreground == ctypes.windll.user32.GetForegroundWindow()
            # The user may change focus while the benchmark runs. Record this
            # observation without treating it as proof that Rock moved focus.
            if args.desktop:
                desktop(client, args.iterations)
            report = {'binary': str(args.binary), 'tools': [t['name'] for t in client.catalog], 'browser_foreground_unchanged': unchanged,
                      'capabilities': client.capabilities,
                      'telemetry': client.telemetry,
                      'samples_ms': client.samples, 'median_ms': {k: round(statistics.median(v), 2) for k, v in client.samples.items()}}
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, indent=2), encoding='utf-8')
            print(json.dumps(report['median_ms'], indent=2), flush=True)
        finally:
            client.close()
            server.shutdown()


if __name__ == '__main__':
    main()
