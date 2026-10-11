"""Real MCP protocol checks; --desktop creates a disposable WinForms window."""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import time

repo = Path(__file__).resolve().parents[2]
data = Path(os.environ.get("ROCK_DATA_DIR", repo / ".rock-data"))
parser = argparse.ArgumentParser()
parser.add_argument("--desktop", action="store_true")
parser.add_argument("--runtime", action="store_true")
args = parser.parse_args()
command = ["node", str(Path(__file__).with_name("runtime.mjs")), "mcp"] if args.runtime else [
    str(repo / "target/debug/rock.exe"), "--config", str(repo / "pok-ai.toml"), "mcp", "--workspace", str(repo.parent)]
process = subprocess.Popen(command, cwd=repo, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
fixture = None
seq = 0

def request(method, params):
    global seq
    seq += 1
    process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": seq, "method": method, "params": params}) + "\n")
    process.stdin.flush()
    while True:
        line = process.stdout.readline()
        if not line:
            raise RuntimeError("MCP process exited")
        message = json.loads(line)
        if message.get("id") == seq:
            return message

def call(name, arguments):
    result = request("tools/call", {"name": "rock_" + name, "arguments": arguments})["result"]
    if result.get("isError"):
        raise RuntimeError(result["content"][0]["text"])
    return result

def value(result):
    return json.loads(next(c["text"] for c in result["content"] if c["type"] == "text"))

try:
    init = request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "pok-smoke", "version": "1"}})
    assert init["result"]["serverInfo"]["name"] == "rock"
    tools = request("tools/list", {})["result"]["tools"]
    assert any(t["name"] == "rock_fast_actions" for t in tools)
    assert value(call("get_current_time", {}))["utc_iso8601"]
    assert request("tools/call", {"name": "rock_missing", "arguments": {}})["error"]["code"] == -32602
    blocked = request("tools/call", {"name": "rock_open_application", "arguments": {"name": "notepad"}})["result"]
    assert blocked["isError"] and "Approval needed" in blocked["content"][0]["text"]
    print(f"PASS: MCP initialization, {len(tools)} tools, clock, unknown-tool rejection, policy approval enforcement", flush=True)
    if args.desktop:
        fixture = subprocess.Popen(["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File",
            str(Path(__file__).with_name("test-window.ps1"))], creationflags=subprocess.CREATE_NO_WINDOW)
        window = None
        for _ in range(30):
            windows = value(call("list_windows", {}))["windows"]
            window = next((w for w in windows if "POK Laya smoke test" in w.get("title", "")), None)
            if window: break
            time.sleep(0.5)
        assert window, "Test window did not appear"
        wid = window.get("id") or window.get("window_id")
        before = call("capture_screen", {"scope": "window", "window_id": wid})
        assert "Verify" in str(value(before)), "Button missing from grounded capture"
        # Same session retains the target window and current observation.
        result = value(call("fast_actions", {"goal": "Click the Verify button in the POK Laya smoke test window",
            "target_hint": 'button "Verify"', "done_when": 'text "PASSED" is visible',
            "allowed_operations": ["click"], "max_steps": 2}))
        after = call("capture_screen", {"scope": "window", "window_id": wid})
        observed = value(after)
        assert "PASSED" in str(observed), f"Verification text missing; plan returned {result}"
        image = next(c["data"] for c in after["content"] if c["type"] == "image")
        (data / "smoke-test.png").write_bytes(base64.b64decode(image))
        (data / "smoke-result.json").write_text(json.dumps({"plan": result, "observation": observed}, indent=2))
        print("PASS: native capture, grounded target, Laya fast_actions click, post-action screen verification", flush=True)
finally:
    process.stdin.close()
    try: process.wait(timeout=5)
    except subprocess.TimeoutExpired: process.terminate()
    if fixture: fixture.terminate()
