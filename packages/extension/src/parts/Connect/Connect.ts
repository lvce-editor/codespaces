import {
  GatewayConnectionError,
  GatewayUnreachableError,
  InvalidGatewayConnectionError,
} from '../../../../shared/src/Errors.ts'
export interface ConnectedWorkspace {
  readonly authentication: 'websocket-ticket'
  readonly sessionToken: string
  readonly websocketUrl: string
  readonly workspacePath: string
}

export const connectToGateway = async (
  endpoint: URL,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<ConnectedWorkspace> => {
  let response: Response
  try {
    response = await fetchFn(new URL('/auth/connect', endpoint), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new GatewayUnreachableError(
      'Cannot reach the Codespaces gateway. Check that setup is running and port 3774 is public in the Codespaces Ports tab; the gateway still requires your LVCE login.',
    )
  }
  if (!response.ok) {
    const hint =
      response.status === 403
        ? 'Sign in with the LVCE account used during setup.'
        : response.status === 401
          ? 'Sign in to LVCE again.'
          : 'Check the Codespace terminal and run setup again.'
    throw new GatewayConnectionError(
      `Codespaces connection failed (${response.status}). ${hint}`,
    )
  }
  const value = (await response.json()) as ConnectedWorkspace
  const websocket = new URL(value.websocketUrl || 'about:blank')
  if (
    value.authentication !== 'websocket-ticket' ||
    typeof value.sessionToken !== 'string' ||
    !value.sessionToken ||
    typeof value.workspacePath !== 'string' ||
    !value.workspacePath.startsWith('/') ||
    websocket.host !== endpoint.host ||
    websocket.protocol !== (endpoint.protocol === 'https:' ? 'wss:' : 'ws:') ||
    websocket.username ||
    websocket.password ||
    websocket.search ||
    websocket.hash
  ) {
    throw new InvalidGatewayConnectionError(
      'Codespaces gateway returned an invalid connection.',
    )
  }
  return value
}
