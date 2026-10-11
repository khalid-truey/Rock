# Rock Browser Control

First build Rock and register its native helper from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-rock.ps1 -RegisterChrome
```

If already built, `node integrations/codex/install-chrome.mjs --register`
regenerates the machine-specific native files and current-user registration.
See the [main README](../../../README.md) for requirements and MCP configuration.

Load this folder in your existing Chrome using **chrome://extensions → Developer
mode → Load unpacked**. Open the Rock popup; it should show **Connected to Rock
on this PC**. No Chrome restart or profile copy is needed.

Rock can open its own background tabs using your existing website sessions.
To let it use a tab you already have open, select **Share this tab with Rock**
in the popup. Your other tabs are not exposed. Work in another tab or app while
Rock runs; avoid editing the same page it is using.

Use **Stop sharing this tab** or **Disconnect Rock** to revoke access. Cancelling
Chrome's debugging banner revokes the affected tab too. Reconnecting does not
automatically re-share previously revoked tabs.

The extension requires `debugger`, `tabs`, `storage`, and `nativeMessaging`.
Its per-user native host is `com.rock.browser`. The host only accepts this
extension's ID and listens on loopback port 9222; browser-origin HTTP/WebSocket
requests are rejected. It exposes the CDP subset used by POK-Agent, without
cookie APIs or access to unshared tabs. Chrome internal pages are excluded.

If connection fails, open the popup and press **Connect Rock**. Another browser
already using port 9222 must be closed before the bridge can bind that port.
Do not close your normal Chrome session to troubleshoot without saving work.

Removing the extension revokes browser access. To remove its local registration,
delete only `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.rock.browser`.
