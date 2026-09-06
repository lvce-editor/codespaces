# GitHub Codespaces for LVCE Editor

[Open the web editor](https://lvce-editor.github.io/codespaces/) · [Setup guide](https://lvce-editor.github.io/codespaces/setup.html)

A browser extension and GitHub Pages export of LVCE Editor. The extension owns Codespaces setup and connection logic. Files, terminals, and workspace processes run inside the codespace; the UI runs on Pages.

## Try it

1. Open the web editor and sign in using the existing LVCE account button.
2. Open the command palette (F1), run **Codespaces: Set Up a Codespace**, and copy the generated command from the Codespaces Output panel.
3. Open or create a codespace at https://github.com/codespaces. Run the command in its workspace terminal (Linux x64, Node.js 24+).
4. Forward port **3774** using the Codespaces Ports tab and change its visibility to **Public**. The gateway requires your LVCE account. Do not publish the internal backend port.
5. Back in LVCE, run **Codespaces: Connect to Codespace** and enter the codespace name or forwarded HTTPS URL. Keep the setup terminal running.

The public port is an authenticated application endpoint, not an anonymous editor or shell. A session grants workspace access as the codespace user, including terminals. The workspace path is the initial folder, not a filesystem sandbox.

## How it works

The static export uses the same `@lvce-editor/shared-process` exporter as Explorer View. `builtin.codespaces` uses LVCE's existing `getAccessToken` API. Setup reads the account's OIDC subject and generates a command containing that identifier, never a token.

The setup script downloads remote-ssh v0.10.7 and Node.js v24.15.0, verifies pinned SHA-256 digests, starts the LVCE backend, and exposes a loopback HTTP/WebSocket gateway. Codespaces supplies public HTTPS forwarding. `/auth/connect` validates the LVCE access token against the existing `https://lvce-editor.dev/oidc/me` endpoint and compares the account to the owner chosen at setup. It exchanges the login for a random in-memory one-hour gateway session. Each WebSocket uses a short-lived, single-use ticket. The gateway checks the exact Pages origin, permits only LVCE workspace process types, and keeps its internal backend credential server-side.

No changes to the LVCE authentication backend are required. The existing backend token is not a GitHub API token and is never sent to api.github.com. Use only the forwarded URL belonging to the codespace where you ran setup.

## Current limits

- Initial codespace creation/start and running setup happen through GitHub. The current auth backend does not expose a GitHub token or request the `codespace` scope, so automatic API discovery, creation, and startup are not implemented.
- Private forwarded ports require GitHub browser authentication and are not supported by this cross-origin transport. Organizations that disallow public ports cannot use this version.
- Sessions expire after one hour, close when the gateway stops, and are not stored in the browser. After reload, restart, expiry, or codespace suspension, run Connect again. **Codespaces: Disconnect** closes local workspace connections.
- Setup currently supports Linux x64 Codespaces and requires Node.js 24+ to launch. Downloads are cached under `~/.lvce-codespaces`.
- The gateway is a single-user prototype. It limits pending authentication, sessions, tickets, and buffered data; it does not provide a production rate-limit service or persistent enrollment.

## Development

```sh
npm ci
npm run build:static
npm test
npm run type-check
npm run lint
npx playwright install chromium
npm run test:e2e
```

`node packages/build/src/serve-static.ts` serves the export at `http://127.0.0.1:4173/codespaces/`. For local gateway testing, use `LVCE_CODESPACES_ROOT=<temporary-directory> node .tmp/setup/setup.mjs --owner=<LVCE-account-subject> --local-test`. This uses the real LVCE authentication endpoint; it does not bypass login.

CI checks the extension and gateway, builds the static export, runs Chromium tests, and deploys `main` to GitHub Pages. Browser tests use a fixture identity with a real LVCE backend; that does not establish that GitHub's hosted forwarding has been tested.
