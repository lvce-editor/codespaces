import {
  AuthenticationError,
  GatewayStartupError,
  HttpsRequiredError,
  InvalidAccountIdError,
  InvalidGatewayOptionsError,
} from '../../shared/src/Errors.ts'
import { randomBytes } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'

const processTypes = new Set([
  'extension-node-process',
  'file-system-process',
  'process-explorer',
  'search-process',
  'terminal-process',
])
const sessionTtl = 60 * 60 * 1000
const ticketTtl = 60 * 1000
const limit = 1024 * 1024
export interface GatewayOptions {
  readonly owner: string
  readonly allowedOrigin: string
  readonly publicUrl: string
  readonly workspacePath: string
  readonly backendPort: number
  readonly backendToken: string
  readonly port: number
  readonly verifyAccount?: (token: string) => Promise<string>
}
// Only this fixed, existing LVCE backend receives the LVCE access token.
export const verifyAccount = async (token: string): Promise<string> => {
  const response = await fetch('https://lvce-editor.dev/oidc/me', {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new AuthenticationError('Authentication failed')
  const account = await response.json()
  if (typeof account.sub !== 'string' || !account.sub)
    throw new InvalidAccountIdError('Invalid identity')
  return account.sub
}
const bearer = (request: IncomingMessage): string => {
  const header = request.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}
const json = (
  response: ServerResponse,
  status: number,
  value: unknown,
): void => {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}
const secret = (): string => randomBytes(32).toString('hex')
export const createGateway = async (options: GatewayOptions) => {
  if (!options.owner || !options.workspacePath.startsWith('/'))
    throw new InvalidGatewayOptionsError(
      'Owner and absolute workspace path are required',
    )
  const publicUrl = new URL(options.publicUrl)
  const origin = new URL(options.allowedOrigin).origin
  for (const url of [publicUrl, new URL(origin)]) {
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && url.hostname === '127.0.0.1')
    )
      throw new HttpsRequiredError('HTTPS is required')
  }
  const sessions = new Map<string, number>()
  const tickets = new Map<string, { expires: number; session: string }>()
  const clients = new Set<WebSocket>()
  const prune = (): void => {
    for (const [key, expires] of sessions)
      if (expires <= Date.now()) sessions.delete(key)
    for (const [key, ticket] of tickets)
      if (ticket.expires <= Date.now() || !sessions.has(ticket.session))
        tickets.delete(key)
  }
  let pendingAuthentication = 0
  let closed = false
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.headers.origin !== origin) {
      json(response, 403, { error: 'Origin is not allowed' })
      return
    }
    response.setHeader('access-control-allow-origin', origin)
    response.setHeader('vary', 'Origin')
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-max-age': '600',
      })
      response.end()
      return
    }
    if (request.method !== 'POST') {
      json(response, 404, { error: 'Not found' })
      return
    }
    prune()
    if (request.url === '/auth/connect') {
      const token = bearer(request)
      if (!token || token.length > 8192) {
        json(response, 401, { error: 'Sign in to LVCE' })
        return
      }
      if (pendingAuthentication >= 4 || sessions.size >= 32) {
        json(response, 429, { error: 'Too many connections' })
        return
      }
      pendingAuthentication++
      let owner: string
      try {
        owner = await (options.verifyAccount || verifyAccount)(token)
      } catch {
        json(response, 401, { error: 'Sign in to LVCE again' })
        return
      } finally {
        pendingAuthentication--
      }
      if (closed || response.destroyed) return
      if (owner !== options.owner) {
        json(response, 403, {
          error: 'This Codespace belongs to another LVCE account',
        })
        return
      }
      const sessionToken = secret()
      sessions.set(sessionToken, Date.now() + sessionTtl)
      const websocket = new URL(publicUrl)
      websocket.protocol = websocket.protocol === 'https:' ? 'wss:' : 'ws:'
      websocket.pathname = '/'
      websocket.search = ''
      websocket.hash = ''
      json(response, 200, {
        authentication: 'websocket-ticket',
        sessionToken,
        websocketUrl: websocket.href,
        workspacePath: options.workspacePath,
      })
      return
    }
    if (request.url === '/auth/websocket-ticket') {
      const session = bearer(request)
      if (!sessions.has(session)) {
        json(response, 401, { error: 'Session expired. Connect again.' })
        return
      }
      if (tickets.size >= 128) {
        json(response, 429, { error: 'Too many pending connections' })
        return
      }
      const ticket = secret()
      tickets.set(ticket, { expires: Date.now() + ticketTtl, session })
      json(response, 200, { ticket })
      return
    }
    json(response, 404, { error: 'Not found' })
  }
  const server = createServer(
    { maxHeaderSize: 16 * 1024, requestTimeout: 15_000 },
    (request, response) => {
      void handle(request, response).catch(() => {
        if (!response.headersSent)
          json(response, 500, { error: 'Gateway unavailable' })
        else response.end()
      })
    },
  )
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
  })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const type = url.pathname.slice('/websocket/'.length)
    const token = url.searchParams.get('ticket') || ''
    prune()
    const ticket = tickets.get(token)
    if (
      request.headers.origin !== origin ||
      !url.pathname.startsWith('/websocket/') ||
      !processTypes.has(type) ||
      !ticket ||
      clients.size >= 128
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    tickets.delete(token)
    wss.handleUpgrade(request, socket, head, (client) => {
      const backendUrl = new URL(
        `ws://127.0.0.1:${options.backendPort}/websocket/${type}`,
      )
      backendUrl.searchParams.set('token', options.backendToken)
      const backend = new WebSocket(backendUrl, {
        handshakeTimeout: 10_000,
        maxPayload: 16 * 1024 * 1024,
      })
      clients.add(client)
      clients.add(backend)
      const pending: Array<{ data: Buffer; binary: boolean }> = []
      let pendingBytes = 0
      let disposed = false
      const close = (): void => {
        if (disposed) return
        disposed = true
        clearTimeout(expiry)
        pending.length = 0
        client.terminate()
        backend.terminate()
        clients.delete(client)
        clients.delete(backend)
      }
      const expiry = setTimeout(
        close,
        Math.max(1, (sessions.get(ticket.session) || 0) - Date.now()),
      )
      client.on('error', close)
      backend.on('error', close)
      client.on('close', close)
      backend.on('close', close)
      client.on('message', (data, binary) => {
        if (backend.readyState === WebSocket.OPEN) {
          if (backend.bufferedAmount > 16 * limit) {
            close()
            return
          }
          backend.send(data, { binary })
        } else {
          const bytes = Buffer.from(data as ArrayBuffer)
          pendingBytes += bytes.length
          if (pendingBytes > limit) {
            close()
            return
          }
          pending.push({ data: bytes, binary })
        }
      })
      backend.on('open', () => {
        for (const message of pending)
          backend.send(message.data, { binary: message.binary })
        pending.length = 0
        pendingBytes = 0
      })
      backend.on('message', (data, binary) => {
        if (client.readyState !== WebSocket.OPEN) return
        if (client.bufferedAmount > 16 * limit) {
          close()
          return
        }
        client.send(data, { binary })
      })
    })
  })
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  server.once('error', reject)
  server.listen(options.port, '127.0.0.1', resolve)
  await promise
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new GatewayStartupError('Gateway did not start')
  if (publicUrl.hostname === '127.0.0.1' && publicUrl.port === '0')
    publicUrl.port = String(address.port)
  let closing: Promise<void> | undefined
  return {
    port: address.port,
    close: (): Promise<void> =>
      (closing ||= (async () => {
        closed = true
        sessions.clear()
        tickets.clear()
        for (const client of clients) client.terminate()
        wss.close()
        server.closeAllConnections()
        const { promise, resolve } = Promise.withResolvers<void>()
        server.close(() => resolve())
        await promise
      })()),
  }
}
