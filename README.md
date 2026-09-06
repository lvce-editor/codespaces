# GitHub Codespaces for LVCE Editor

[Open the web editor](https://lvce-editor.github.io/codespaces/) · [Setup guide](https://lvce-editor.github.io/codespaces/setup.html)

Create, start, stop, and connect to GitHub Codespaces from a static GitHub Pages export of LVCE Editor. The extension handles the workflow and installs the remote LVCE runtime automatically. No local CLI, Codespace terminal command, or public forwarded port is needed.

## Try it

1. Sign in with GitHub through the LVCE account button. If you signed in before Codespaces support was added, run **Codespaces: Authorize GitHub Access** and approve the additional GitHub permission.
2. Run **Codespaces: Connect to Codespace** (F1) and select a Codespace. A stopped Codespace starts automatically. Alternatively, **Codespaces: Set Up a Codespace** asks for `owner/repository` and creates one using GitHub defaults after confirmation.
3. Wait while the extension installs its runtime and connects. Progress appears in the Codespaces Output panel.
4. Use **Codespaces: Stop Codespace** when finished to stop GitHub compute. **Disconnect** closes the editor connection or cancels setup; it does not stop the Codespace or remove its storage.

GitHub's billing, quota, repository permissions, and organization policies apply. Creating a Codespace starts compute and can incur charges. Stopped Codespaces can still incur storage charges.

## How it works

The static export uses the same `@lvce-editor/shared-process` exporter as Explorer View. The extension calls authenticated `/codespaces` endpoints on `lvce-editor.dev` with the existing LVCE OIDC access token. Backend-2 requests GitHub's `codespace` OAuth scope and keeps the GitHub token server-side.

Lifecycle operations use GitHub's public REST API. Connection sessions use GitHub CLI's authenticated SSH transport on backend-2. The backend downloads this extension's setup artifact inside the Codespace, runs it with a checksum-verified Node runtime, and privately forwards the LVCE backend port over SSH. Setup installs checksum-verified remote-ssh v0.10.7 and Node v24.15.0. The extension then opens files, terminals, and workspace processes through the relay.

Each connection has an isolated SSH key and configuration directory. HTTP operations require a valid LVCE token, the exact Pages origin, and session ownership. Browser WebSockets use single-use, short-lived tickets. GitHub tokens and the remote LVCE backend token never reach the browser. Connection sessions expire after one hour and close their SSH processes and sockets when disconnected. Files and processes run with the Codespace user's permissions; the workspace path is not a filesystem sandbox.

## Current requirements and limits

- Backend-2 must be deployed with the Codespaces endpoints and its updated Docker image, which includes GitHub CLI and OpenSSH. Existing users must authorize the additional GitHub scope.
- The remote devcontainer must be Linux x64, with Bash, curl, tar, sha256sum, and an SSH server. GitHub's default Codespaces image supplies these; custom images may need the [sshd devcontainer feature](https://cli.github.com/manual/gh_codespace_ssh).
- Sessions live in one backend process. Multiple replicas require session affinity. Reloading the browser requires connecting again; abandoned sessions expire after one hour. Disconnecting never stops GitHub compute automatically.
- GitHub default machine, region, branch, and devcontainer settings are used for creation. Custom selection is not yet exposed.
- The older manually configured gateway remains available as **Codespaces: Connect to Manual Gateway**. The primary flow uses private SSH forwarding.

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

`node packages/build/src/serve-static.ts` serves the export at `http://127.0.0.1:4173/codespaces/`. CI runs unit and Chromium tests and deploys `main` to Pages. Browser tests cover creation, connection, file saving, and stopping using a fixture management API and a real LVCE file backend. Backend-2 separately tests ownership, private relay traffic, ticket replay rejection, and cancellation. These fixtures do not establish that a real GitHub-hosted Codespace has been tested.
