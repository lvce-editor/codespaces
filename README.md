# GitHub Codespaces for LVCE Editor

[Open the web editor](https://lvce-editor.github.io/codespaces/) · [Setup guide](https://lvce-editor.github.io/codespaces/setup.html)

Create, start, stop, and connect to GitHub Codespaces from a static GitHub Pages export of LVCE Editor. The extension handles the workflow and installs the remote LVCE runtime automatically. No local CLI, Codespace terminal command, or public forwarded port is needed.

## Try it

1. Sign in with GitHub through the LVCE account button. If you signed in before Codespaces support was added, run **Codespaces: Authorize GitHub Access** and approve the additional GitHub permission.
2. Run **Codespaces: Connect to Codespace** (F1) and select a Codespace. A stopped Codespace starts automatically. Alternatively, **Codespaces: Set Up a Codespace** loads a searchable list of repositories from your GitHub account (including subsequent pages), with a manual `owner/repository` option and creates one using GitHub defaults after confirmation.
3. Wait while the extension installs its runtime and connects. The Codespaces Output panel shows GitHub startup states, remote setup stages, recent stage history, and elapsed time while waiting.
4. Use **Codespaces: Stop Codespace** when finished to stop GitHub compute, or **Codespaces: Stop All Codespaces** to stop all your active Codespaces across repositories. Stop All skips stopped or stopping Codespaces and reports individual failures while continuing with the others. **Disconnect** closes the editor connection or cancels setup; it does not stop the Codespace or remove its storage.

GitHub's billing, quota, repository permissions, and organization policies apply. Creating a Codespace starts compute and can incur charges. Stopped Codespaces can still incur storage charges.

## How it works

The static export uses the same `@lvce-editor/shared-process` exporter as Explorer View. The extension obtains the signed-in user's GitHub token from `POST https://lvce-editor.dev/codespaces/auth/github-token`, authenticated with the existing LVCE OIDC access token. Each management command obtains one token and keeps it only in memory for its repository selection, pagination, and startup polling. Command completion or cancellation discards the token; it is never saved in browser storage. Backend-2's existing GitHub OAuth scopes and database token storage are unchanged.

Repository listing, Codespace creation, start/stop, and state polling call `https://api.github.com` directly from the browser using the GitHub token. GitHub errors and authorization guidance are shown in the editor; mutating operations are not automatically retried. After a successful stop, the browser separately asks backend-2 to close that account's relay sessions for the Codespace, including other tabs. Cleanup failure is reported separately from a successful GitHub stop. Connection sessions use GitHub CLI's authenticated SSH transport on backend-2. The backend downloads this extension's setup artifact inside the Codespace, runs it with a checksum-verified Node runtime, and privately forwards the LVCE backend port over SSH. Setup installs checksum-verified remote-ssh v0.10.7 and Node v24.15.0. The extension then opens files, terminals, and workspace processes through the relay. Codespaces connections explicitly select interactive Bash on the remote Linux container, without querying a local desktop process.

Sign-in callbacks return to the Codespaces page. The first credential request restores the static editor’s account state, including pending sign-in callbacks, so expired LVCE tokens can refresh. Initialization is shared across polling requests.

Each connection has an isolated SSH key and configuration directory. HTTP operations require a valid LVCE token, the exact Pages origin, and session ownership. Browser WebSockets use single-use, short-lived tickets. The GitHub token is accessible to the frontend during a management command and is sent only to GitHub. LVCE tokens continue to authorize backend-2 requests. The OAuth client secret and remote LVCE backend token never reach the browser. File contents and terminal traffic still pass through backend-2's SSH relay. Connection sessions expire after one hour and close their SSH processes and sockets when disconnected. Files and processes run with the Codespace user's permissions; the workspace path is not a filesystem sandbox.

## Current requirements and limits

- Deploy backend-2 with the token handoff and named relay cleanup endpoints before deploying this frontend. Older management proxies can be removed after the frontend deploys; older tabs must then reload. Backend-2 must be deployed with the Codespaces endpoints and its updated Docker image, which includes GitHub CLI and OpenSSH. Existing users must authorize the additional GitHub scope.
- The remote devcontainer must be Linux x64, with Bash, curl, tar, sha256sum, and an SSH server. GitHub's default Codespaces image supplies these; custom images may need the [sshd devcontainer feature](https://cli.github.com/manual/gh_codespace_ssh).
- Sessions live in one backend process. Multiple replicas require session affinity. Reloading the browser requires connecting again; abandoned sessions expire after one hour. Disconnecting never stops GitHub compute automatically.
- GitHub default machine, region, branch, and devcontainer settings are used for creation. Custom selection is not yet exposed.
- The older manually configured gateway remains available as **Codespaces: Connect to Manual Gateway**. The primary flow uses private SSH forwarding.

## Recover a container without SSH

GitHub can report a Codespace as available even when its custom container has
no SSH server. Run **Codespaces: Open in Browser** to open GitHub's editor for
the last attempted Codespace. For a Debian/Ubuntu devcontainer, merge this
feature into `.devcontainer/devcontainer.json` and run **Codespaces: Rebuild
Container** in GitHub's editor:

```json
{
  "features": {
    "ghcr.io/devcontainers/features/sshd:1": { "version": "latest" }
  }
}
```

Preserve existing devcontainer settings when adding the feature. A rebuild
recreates the container, so preserve any work outside `/workspaces` first.
Installing `openssh-server` manually can repair the current container if you
have administrator access, but does not survive a rebuild. LVCE cannot install
the remote runtime until SSH works. See [GitHub CLI's SSH
requirements](https://cli.github.com/manual/gh_codespace_ssh).

## Development

```sh
npm ci
npm run build:static
npm test
npm run type-check
npm run lint
npm exec --workspace=packages/e2e -- playwright install chromium
npm run test:e2e
```

E2e configuration and dependencies live in the `packages/e2e` npm workspace.

`node packages/build/src/serve-static.ts` serves the export at `http://127.0.0.1:4173/codespaces/`. CI runs unit and Chromium tests and deploys `main` to Pages. Browser tests cover creation, connection, file saving, and stopping using separate GitHub and LVCE API fixtures and a real LVCE file backend. They verify request destinations, credential separation, and one GitHub token handoff per management command. Backend-2 separately tests ownership, private relay traffic, ticket replay rejection, and cancellation. These fixtures do not establish that a real GitHub-hosted Codespace has been tested.
