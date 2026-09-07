import {
  CodespaceSetupError,
  CodespaceSetupTimeoutError,
  CodespacesRequestError,
  InvalidRelayAddressError,
  InvalidWorkspacePathError,
} from '../../../../shared/src/Errors.ts'
import { sleep } from '../Sleep/Sleep.ts'
import { getToken } from '../Auth/Auth.ts'
import { backendUrl } from '../Urls/Urls.ts'

export const request = async <T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> => {
  const response = await fetch(`${backendUrl}/codespaces${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(35_000)])
      : AbortSignal.timeout(35_000),
  })
  if (!response.ok) {
    const value = await response.json().catch(() => ({}))
    const hint =
      response.status === 403
        ? ' Run Codespaces: Authorize GitHub Access if authorization is missing.'
        : ''
    throw new CodespacesRequestError(
      `${value.error || `Codespaces request failed (${response.status})`}${hint}`,
    )
  }
  return response.status === 204 ? (undefined as T) : response.json()
}
export type OnProgress = (message: string) => Promise<void>

const setupMessages: Record<string, string> = {
  'connecting-ssh': 'Connecting to the Codespace…',
  'downloading-node': 'Downloading Node.js for setup…',
  'verifying-node': 'Verifying and extracting Node.js for setup…',
  'downloading-setup': 'Downloading the LVCE setup program…',
  'installing-runtime': 'Checking and installing the LVCE runtime…',
  'installing-node': 'Checking and installing the remote Node.js runtime…',
  'installing-server': 'Checking and installing the LVCE remote server…',
  'starting-server': 'Starting the LVCE remote server…',
  'opening-tunnel': 'Establishing the private connection…',
}

export const prepare = async (
  name: string,
  signal: AbortSignal,
  onSession: (id: string) => void,
  onProgress: OnProgress,
) => {
  await onProgress('Requesting a private connection…')
  const value = await request<{ id: string; websocketUrl: string }>(
    `/${name}/connect`,
    'POST',
    undefined,
    signal,
  )
  onSession(value.id)
  const url = new URL(value.websocketUrl)
  if (
    url.origin !== backendUrl.replace('https:', 'wss:') ||
    url.pathname !== `/codespaces/connections/${value.id}/` ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new InvalidRelayAddressError('Invalid Codespaces relay address')
  const deadline = Date.now() + 6 * 60_000
  while (Date.now() < deadline) {
    const status = await request<{
      state: string
      error?: string
      stage?: string
      workspacePath?: string
    }>(`/connections/${value.id}`, 'GET', undefined, signal)
    if (status.state === 'failed')
      throw new CodespaceSetupError(status.error || 'Codespace setup failed')
    if (status.state === 'ready') {
      if (!status.workspacePath?.startsWith('/'))
        throw new InvalidWorkspacePathError('Invalid workspace path')
      return {
        sessionToken: await getToken(),
        websocketUrl: value.websocketUrl,
        workspacePath: status.workspacePath,
      }
    }
    await onProgress(
      (status.stage &&
        Object.hasOwn(setupMessages, status.stage) &&
        setupMessages[status.stage]) ||
        'Waiting for remote setup and the private connection…',
    )
    await sleep(signal)
  }
  throw new CodespaceSetupTimeoutError(
    'Codespace setup timed out. Try connecting again.',
  )
}
