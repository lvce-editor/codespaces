import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectToGateway } from '../src/parts/Connect/Connect.ts'
import { getEndpoint, getSetupCommand } from '../src/parts/Urls/Urls.ts'

test('resolves codespace names and rejects token exfiltration endpoints', () => {
  assert.equal(
    getEndpoint('silver-tree-abc123').href,
    'https://silver-tree-abc123-3774.app.github.dev/',
  )
  for (const value of [
    'https://example.com',
    'https://foo-3774.app.github.dev.evil.com',
    'https://user:pass@foo-3774.app.github.dev',
    'https://foo-3774.app.github.dev/?token=secret',
    'file:///tmp',
    'http://foo-3774.app.github.dev',
  ])
    assert.throws(() => getEndpoint(value))
})
test('setup command contains account id, never an access token, and quotes shell input', () => {
  assert.ok(getSetupCommand('account-id').endsWith("--owner='account-id'"))
  assert.ok(getSetupCommand("a'b").endsWith("--owner='a'\\''b'"))
})
test('connection keeps credentials in headers and requires matching websocket authority', async () => {
  const endpoint = getEndpoint('silver-tree-abc123')
  const response = {
    authentication: 'websocket-ticket',
    sessionToken: 'session',
    websocketUrl: 'wss://silver-tree-abc123-3774.app.github.dev/',
    workspacePath: '/workspaces/demo',
  }
  let sent: RequestInit | undefined
  const result = await connectToGateway(
    endpoint,
    'lvce-token',
    async (url, init) => {
      assert.equal(String(url), `${endpoint.origin}/auth/connect`)
      sent = init
      return Response.json(response)
    },
  )
  assert.equal(result.sessionToken, 'session')
  assert.deepEqual(sent?.headers, { Authorization: 'Bearer lvce-token' })
  assert.equal(sent?.redirect, 'error')
  await assert.rejects(
    connectToGateway(endpoint, 'token', async () =>
      Response.json({ ...response, websocketUrl: 'wss://evil.com/' }),
    ),
    /invalid connection/,
  )
})
test('private forwarded ports and expired login report actionable failures', async () => {
  await assert.rejects(
    connectToGateway(getEndpoint('test'), 'token', async () => {
      throw new TypeError('Failed to fetch')
    }),
    /port 3774 is public/,
  )
  await assert.rejects(
    connectToGateway(
      getEndpoint('test'),
      'token',
      async () => new Response(null, { status: 403 }),
    ),
    /account used during setup/,
  )
})
