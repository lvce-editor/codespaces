# Browser Codespaces proof

The opt-in static page is served at `/codespaces/experimental/`. Sign in through
the existing LVCE editor in the same browser, return to the proof, load Codespaces
and connect. If authentication expires, open the editor to refresh its sign-in.

The browser calls GitHub REST for lifecycle operations. Backend-2 only exchanges
the existing LVCE token for the user's GitHub credential, discovers the selected
Codespace's tunnel, and registers private ports. Files, terminal data and startup
RPC travel directly through Microsoft's WebSocket relay. There is no LVCE runtime
installation, container SSH daemon, companion extension or devcontainer change.

## Broker contract

All requests are bearer-authenticated POSTs to `https://lvce-editor.dev`, require
the exact `https://lvce-editor.github.io` origin, and use `Cache-Control: no-store`.

- `/codespaces/auth/github-token`: existing account-scoped GitHub token handoff.
- `/codespaces/{name}/browser-connection`: returns `{workspacePath,tunnel}` with
  relay endpoints, host public keys and a scoped `connect` token.
- `/codespaces/{name}/browser-port`: accepts only `{port}` and registers that port
  privately. It never accepts an upstream URL or exposes port-management tokens.

## Protocol evidence

This is an independent adapter, with VS Code Server and wire behavior pinned to
version 1.136.1, commit `a44adf7f53e00964ab890f9f8758a334f1fc15bc`.

- The [GitHub CLI connection implementation](https://github.com/cli/cli/blob/trunk/internal/codespaces/connection/connection.go)
  obtains tunnel credentials and resolves the relay descriptor.
- Microsoft's [browser tunnel transport](https://github.com/microsoft/dev-tunnels/blob/main/ts/src/connections/defaultTunnelRelayStreamFactory.ts)
  authenticates browser WebSockets with a subprotocol. The tunnel uses SSH framing
  internally, independently of any `sshd` inside the user's container.
- The [published Codespaces browser client](https://github.gallery.vsassets.io/_apis/public/gallery/publisher/github/extension/codespaces/1.18.16/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage)
  demonstrates `VSCodeServerHost.StartRemoteServerAsync` over internal port 16635,
  returning a server port and token. Its bundle is not a dependency of this proof.
- The [gRPC-Web framing specification](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-WEB.md)
  defines binary envelopes and status trailers.
- The MIT [VS Code handshake](https://github.com/microsoft/vscode/blob/a44adf7f53e00964ab890f9f8758a334f1fc15bc/src/vs/server/node/remoteExtensionHostAgentServer.ts),
  [IPC serialization](https://github.com/microsoft/vscode/blob/a44adf7f53e00964ab890f9f8758a334f1fc15bc/src/vs/base/parts/ipc/common/ipc.ts),
  [filesystem channel](https://github.com/microsoft/vscode/blob/a44adf7f53e00964ab890f9f8758a334f1fc15bc/src/vs/platform/files/node/diskFileSystemProviderServer.ts),
  and [terminal channel](https://github.com/microsoft/vscode/blob/a44adf7f53e00964ab890f9f8758a334f1fc15bc/src/vs/server/node/remoteTerminalChannel.ts)
  specify the management connection implemented here.

On 2026-09-07, unauthenticated CORS preflight requests to the tunnel management
service allowed `https://vscode.dev` but omitted CORS headers for the Pages origin.
That is why the small broker handles discovery and private port registration.

## Limits and acceptance

The Codespaces bootstrap interface is undocumented. Source inspection is evidence
that the interface exists, not proof of compatibility with LVCE's OAuth app.
Protocol fixtures, broker tests and browser smoke tests cannot substitute for a
real connection from Pages.

Reconnect deliberately creates a fresh management session. The terminal panel
shows plain text, caps displayed output at 200,000 characters, acknowledges PTY
output and requests nonpersistent terminals. Disconnect attempts to shut down its
terminal and cancels streams and activity timers; it does not stop compute.
Remote payloads are limited to 16 MiB and pending RPCs to 128. User input is never
automatically replayed after a network failure. SSH remains the existing editor's
connection path until the proof is accepted.

Acceptance requires the default Codespaces image and an unchanged Debian/Ubuntu
image without sshd: directory listing, create/save/reopen/rename/delete a temporary
file, terminal cwd/input/output/resize/close, cancellation, expired credentials,
network interruption and reconnect, and stop/start. Record actual observed results
here before describing this proof as validated against GitHub.

Live acceptance: pending.
