import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import * as Connection from '../src/Connection.ts'
import { createRemoteServerFileSystem } from '../src/FileSystem.ts'
import {
  FileExistsError,
  InvalidWebSocketTicketError,
  RemoteRequestError,
  RemoteServerNotPairedError,
  WebSocketAuthHttpError,
  WebSocketAuthNetworkError,
} from '../../shared/src/Errors.ts'

const options = {
  authority: 'test',
  sessionToken: 'session',
  websocketUrl: 'wss://test-3774.app.github.dev/',
}

test('unpaired operations report a named error and code', async () => {
  await Connection.dispose()
  for (const operation of [
    () => Connection.invoke('FileSystem.stat', 'file:///test'),
    () => Connection.getWebSocketUrl('file-system-process'),
  ]) {
    await assert.rejects(operation, {
      constructor: RemoteServerNotPairedError,
      name: 'RemoteServerNotPairedError',
      code: 'E_REMOTE_SERVER_NOT_PAIRED',
    })
  }
})

test('WebSocket authorization preserves existing codes and network causes', async (t) => {
  Connection.set(options)
  t.after(() => Connection.dispose())
  const cause = new TypeError('Failed to fetch')
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw cause
  })
  await assert.rejects(Connection.getWebSocketUrl('file-system-process'), {
    constructor: WebSocketAuthNetworkError,
    code: 'E_REMOTE_SERVER_WEBSOCKET_AUTH_NETWORK_ERROR',
    cause,
    message: 'Failed to authorize the remote WebSocket: Failed to fetch.',
  })
  fetchMock.mock.mockImplementation(
    async () => new Response(null, { status: 503 }),
  )
  await assert.rejects(Connection.getWebSocketUrl('file-system-process'), {
    constructor: WebSocketAuthHttpError,
    code: 'E_REMOTE_SERVER_WEBSOCKET_AUTH_HTTP_ERROR',
  })
  fetchMock.mock.mockImplementation(async () => Response.json({ ticket: 42 }))
  await assert.rejects(Connection.getWebSocketUrl('file-system-process'), {
    constructor: InvalidWebSocketTicketError,
    code: 'E_REMOTE_SERVER_WEBSOCKET_AUTH_INVALID_RESPONSE',
  })
})

test('RPC errors preserve remote codes and supply a fallback code', async (t) => {
  const backend = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  t.after(async () => {
    await Connection.dispose()
    for (const client of backend.clients) client.terminate()
    await new Promise<void>((resolve) => backend.close(() => resolve()))
  })
  await once(backend, 'listening')
  const address = backend.address()
  assert.ok(address && typeof address !== 'string')
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ticket: 'ticket' }),
  )
  Connection.set({
    ...options,
    websocketUrl: `ws://127.0.0.1:${address.port}/`,
  })
  backend.on('connection', (socket) => {
    socket.on('message', (data) => {
      const { id, params } = JSON.parse(String(data))
      socket.send(JSON.stringify({ id, jsonrpc: '2.0', error: params[0] }))
    })
  })
  for (const [error, code] of [
    [
      { message: 'File not found', code: -32000, data: { code: 'ENOENT' } },
      'ENOENT',
    ],
    [{ message: 'File exists', code: 'EEXIST' }, 'EEXIST'],
    [{ message: 'Invalid request', code: -32600 }, '-32600'],
    [{ message: 'Unknown failure' }, 'E_REMOTE_REQUEST_FAILED'],
  ] as const) {
    await assert.rejects(Connection.invoke('test', error), {
      constructor: RemoteRequestError,
      name: 'RemoteRequestError',
      code,
      message: error.message,
    })
  }
})

test('rename rejects existing destinations and proceeds on remote ENOENT', async (t) => {
  Connection.set(options)
  t.after(() => Connection.dispose())
  const existing = createRemoteServerFileSystem(async () => ({}))
  await assert.rejects(
    existing.rename('codespaces://test/old', 'codespaces://test/new'),
    {
      constructor: FileExistsError,
      code: 'EEXIST',
    },
  )
  const calls: string[] = []
  const missing = createRemoteServerFileSystem(async (method) => {
    calls.push(method)
    if (method === 'FileSystem.stat')
      throw new RemoteRequestError('File not found', 'ENOENT')
  })
  await missing.rename('codespaces://test/old', 'codespaces://test/new')
  assert.deepEqual(calls, ['FileSystem.stat', 'FileSystem.rename'])
})
