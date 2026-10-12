# Rock MCP and Codex integration

Start with the [complete setup guide](../../README.md) for requirements,
`scripts/setup-rock.ps1`, MCP configuration, and all three control modes.

```powershell
node integrations/codex/runtime.mjs status
node integrations/codex/runtime.mjs mcp
node integrations/codex/runtime.mjs stop
```

The MCP client launches `mcp` itself; stdout is the protocol stream. `status`
is read-only. MCP starts only the lightweight local bridge, never Laya. Data defaults to the repository's `.rock-data`;
`ROCK_DATA_DIR` overrides it and must agree with `pok-ai.toml`.
`ROCK_LAYA_DEVICE` selects `auto`, `cpu`, or `gpu` when starting the host manually.
See [Shared Laya setup](../../docs/SHARED-LAYA.md) for PC/laptop pairing.

| File | Purpose |
| --- | --- |
| `runtime.mjs` | Authenticated loopback bridge and native MCP launcher |
| `laya-host.mjs` | Explicit Start/Stop Laya and device pairing/revocation |
| `shared-laya.mjs` | HTTPS inference gateway, bounded queue and local client proxy |
| `planner.mjs` | Optional Codex app-server adapter for standalone POK tasks |
| `install-chrome.mjs` | Generates native files; `--register` installs per-user Chrome registration |
| `native-host.mjs` | Restricted CDP bridge |
| `chrome-extension/` | Chrome MV3 extension; use Load unpacked |
| `codex.local.toml`, `mcp.local.json` | Generated, ignored MCP examples |

Node dependencies are pinned in the lockfile. Run `npm ci` in this directory to
restore them. No account credentials are bundled. Checks and live-test
prerequisites are documented in the main README.
