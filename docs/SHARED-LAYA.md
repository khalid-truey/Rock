# One Laya host, two Rock computers

Your PC and laptop can share one Laya model over the same home router. Ethernet
on the PC and Wi-Fi on the laptop work together. Use the regular Wi-Fi, not an
isolated guest network. No public IP, PPPoE changes or router port forwarding
are needed.

## How it works

Each computer runs its own Rock MCP and controls its own apps/browser. The PC
loads one model; the laptop has no Python, PyTorch or model installation. Both
send decisions to a single authenticated HTTPS gateway on the PC. The gateway
queues decisions; the computers execute their actions independently.

Laya starts **only** when you open **Start Laya**. Opening MCP, checking status,
reconnecting a laptop, or restarting Windows does not load a model. There is
no automatic host restart after a crash and no Windows startup service.

The localhost proxy keeps the core's loopback-only restriction intact. It sends
only inference requests to the host. It does not expose either computer's MCP,
files, desktop tools, browser-control port, or Codex planner to the network.

## PC setup

From a source checkout, install the requirements in the main README, then:

```powershell
$RockPython = & py -3.12 -c "import sys; print(sys.executable)"
.\scripts\setup-rock.ps1 -Mode Host -Python $RockPython -RegisterChrome
```

From a portable Windows package, extract it to a permanent writable folder and
open **Setup Host.cmd**. Node and the Rock executables are bundled. The host
still needs Python 3.12 to install Laya. Source builds need Rust/Visual Studio;
the portable package does not.

Already installed Laya elsewhere? Reuse its data directory without copying the
weights or Python environment:

```powershell
.\scripts\setup-rock.ps1 -Mode Host -SkipLaya -LayaDataDir 'D:\Laya Agent\data' -RegisterChrome
```

On repeated setup, existing host settings are retained. To change the model or
Python location later, edit `.rock-data/host.json` while the host is stopped.
Use one configured host installation at a time.

Allow **TCP 43129**, **Private profile**, **LocalSubnet** in Windows Firewall.
Setup can create that rule with `-OpenFirewall` when run in an administrator
PowerShell. It does not open the firewall without that flag. Mark your trusted
home network Private if it is currently Public. Reserve the PC's LAN IP in
your router so it stays the same after a reboot.

Open **Start Laya** on your desktop. Wait for **READY**. Keep the host open while
using either computer. **Stop Laya** shuts down the shared host and its model;
Ctrl+C in the host window does the same. Do not configure the old automatic
launcher alongside this host.

## Pair the laptop

On the PC, replace the example with its reserved LAN IP:

```powershell
.\scripts\rock.ps1 pair laptop https://192.168.1.100:43129
```

This creates `.rock-data/laptop.rock-pairing.json`. Transfer that file privately
to the laptop. It contains that device's access credential and the host's public
certificate. Each device gets a different credential; the PC's own credential
is created during Host setup. Do not put pairing files in Git or public messages.

On the laptop, extract the portable package and open **Setup Laptop.cmd**. Select
the pairing file when prompted. Client setup does not install a model, Python
or PyTorch. From a source checkout the equivalent is:

```powershell
.\scripts\setup-rock.ps1 -Mode Client -PairingFile 'C:\Users\You\Downloads\laptop.rock-pairing.json' -RegisterChrome
```

Source checkout setup compiles Rock and needs build tools. Use the portable
package on a small laptop. After import you can remove the transferred pairing
file; the private installed copy is `.rock-data/laya-client.json`.

Both computers use their own generated MCP configuration in
`integrations/codex/codex.local.toml` or `mcp.local.json`. Add it to the local
MCP-capable desktop app, then reload MCP. Existing Rock entries must be updated
to this installation's path. Do not register both the old and new launchers.

For Chrome logins, load `integrations/codex/chrome-extension` through
`chrome://extensions` > Developer mode > Load unpacked, then connect the popup.
Each computer uses its own Chrome sessions. No extension is needed for native
desktop control or the separate managed browser.

## Daily use and restart behavior

1. On the PC, manually open **Start Laya** and wait for **READY**.
2. Use Rock from either computer, including both simultaneously.
3. When finished, open **Stop Laya** to release GPU memory.

Restarting the PC leaves Laya **off**. Basic Rock tools can remain available on
the laptop, but new assisted plans report the host as offline. Once you manually
start Laya, the next request reconnects using the saved pairing. There is no
background replay or automatic resumption of an interrupted plan.

Assisted plans check host readiness before starting and between plan nodes.
If the host disappears during a node, already issued input may finish; inspect
the current screen/page before submitting a new plan. Individual tools remain
available under their ordinary approval policy.

Shared inference is serialized with a bounded waiting queue. Requests that
expire or disconnect while waiting are skipped. Slow GPU work or several active
clients can cause busy/time-out errors. There is no promise of identical speed
on both devices; the laptop still renders pages and captures/processes its UI.

## Status and control

```powershell
.\scripts\rock.ps1 host-status  # PC: model health, read-only
.\scripts\rock.ps1 status       # Either PC: local bridge status, read-only
.\scripts\rock.ps1 start        # Local lightweight bridge only; never Laya
.\scripts\rock.ps1 stop         # Local lightweight bridge only; never the host
.\scripts\rock.ps1 host-start   # PC: explicit foreground host/model start
.\scripts\rock.ps1 host-stop    # PC: stop shared model
.\scripts\rock.ps1 revoke laptop
```

Revocation applies to subsequent requests without restarting the host. An
already running inference may finish. Issue a new pairing with the same device
name after revocation, then reimport it on the laptop. Remove or rename the old
exported pairing file first so it cannot be overwritten accidentally.

## Connections and credentials

| Port | Bound to | Purpose |
| --- | --- | --- |
| 43129 | PC network interfaces; restrict firewall to Private/LocalSubnet | HTTPS inference gateway, per-device credentials |
| 43127 | PC localhost | One Python Laya worker; never expose publicly |
| 43126 | Each computer's localhost | Authenticated client proxy |
| 43128 | Each computer's localhost | Lightweight runtime / optional local Codex planner |
| 9222 | Each computer's localhost | Its Chrome extension bridge |

The host uses a locally generated certificate, trusted only by clients holding
the pairing certificate. No system-wide root certificate is installed. Clients
validate the certificate chain and require the exact paired certificate; this
allows a LAN IP to be used without weakening certificate authentication. The
certificate expires after two years. Renewal requires replacing the host
certificate and redistributing pairings; it is not automatic in this version.

The gateway exposes health and decisions only. Stopping the host requires a
separate host-local credential; a laptop credential cannot stop it. Credentials,
private certificates and state are stored in `.rock-data`, excluded from Git,
and setup restricts that directory to the Windows user, SYSTEM and administrators.
The host receives relevant UI text and decision context. It does not receive
browser cookies. Raw inference logging is off unless explicitly configured.

## Migrating an existing automatic installation

Close clients using the old installation and explicitly stop its runtime with
its original `runtime.mjs stop` command. If its MCP entry remains enabled, it can
start the old runtime again. Update that entry to the new generated configuration
before restarting the app. This update does not silently rewrite other clients'
configuration or terminate processes from another checkout.

The new host reserves the gateway port before starting Python. Python reserves
its inference port before loading weights. A second host launch, or an old
sidecar on 43127, therefore fails instead of loading another model instance.

If the laptop cannot connect, check: the host says READY; the LAN IP is correct;
both machines are on the same non-isolated network; the firewall allows the
Private/LocalSubnet rule; and the pairing credential has not been revoked.
Use Host setup only on the PC. Use Client setup on laptops.
