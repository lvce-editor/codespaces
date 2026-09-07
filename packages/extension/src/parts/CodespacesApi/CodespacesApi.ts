import {
  CodespaceSetupError,
  CodespaceSetupTimeoutError,
  CodespaceStartupTimeoutError,
  CodespaceUnavailableError,
  CodespacesRequestError,
  ConnectionCancelledError,
  InvalidRelayAddressError,
  InvalidWorkspacePathError,
  RepositoryListTooLargeError,
} from '../../../../shared/src/Errors.ts'
import { getToken } from '../Auth/Auth.ts'
import { backendUrl } from '../Urls/Urls.ts'

export interface Codespace {
  name: string
  state: string
  repository: { full_name: string }
}
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
export const list = async (signal?: AbortSignal): Promise<Codespace[]> => {
  const result: Codespace[] = []
  for (let page = 1; page <= 100; page++) {
    const value = await request<{
      codespaces: Codespace[]
      total_count: number
    }>(`?page=${page}`, 'GET', undefined, signal)
    result.push(...value.codespaces)
    if (value.codespaces.length < 100 || result.length >= value.total_count)
      return result
  }
  return result
}
export interface Repository {
  readonly full_name: string
  readonly private: boolean
}
export const listRepositories = async (
  signal?: AbortSignal,
): Promise<Repository[]> => {
  const repositories = new Map<string, Repository>()
  for (let page = 1; page <= 1000; page++) {
    const value = await request<{
      repositories: Repository[]
      hasMore: boolean
    }>(`/repositories?page=${page}`, 'GET', undefined, signal)
    for (const repository of value.repositories)
      repositories.set(repository.full_name, repository)
    if (!value.hasMore) return [...repositories.values()]
  }
  throw new RepositoryListTooLargeError(
    'The GitHub repository list is too large to load.',
  )
}
const sleep = async (signal: AbortSignal): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const stop = (): void => {
    clearTimeout(timer)
    reject(new ConnectionCancelledError('Connection cancelled'))
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', stop)
    resolve()
  }, 1500)
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  return promise
}
export type OnProgress = (message: string) => Promise<void>

const startupMessage = (state: string): string => {
  const messages: Record<string, string> = {
    Queued: 'Waiting for GitHub to allocate the Codespace…',
    Provisioning: 'GitHub is provisioning the Codespace…',
    Starting: 'GitHub is starting the Codespace…',
    Rebuilding: 'GitHub is rebuilding the development container…',
    Updating: 'GitHub is updating the Codespace…',
    Available: 'Codespace is running.',
    Shutdown: 'Codespace is stopped.',
  }
  return Object.hasOwn(messages, state)
    ? messages[state]
    : `Waiting for GitHub (state: ${state})…`
}

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

export const ensureAvailable = async (
  codespace: Codespace,
  signal: AbortSignal,
  onProgress: OnProgress,
): Promise<void> => {
  await onProgress(startupMessage(codespace.state))
  if (codespace.state === 'Available') return
  if (codespace.state === 'Shutdown') {
    await onProgress('Requesting GitHub to start the Codespace…')
    await request(`/${codespace.name}/start`, 'POST', undefined, signal)
  }
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    const value = await request<Codespace>(
      `/${codespace.name}`,
      'GET',
      undefined,
      signal,
    )
    await onProgress(startupMessage(value.state))
    if (value.state === 'Available') return
    if (['Failed', 'Deleted', 'Unavailable'].includes(value.state))
      throw new CodespaceUnavailableError(
        `Codespace is ${value.state}. Try starting it again.`,
      )
    await sleep(signal)
  }
  throw new CodespaceStartupTimeoutError(
    'Codespace startup timed out. Check its state and try again.',
  )
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
