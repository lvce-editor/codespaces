import {
  InvalidRpcResponseError,
  InvalidWebSocketTicketError,
  RemoteAuthorityError,
  RemoteConnectionClosedError,
  RemoteRequestError,
  RemoteRequestTimeoutError,
  RemoteServerNotPairedError,
  WebSocketAuthHttpError,
  WebSocketAuthNetworkError,
  WebSocketClosedError,
  WebSocketError,
  WebSocketTimeoutError,
} from '../../shared/src/Errors.ts'
import { getToken } from './Auth.ts'

interface ConnectionOptions {
  readonly authority?: string
  readonly refreshLvceToken?: boolean
  readonly sessionToken: string
  readonly websocketUrl: string
}

export const commandId = 'codespaces.getWebSocketUrl'

interface RpcError {
  readonly code?: number | string
  readonly data?: { readonly code?: number | string }
  readonly message?: string
}

interface RpcResponse {
  readonly error?: RpcError
  readonly id?: number
  readonly result?: unknown
}

interface PendingRequest {
  readonly reject: (error: Error) => void
  readonly resolve: (value: unknown) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

interface Rpc {
  readonly close: () => void
  readonly invoke: (
    method: string,
    ...params: readonly unknown[]
  ) => Promise<unknown>
}

const state: {
  generation: number
  options: ConnectionOptions | undefined
  rpc: Promise<Rpc> | undefined
} = {
  generation: 0,
  options: undefined,
  rpc: undefined,
}

const getWebSocketErrorDetail = (event: unknown): string => {
  if (!event || typeof event !== 'object') {
    return ''
  }
  if ('error' in event && event.error instanceof Error && event.error.message) {
    return event.error.message
  }
  if ('message' in event && typeof event.message === 'string') {
    return event.message
  }
  return ''
}

const getWebSocketCloseDetail = (event: unknown): string => {
  if (!event || typeof event !== 'object') {
    return ''
  }
  const code =
    'code' in event && typeof event.code === 'number' ? event.code : undefined
  const reason =
    'reason' in event && typeof event.reason === 'string'
      ? event.reason.trim()
      : ''
  if (code !== undefined && reason) {
    return ` (close code ${code}: ${reason})`
  }
  if (code === 1006) {
    return ' (close code 1006: the network connection was lost without a close frame)'
  }
  if (code !== undefined) {
    return ` (close code ${code})`
  }
  return reason ? ` (${reason})` : ''
}

const getErrorDetail = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error)
  }
  if (error.cause instanceof Error) {
    return error.cause.message
  }
  return error.message
}

const getHttpErrorHint = (status: number): string => {
  if (status === 404) {
    return ' The remote server does not provide the WebSocket ticket endpoint.'
  }
  if (status >= 500) {
    return ' The remote server is temporarily unavailable.'
  }
  return ''
}

const toError = (value: RpcError | undefined): RemoteRequestError => {
  const code = value?.data?.code ?? value?.code
  return new RemoteRequestError(
    value?.message || 'Remote server request failed',
    typeof code === 'string' || typeof code === 'number'
      ? String(code)
      : undefined,
  )
}

const getTicket = async (options: ConnectionOptions): Promise<string> => {
  const endpoint = new URL('auth/websocket-ticket', options.websocketUrl)
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'
  let response: Response
  try {
    response = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${options.refreshLvceToken ? await getToken() : options.sessionToken}`,
      },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    const detail = getErrorDetail(error)
    throw new WebSocketAuthNetworkError(
      `Failed to authorize the remote WebSocket: ${detail}.`,
      { cause: error },
    )
  }
  if (!response.ok) {
    const statusText = response.statusText ? ` ${response.statusText}` : ''
    const hint = getHttpErrorHint(response.status)
    throw new WebSocketAuthHttpError(
      `Failed to authorize the remote WebSocket: HTTP ${response.status}${statusText}.${hint}`,
    )
  }
  const result = (await response.json()) as { readonly ticket?: unknown }
  if (typeof result.ticket !== 'string') {
    throw new InvalidWebSocketTicketError(
      'Remote server returned an invalid WebSocket ticket',
    )
  }
  return result.ticket
}

const createWebSocketUrl = async (
  options: ConnectionOptions,
  type: string,
): Promise<string> => {
  const url = new URL(
    `websocket/${encodeURIComponent(type)}`,
    options.websocketUrl,
  )
  url.searchParams.set('ticket', await getTicket(options))
  return url.href
}

const createRpc = async (
  options: ConnectionOptions,
  generation: number,
): Promise<Rpc> => {
  const webSocket = new WebSocket(
    await createWebSocketUrl(options, 'file-system-process'),
  )
  const pending = new Map<number, PendingRequest>()
  let nextId = 1
  let closed = false
  const { promise: ready, reject, resolve } = Promise.withResolvers<void>()
  void ready.catch(() => {})
  const handshakeTimer = setTimeout(() => {
    close(
      new WebSocketTimeoutError('Codespaces WebSocket connection timed out'),
    )
    webSocket.close()
  }, 20_000)

  const close = (
    error: Error = new RemoteConnectionClosedError(
      'Remote server connection closed',
    ),
  ): void => {
    if (closed) {
      return
    }
    closed = true
    clearTimeout(handshakeTimer)
    reject(error)
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    pending.clear()
    if (state.generation === generation) {
      state.rpc = undefined
    }
  }

  webSocket.onopen = (): void => {
    clearTimeout(handshakeTimer)
    resolve()
  }
  webSocket.onerror = (event): void => {
    const detail = getWebSocketErrorDetail(event)
    const suffix = detail ? `: ${detail}` : ''
    close(new WebSocketError(`Remote server WebSocket failed${suffix}`))
  }
  webSocket.onclose = (event): void =>
    close(
      new WebSocketClosedError(
        `Remote server WebSocket closed${getWebSocketCloseDetail(event)}`,
      ),
    )
  webSocket.onmessage = (event): void => {
    try {
      const response = JSON.parse(String(event.data)) as RpcResponse
      if (!Number.isSafeInteger(response.id)) {
        throw new InvalidRpcResponseError(
          'Remote server returned invalid JSON-RPC',
        )
      }
      const request = pending.get(response.id!)
      if (!request) {
        return
      }
      clearTimeout(request.timeout)
      pending.delete(response.id!)
      if (response.error) {
        request.reject(toError(response.error))
      } else {
        request.resolve(response.result)
      }
    } catch (error) {
      close(
        error instanceof Error
          ? error
          : new InvalidRpcResponseError(String(error), { cause: error }),
      )
      webSocket.close()
    }
  }

  return {
    close: (): void => {
      close()
      webSocket.close()
    },
    invoke: async (method, ...params): Promise<unknown> => {
      await ready
      if (closed) {
        throw new RemoteConnectionClosedError(
          'Remote server connection is closed',
        )
      }
      const id = nextId++
      const {
        promise,
        resolve: resolveRequest,
        reject: rejectRequest,
      } = Promise.withResolvers<unknown>()
      const timeout = setTimeout(() => {
        pending.delete(id)
        rejectRequest(
          new RemoteRequestTimeoutError('Remote server request timed out'),
        )
      }, 120_000)
      pending.set(id, {
        reject: rejectRequest,
        resolve: resolveRequest,
        timeout,
      })
      try {
        webSocket.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }))
      } catch (error) {
        rejectRequest(error)
      }
      return promise
    },
  }
}

const closeRpc = async (rpcPromise: Promise<Rpc>): Promise<void> => {
  try {
    const rpc = await rpcPromise
    rpc.close()
  } catch {
    // A failed connection has no live transport to close.
  }
}

export const set = (options: ConnectionOptions): void => {
  if (state.rpc) {
    void closeRpc(state.rpc)
  }
  state.generation++
  state.options = options
  state.rpc = undefined
}

export const dispose = async (): Promise<void> => {
  const { rpc } = state
  state.generation++
  state.options = undefined
  state.rpc = undefined
  if (rpc) {
    await closeRpc(rpc)
  }
}

export const invoke = async (
  method: string,
  ...params: readonly unknown[]
): Promise<unknown> => {
  if (!state.options) {
    throw new RemoteServerNotPairedError('Remote server is not paired')
  }
  state.rpc ||= createRpc(state.options, state.generation)
  const rpc = await state.rpc
  return rpc.invoke(method, ...params)
}

export const getWebSocketUrl = async (type: string): Promise<string> => {
  if (!state.options) {
    throw new RemoteServerNotPairedError('Remote server is not paired')
  }
  return createWebSocketUrl(state.options, type)
}

export const assertAuthority = (authority: string): void => {
  if (
    !state.options ||
    (state.options.authority || new URL(state.options.websocketUrl).host) !==
      authority
  ) {
    throw new RemoteAuthorityError(
      'This file belongs to a different or disconnected Codespace.',
    )
  }
}
