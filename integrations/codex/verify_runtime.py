"""Verify actual Laya inference (CPU or CUDA) and the authenticated Codex gateway."""
from pathlib import Path
import json
import os
import urllib.request
import urllib.error

data = Path(os.environ.get("ROCK_DATA_DIR", Path(__file__).resolve().parents[2] / ".rock-data"))
token = (data / "local-runtime-token").read_text().strip()

def request(port, route, body=None):
    headers = {"Authorization": "Bearer " + token}
    payload = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}{route}", data=payload, headers=headers), timeout=180) as response:
        return json.load(response)

health = request(43128, "/health")
assert health["laya"]["status"] == "ready"
assert health["laya"]["device"].startswith(("cuda", "cpu")), health
for port in (43126, 43128):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/health")
        raise AssertionError("Unauthenticated endpoint was accepted")
    except urllib.error.HTTPError as error:
        assert error.code == 401

decision = request(43126, "/v1/systemone", {"model": "convaiinnovations/laya-typed-decisions",
    "state": {"task": "Choose the ready status", "visible": ["Ready"]},
    "questions": {"status": {"type": "choice", "instructions": "Which status is visible?",
        "criteria": {"ready": "The screen says Ready", "failed": "The screen says Failed"}}}})
assert decision["sidecar"]["device"].startswith(("cuda", "cpu")), decision
print("PASS: authenticated shared Laya inference", json.dumps(decision), flush=True)
models = request(43128, "/v1/models")
assert any(m["id"] == "codex-default" for m in models["data"])
response = request(43128, "/v1/chat/completions", {"model": "codex-default", "reasoning_effort": "low",
    "messages": [{"role": "user", "content": "Reply exactly POK_GATEWAY_VERIFIED. Do not call tools."}], "stream": False})
assert response["choices"][0]["message"]["content"].strip() == "POK_GATEWAY_VERIFIED", response
report = {"health": health, "laya_decision": decision, "codex_model": response["model"], "codex_usage": response["usage"]}
(data / "runtime-verification.json").write_text(json.dumps(report, indent=2))
print("PASS: authenticated POK-compatible HTTP -> Codex app-server -> ChatGPT inference", response["model"], flush=True)
