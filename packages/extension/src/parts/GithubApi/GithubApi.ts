import {
  AuthenticationError,
  CommandFailedError,
  CodespacesRequestError,
  CodespaceUnavailableError,
  CodespaceStartupTimeoutError,
  InvalidCodespaceNameError,
  InvalidRepositoryError,
  RepositoryListTooLargeError,
} from '../../../../shared/src/Errors.ts'
import { sleep } from '../Sleep/Sleep.ts'

export interface Codespace {
  name: string
  state: string
  repository: { full_name: string }
}
export interface Repository {
  readonly full_name: string
  readonly private: boolean
}
const codespacePath = (name: string): string => {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(name))
    throw new InvalidCodespaceNameError('Invalid Codespace name')
  return `/user/codespaces/${name}`
}
const repositoryPath = (repository: string): string => {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split('/').some((part) => part === '.' || part === '..')
  )
    throw new InvalidRepositoryError('Enter a repository as owner/name.')
  return `/repos/${repository}/codespaces`
}

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

// One client belongs to one command. Never persist its token or give it to a relay.
export const createGithubClient = (
  accessToken: string,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
) => {
  const dispose = (): void => {
    accessToken = ''
    signal.removeEventListener('abort', dispose)
  }
  if (signal.aborted) {
    dispose()
    signal.throwIfAborted()
  }
  if (!accessToken)
    throw new AuthenticationError('LVCE did not return a GitHub access token.')
  signal.addEventListener('abort', dispose, { once: true })
  const request = async <T>(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<T> => {
    signal.throwIfAborted()
    if (!accessToken)
      throw new CommandFailedError('GitHub command has finished.')
    const response = await fetchFn(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
    })
    const scopes = response.headers.get('x-oauth-scopes')
    if (
      response.status === 401 ||
      (scopes !== null && !scopes.split(/,\s*/).includes('codespace'))
    ) {
      dispose()
      throw new AuthenticationError(
        'Run Codespaces: Authorize GitHub Access to authorize Codespaces, then try again.',
      )
    }
    if (!response.ok) {
      const value = await response.json().catch(() => ({}))
      throw new CodespacesRequestError(
        typeof value.message === 'string'
          ? value.message.slice(0, 500)
          : `GitHub returned ${response.status}`,
      )
    }
    return response.status === 204 ? (undefined as T) : response.json()
  }
  const list = async (): Promise<Codespace[]> => {
    const result: Codespace[] = []
    for (let page = 1; page <= 100; page++) {
      const value = await request<{
        codespaces: Codespace[]
        total_count: number
      }>(`/user/codespaces?per_page=100&page=${page}`)
      result.push(...value.codespaces)
      if (value.codespaces.length < 100 || result.length >= value.total_count)
        return result
    }
    return result
  }
  const listRepositories = async (): Promise<Repository[]> => {
    const repositories = new Map<string, Repository>()
    for (let page = 1; page <= 1000; page++) {
      const value = await request<Repository[]>(
        `/user/repos?per_page=100&page=${page}&sort=full_name&direction=asc&affiliation=owner,collaborator,organization_member`,
      )
      for (const repository of value)
        repositories.set(repository.full_name, {
          full_name: repository.full_name,
          private: repository.private,
        })
      if (value.length < 100) return [...repositories.values()]
    }
    throw new RepositoryListTooLargeError(
      'The GitHub repository list is too large to load.',
    )
  }
  const start = async (name: string): Promise<void> => {
    await request(`${codespacePath(name)}/start`, 'POST')
  }
  const stop = async (name: string): Promise<void> => {
    await request(`${codespacePath(name)}/stop`, 'POST')
  }
  const create = (repository: string): Promise<Codespace> =>
    request(repositoryPath(repository), 'POST', {})
  const ensureAvailable = async (
    codespace: Codespace,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<void> => {
    signal.throwIfAborted()
    await onProgress?.(startupMessage(codespace.state))
    if (codespace.state === 'Available') return
    if (codespace.state === 'Shutdown') {
      await onProgress?.('Requesting GitHub to start the Codespace…')
      await start(codespace.name)
    }
    const deadline = Date.now() + 5 * 60_000
    while (Date.now() < deadline) {
      const value = await request<Codespace>(codespacePath(codespace.name))
      await onProgress?.(startupMessage(value.state))
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
  return {
    create,
    dispose,
    ensureAvailable,
    list,
    listRepositories,
    start,
    stop,
  }
}
export type GithubClient = ReturnType<typeof createGithubClient>
