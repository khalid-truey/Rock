# Rock

**A local Windows computer and browser operator, exposed as MCP tools.**

Rock lets an MCP client inspect and operate Windows apps, browse in an isolated
background browser, or use your existing Chrome logins through the Rock Browser
Control extension. Its Rust execution engine comes from
[POK-Agent](https://github.com/Acekorneya/POK-Agent); local Laya helps execute
bounded plans while the connected AI client decides what to do.

This is the Rock source distribution. Build it with the steps below. Rust
packages, the optional desktop dashboard, and some settings retain their
upstream `pok-ai` names. Upstream releases and benchmarks are not Rock release
artifacts or measurements. The original project guide is preserved in
[README-POK-Agent.md](README-POK-Agent.md).

## Choose a control mode

One MCP server exposes all three modes; you do not need three installations.

| Mode | Best for | Existing logins? | Can you keep using your PC? |
| --- | --- | --- | --- |
| **Windows computer use** | Native apps, screenshots, OCR, UI Automation, clicks, typing and dragging | Whatever the target app has open | Reading can happen in the background; real input may wait for idle time and bring a window forward |
| **Managed browser** | Research and web tasks in an isolated headless Edge/Chrome profile | No; each MCP process gets its own profile | Yes; no Windows mouse or keyboard input |
| **Your Chrome + extension** | Sites where you are signed in, and tabs you explicitly share | Yes, in your actual Chrome profile | Yes; use other tabs or apps while Rock works |

The extension uses your running Chrome session. It does not export cookies,
copy your profile, or require remote-debugging flags.

## Requirements

- **Windows 10/11 x64**, in an interactive desktop session. The complete setup
  is native Windows, not WSL. The upstream core has Linux support, but Windows
  desktop capture/input and this native extension installer require Windows.
- **Git**, **Node.js 22+**, **Rust 1.88.0** (pinned in `rust-toolchain.toml`),
  and **Visual Studio 2022 Build Tools** with the C++ desktop workload and Windows
  SDK. Use Developer PowerShell for VS if the linker is missing.
- **Python 3.12 recommended**, with `venv` and `pip`, for Laya.
- **Edge or Chrome** for managed browsing; **Google Chrome** for the extension.
  The native-host installer registers Chrome, not Edge.
- An MCP client supporting **local stdio servers** and images. Full action
  support also requires MCP **form elicitation** for approvals. Clients without
  it can use permitted tools, but actions requiring approval are rejected.
- Internet access for initial dependencies/model downloads. Allow several GB
  for dependencies, model weights and build output.

NVIDIA CUDA is optional. Auto mode selects CUDA when available with enough free
VRAM (a 2 GiB free-memory gate), otherwise CPU. This gate is not a total GPU
memory requirement or performance guarantee. CPU inference is slower. The
installer uses PyTorch 2.7.1/CUDA 12.8 on NVIDIA machines and Laya 0.3.4 with a
pinned model revision. A compatible NVIDIA driver is needed for CUDA.

## Quick start

Run in PowerShell after installing the requirements:

```powershell
git clone https://github.com/khalid-truey/Rock.git
Set-Location Rock
$RockPython = & py -3.12 -c "import sys; print(sys.executable)"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-rock.ps1 -Python $RockPython -RegisterChrome
node integrations/codex/runtime.mjs status
```

For a private repository, your Git account must have access before cloning.
If `py` is unavailable, pass the absolute path of your Python executable instead.
`-ExecutionPolicy Bypass` applies only to this setup process.

The setup script:

1. Installs pinned Node dependencies with `npm ci`.
2. Builds `rock.exe`, `rock-chrome-host.exe`, and the upstream `pok-ai.exe` CLI.
3. Creates local `pok-ai.toml` from [rock.example.toml](rock.example.toml), with
   absolute paths. Existing configuration is preserved.
4. Installs Laya in `.rock-data/laya/runtime` and downloads its model separately.
5. Generates Chrome native-host files using this machine's Node path. With
   `-RegisterChrome`, registers the host for the current Windows user.
6. Writes MCP examples to `integrations/codex/codex.local.toml` and
   `integrations/codex/mcp.local.json`. Your client's config is not edited.

For computer use and managed browsing only, omit `-RegisterChrome`.
`-SkipLaya` reuses an already prepared Laya installation; it does not remove
the runtime's Laya requirement. `-SkipBuild` reuses built binaries. The first
complete build/download can take several minutes. `status` starts the runtime
and should report Laya as `ready` before you connect MCP.

## Connect Rock to your MCP client

Rock uses **stdio**: the client launches `node runtime.mjs mcp`. Ports 43127 and
43128 are internal runtime services, not HTTP MCP endpoints.

### Codex

Read the generated configuration:

```powershell
Get-Content .\integrations\codex\codex.local.toml
```

Merge its block into `%USERPROFILE%\.codex\config.toml` (or your custom
`CODEX_HOME`). Update an existing `rock` block instead of adding a duplicate.
If configuring manually, substitute your installation paths:

```toml
[mcp_servers.rock]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\src\Rock\integrations\codex\runtime.mjs', 'mcp']
startup_timeout_sec = 240
tool_timeout_sec = 240
```

Alternatively, register from the Rock directory with the CLI:

```powershell
$RockNode = (Get-Command node).Source
$RockLauncher = (Resolve-Path .\integrations\codex\runtime.mjs).Path
codex mcp add rock -- $RockNode $RockLauncher mcp
codex mcp list
```

Then add the timeout settings above to the `rock` block. Cold Laya startup may
exceed the client's default timeout. Reload the MCP connection and start a new
chat if the tools have not appeared. See the
[official Codex MCP documentation](https://developers.openai.com/codex/mcp/)
for configuration and timeout options.

Try: **“Use Rock to get the current time and list my Windows app windows.”**

### Other local MCP clients

Merge `integrations/codex/mcp.local.json` into the client's configuration,
adapting the outer key if necessary. For clients using `mcpServers`:

```json
{
  "mcpServers": {
    "rock": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\src\\Rock\\integrations\\codex\\runtime.mjs", "mcp"]
    }
  }
}
```

Use your actual paths and a 240-second startup timeout where supported.
Approval support depends on the client's form-elicitation implementation.
A cloud-only client cannot launch this local command without a local executor.

## 1. Windows computer use

After connecting MCP, no browser extension is needed for Windows apps.

> Rock, list my windows and inspect the Calculator window.

> Rock, capture the Notepad window and tell me what text is visible.

> Rock, use Calculator to calculate 48 times 27 and verify the displayed result.

The model lists/observes windows, selects the intended window, and acts on fresh
numbered targets with matching visible labels. `rock_fast_actions` executes
bounded sequences with observable completion conditions. Screenshots, OCR and
accessibility data provide feedback.

Use one desktop-control task at a time. Some actions use real Windows input and
need an idle period. Secure-desktop/UAC prompts and protected or elevated windows
are not ordinary automation targets. Hidden windows cannot accept every kind of
input.

## 2. Managed background browser

> Rock, use your managed background browser to open example.com and summarize it.

> Rock, research this topic in browser-only mode while I continue using my PC.

Rock launches an installed Edge/Chrome headlessly with a separate profile per
MCP process. It uses `rock_managed_browser_open`, then snapshot, click, type,
select, hover and scroll tools. No extension is needed and no Windows mouse or
keyboard input is used.

Profiles live under `.rock-data/browser/profiles/`, are separate from your
personal profile, and are not automatically deleted at shutdown. This mode
does not inherit existing website logins. Native file dialogs and browser
prompts may need a handoff; browser-only tasks should remain on browser tools.

## 3. Your browser and existing logins through the extension

### Install once

If setup used `-RegisterChrome`, native registration is complete. Otherwise run:

```powershell
node integrations/codex/install-chrome.mjs --register
```

This registers `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.rock.browser`
for the current Windows user, without administrator access. The generated
manifest allows the Rock extension's ID and launches the built native helper.

In your normal Chrome profile:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the clone's
   `integrations/codex/chrome-extension` folder.
4. Pin **Rock Browser Control** from Chrome's extension menu.
5. Open its popup and choose **Connect Rock** if needed. It should say
   **Connected to Rock on this PC**.

Keep the repository at that location. If moved, regenerate local config, repeat
native registration, and reload the unpacked extension from the new path. Load
the extension in the Chrome profile with the website sessions you want to use.
The manifest's `key` is a public key for a stable extension ID, not a credential.

### Use it

> Rock, check your connection to my Chrome, then open Truey in a background tab
> and tell me whether I am signed in.

> Rock, use my Chrome session to read the dashboard. Stay in browser-only mode.

The model calls `rock_user_browser_status`, then `rock_user_browser_navigate`
to open a background tab with your existing sessions. An empty tab list is
normal before Rock creates a tab or you share one.

To allow an **existing tab**, open it, click the extension popup, and select
**Share this tab with Rock**. Rock can list and switch to that tab in the
background. Other existing tabs are not exposed by the bridge. Rock may close
its own tabs; it cannot close shared user tabs.

Keep using other tabs/apps, but avoid editing the tab Rock is using. Select
**Stop sharing this tab** to revoke a tab or **Disconnect Rock** to revoke the
connection. Cancelling Chrome's debugging banner also revokes that tab.
Reconnecting does not automatically re-share revoked tabs.

The extension requests `debugger`, `tabs`, `storage`, and `nativeMessaging`.
It exposes a restricted CDP interface on `127.0.0.1:9222` while connected;
internal Chrome pages and cookie APIs are excluded, and web Origin requests are
rejected. The local OS account remains a trust boundary: untrusted software on
the same PC is outside this protection.

## Tool reference

There are **33 tools**, all prefixed `rock_`. Prefix omitted below:

| Group | Tools |
| --- | --- |
| Time | `get_current_time` |
| Desktop observation | `observe_desktop`, `capture_screen`, `list_windows`, `query_screen_text`, `query_window_tree`, `inspect_screen_region` |
| Desktop actions | `open_application`, `activate_window`, `fast_actions`, `click_target`, `type_text`, `simulate_input`, `scroll_view`, `hover_target`, `drag_target` |
| Managed browser | `managed_browser_open`, `managed_browser_snapshot`, `managed_browser_click`, `managed_browser_type`, `managed_browser_select`, `managed_browser_hover`, `managed_browser_scroll` |
| Your browser | `user_browser_status`, `user_browser_navigate`, `user_browser_extract`, `user_browser_click`, `user_browser_type`, `user_browser_select`, `user_browser_scroll`, `user_browser_wait_for`, `user_browser_screenshot`, `user_browser_tabs` |

Tool schemas define arguments. Use fresh page targets. Browser form entry uses
type/select tools; Laya click plans use `allowed_operations: ["browser_click"]`
or `["user_browser_click"]`. Keep one action in flight per connection and
re-observe after cancellation: a partial action may already have happened.

## Runtime, data and optional standalone agent

```powershell
node integrations/codex/runtime.mjs start
node integrations/codex/runtime.mjs status
node integrations/codex/runtime.mjs stop
```

`start`, `status`, and `mcp` start the shared runtime on demand. Closing a client
does not stop it; use `stop` after all clients are done. No Windows sign-in
service is installed.

| Component | Location |
| --- | --- |
| MCP | stdio process, no listening MCP port |
| Laya decisions | authenticated loopback `127.0.0.1:43127` |
| Runtime / optional Codex planner | authenticated loopback `127.0.0.1:43128` |
| Chrome extension bridge | loopback `127.0.0.1:9222` |
| Local config | `pok-ai.toml`, ignored by Git |
| Models, Python, token, logs, profiles | `.rock-data/`, ignored by Git |

Only one runtime can use the fixed ports at a time. Stop an older POK/Rock
runtime through its own launcher before running a different checkout.

`ROCK_LAYA_DEVICE` selects `auto` (default), `cpu`, or `gpu`. Set it before runtime
startup and in your MCP client's environment. `ROCK_DATA_DIR` overrides the
data path; also update `data_dir`/`diagnostics_dir` in `pok-ai.toml` and install
Laya into that directory. `POK_CODEX_BIN` overrides the optional planner's
bundled Codex executable.

For the standalone POK agent loop with Codex planning, sign in through the
bundled CLI, then run a task:

```powershell
& .\integrations\codex\node_modules\.bin\codex.cmd login
node integrations/codex/runtime.mjs run "Inspect the open Calculator window"
```

The optional POK desktop dashboard needs its own build:

```powershell
npm.cmd ci --prefix apps/desktop
npm.cmd --prefix apps/desktop run tauri build -- --debug --no-bundle
node integrations/codex/runtime.mjs desktop
```

Laya inference stays local. Your MCP client may send page/screen text and images
to its model provider; standalone Codex planning sends input to OpenAI. Codex
manages its own authentication. The runtime's local token is not an OpenAI API
key. Runtime data and generated configs must stay out of Git.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `cargo` or `link.exe` missing | Install Rust and VS C++/Windows SDK; reopen Developer PowerShell |
| MCP startup timeout | Run `runtime.mjs status`; allow 240 seconds; inspect `.rock-data/runtime.log` |
| Missing Python/model | Rerun setup without `-SkipLaya`, using Python 3.12 |
| CUDA error or low VRAM | Stop runtime, set `$env:ROCK_LAYA_DEVICE = 'cpu'`, restart; use the same MCP environment |
| Chrome popup disconnected | Build helper, run `install-chrome.mjs --register`, verify generated paths, reconnect |
| Port 9222 occupied | Identify and disconnect the other bridge/debug browser you own; do not restart your normal Chrome as a workaround |
| Connected but no tabs | Ask Rock to navigate or explicitly share an existing tab |
| Missing website logins | Use `rock_user_browser_*`; check that the extension is in the right Chrome profile |
| Client does not support form elicitation | Use a compatible client or interactive POK UI for the approval-required action |
| Native dialog/protected field blocks work | Complete that step yourself; browser-only work does not silently use desktop input |
| Checkout moved or Node changed | Regenerate native files and MCP paths, update local config, reload extension |

## Development and checks

```powershell
cargo build --locked -p pok-ai-cli --bins
node --test integrations/codex/planner.test.mjs integrations/codex/chrome-extension.test.mjs
python integrations/codex/smoke_test.py
```

With a ready runtime, `python integrations/codex/browser_test.py` uses an
isolated local web fixture. `python integrations/codex/chrome_live_test.py`
requires a connected extension and uses only its own temporary test tab.
`python integrations/codex/smoke_test.py --runtime --desktop` creates a disposable
Windows test window. These live checks need an appropriate desktop session.
Disconnect the extension before `node --test integrations/codex/native-host.test.mjs`,
because that test binds port 9222. `verify_runtime.py` exercises the optional
Codex planner and can consume account usage.

| Source | Purpose |
| --- | --- |
| `crates/pok-ai-cli/src/mcp_server.rs` | MCP transport, tool catalog, approvals |
| `crates/pok-ai-cli/src/chrome_host.rs` | Native-messaging launcher |
| `integrations/codex/runtime.mjs` | Runtime lifecycle and MCP startup |
| `integrations/codex/planner.mjs` | Optional Codex app-server adapter |
| `integrations/codex/chrome-extension/` | Extension popup, worker, controller |
| `integrations/codex/native-host.mjs` | Local extension/CDP bridge |
| `scripts/setup-rock.ps1` | Fresh-clone setup and MCP examples |
| `scripts/laya_sidecar.py` | Local typed-decision model service |
| `crates/pok-ai-core/`, `crates/pok-ai-windows/` | POK execution and Windows tools |

## Remove Rock

Stop the runtime when no clients are using it, remove the MCP entry from your
client (`codex mcp remove rock`), and remove Rock Browser Control from Chrome.
To unregister only Rock's per-user native host:

```powershell
Remove-Item -LiteralPath 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.rock.browser'
```

The clone and `.rock-data` remain until you choose to delete them. Review local
diagnostics and browser profiles before deleting anything you want to keep.

## Attribution and license

Derived from **POK-Agent by KNY Industries and contributors**, at upstream
commit `7e66ad01d63dd645bf02e12c7b7a0deb780a8159` (v0.1.6), plus the local Rock
MCP/runtime/extension work. The initial Rock commit is a source snapshot.

[Apache-2.0](LICENSE); upstream attribution is retained in [NOTICE](NOTICE).
Inherited research/citation information remains in `CITATION.cff`. Model weights
and third-party dependencies are downloaded separately and retain their own
licenses; see NOTICE for details.
