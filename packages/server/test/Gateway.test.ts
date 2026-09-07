import {
  AuthenticationError,
  HttpsRequiredError,
  InvalidGatewayOptionsError,
} from '../../shared/src/Errors.ts'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { createGateway } from '../src/Gateway.ts'

const origin = 'https://lvce-editor.github.io'
test('authenticates the owner, enforces origins, and proxies one-use WebSocket tickets', async () => {
  const backend = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(backend, 'listening')
  const address = backend.address()
  assert.ok(address && typeof address !== 'string')
  backend.on('connection', (socket, request) => {
    assert.equal(
      new URL(request.url!, 'http://localhost').searchParams.get('token'),
      'internal-secret',
    )
    socket.on('message', (data) => socket.send(data.toString()))
  })
  const gateway = await createGateway({
    owner: 'owner',
    allowedOrigin: origin,
    publicUrl: 'https://test-3774.app.github.dev',
    workspacePath: '/workspaces/test',
    backendPort: address.port,
    backendToken: 'internal-secret',
    port: 0,
    verifyAccount: async (token) => {
      if (token === 'good') return 'owner'
      if (token === 'other') return 'other'
      throw new AuthenticationError('bad')
    },
  })
  const base = `http://127.0.0.1:${gateway.port}`
  const post = (route: string, token = '', requestOrigin = origin) =>
    fetch(base + route, {
      method: 'POST',
      headers: { origin: requestOrigin, authorization: `Bearer ${token}` },
    })
  try {
    assert.equal(
      (await post('/auth/connect', 'good', 'https://evil.com')).status,
      403,
    )
    assert.equal((await post('/auth/connect')).status, 401)
    assert.equal((await post('/auth/connect', 'bad')).status, 401)
    assert.equal((await post('/auth/connect', 'other')).status, 403)
    assert.equal((await post('/auth/pair', 'good')).status, 404)
    const preflight = await fetch(base + '/auth/connect', {
      method: 'OPTIONS',
      headers: { origin },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
    const connected = await post('/auth/connect', 'good')
    assert.equal(connected.status, 200)
    const session = await connected.json()
    assert.equal(session.workspacePath, '/workspaces/test')
    assert.ok(!JSON.stringify(session).includes('internal-secret'))
    assert.equal((await post('/auth/websocket-ticket', 'unknown')).status, 401)
    const { ticket } = await (
      await post('/auth/websocket-ticket', session.sessionToken)
    ).json()
    const url =
      base.replace('http:', 'ws:') +
      '/websocket/file-system-process?ticket=' +
      ticket
    const socket = new WebSocket(url, { origin })
    await once(socket, 'open')
    const message = once(socket, 'message')
    socket.send('hello')
    assert.equal(String((await message)[0]), 'hello')
    const replay = new WebSocket(url, { origin })
    const [error] = await once(replay, 'error')
    assert.match(error.message, /401/)
    socket.close()
    await once(socket, 'close')
  } finally {
    await gateway.close()
    const { promise, resolve } = Promise.withResolvers<void>()
    backend.close(() => resolve())
    await promise
  }
})

test('invalid gateway configuration rejects with specific error codes', async () => {
  const options = {
    owner: 'owner',
    allowedOrigin: origin,
    publicUrl: 'https://test-3774.app.github.dev',
    workspacePath: '/workspaces/test',
    backendPort: 1234,
    backendToken: 'internal-secret',
    port: 0,
  }
  await assert.rejects(createGateway({ ...options, owner: '' }), {
    constructor: InvalidGatewayOptionsError,
    code: 'E_INVALID_GATEWAY_OPTIONS',
  })
  await assert.rejects(
    createGateway({ ...options, publicUrl: 'http://example.com' }),
    {
      constructor: HttpsRequiredError,
      code: 'E_HTTPS_REQUIRED',
    },
  )
})
