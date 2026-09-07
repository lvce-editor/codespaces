import {
  ConnectionCancelledError,
  InvalidRepositoryError,
  NoCodespacesError,
  OperationInProgressError,
} from '../../../../shared/src/Errors.ts'
import {
  activate as activateApi,
  executeCommand,
  registerCommand,
  registerFileSystemProvider,
  createOutputChannel,
  openOutputView,
  showQuickPick,
  showNotification,
} from '@lvce-editor/api'
import { getToken } from '../Auth/Auth.ts'
import * as Api from '../CodespacesApi/CodespacesApi.ts'
import * as Connection from '../Connection/Connection.ts'
import { fileSystem } from '../FileSystem/FileSystem.ts'
import { backendUrl, siteUrl, getEndpoint } from '../Urls/Urls.ts'
import { createStartupProgress } from '../StartupProgress/StartupProgress.ts'
import { connectToGateway } from '../Connect/Connect.ts'

let output: ReturnType<typeof createOutputChannel> | undefined
let busy = false
let activated = false
let operation: AbortController | undefined
let session: string | undefined
let connectedName: string | undefined
let lastAttemptedName: string | undefined
const progress = async (message: string): Promise<void> => {
  output ||= createOutputChannel('codespaces')
  await output.replace(message)
  await openOutputView({ channel: 'codespaces' })
}
const pickCodespace = async (
  placeholder: string,
): Promise<Api.Codespace | undefined> => {
  const codespaces = await Api.list()
  if (!codespaces.length)
    throw new NoCodespacesError(
      'No existing Codespaces found. Run Codespaces: Set Up a Codespace to create one from a GitHub repository.',
    )
  const items = codespaces.map((value) => ({
    label: value.name,
    value: value.name,
    description: `${value.repository.full_name} · ${value.state}`,
  }))
  const selected = await showQuickPick({ items, placeholder })
  const name =
    typeof selected === 'string'
      ? selected
      : (selected as { label?: string } | undefined)?.label
  return codespaces.find((value) => value.name === name)
}
const release = async (): Promise<void> => {
  operation?.abort()
  operation = undefined
  const previous = session
  session = undefined
  connectedName = undefined
  await Connection.dispose()
  if (previous)
    await Api.request(`/connections/${previous}`, 'DELETE').catch(() => {})
}
const openWorkspace = async (
  name: string,
  value: { sessionToken: string; websocketUrl: string; workspacePath: string },
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) return
  Connection.set({
    ...value,
    authority: name,
    refreshLvceToken: value.websocketUrl.startsWith(
      'wss://lvce-editor.dev/codespaces/connections/',
    ),
  })
  connectedName = name
  const uri = new URL(`codespaces://${name}`)
  uri.pathname = value.workspacePath
  await executeCommand('Workspace.setUri', uri.href, '/', {
    command: Connection.commandId,
    workspacePath: value.workspacePath,
  })
}
const connectSelected = async (codespace: Api.Codespace): Promise<void> => {
  lastAttemptedName = codespace.name
  await release()
  const controller = new AbortController()
  operation = controller
  let created: string | undefined
  output ||= createOutputChannel('codespaces')
  const update = createStartupProgress(codespace.name, async (message) => {
    await output!.replace(message)
    // Older editor exports do not subscribe to output channel changes.
    // Refresh the visible output without reopening a panel the user closed.
    await executeCommand('Output.refresh').catch(() => {})
  })
  const onProgress: Api.OnProgress = async (message) => {
    if (controller.signal.aborted)
      throw new ConnectionCancelledError('Connection cancelled')
    await update(message)
  }
  try {
    await onProgress('Checking Codespace status…')
    await openOutputView({ channel: 'codespaces' })
    await Api.ensureAvailable(codespace, controller.signal, onProgress)
    const result = await Api.prepare(
      codespace.name,
      controller.signal,
      (id) => {
        created = id
        if (!controller.signal.aborted) session = id
      },
      onProgress,
    )
    if (controller.signal.aborted)
      throw new ConnectionCancelledError('Connection cancelled')
    await onProgress('Opening the remote workspace…')
    await openWorkspace(codespace.name, result, controller.signal)
    if (controller.signal.aborted)
      throw new ConnectionCancelledError('Connection cancelled')
    await update(`Connected to ${codespace.name}.`, true)
  } catch (error) {
    await update(
      controller.signal.aborted
        ? 'Connection cancelled.'
        : `Connection failed: ${error instanceof Error ? error.message : 'Codespace setup failed'}`,
      true,
    ).catch(() => {})
    if (created)
      await Api.request(`/connections/${created}`, 'DELETE').catch(() => {})
    if (operation === controller) {
      session = undefined
      operation = undefined
      await Connection.dispose()
    }
    if (!controller.signal.aborted) {
      await update(
        'Run Codespaces: Open in Browser to inspect the container and view its creation logs. GitHub can provide a recovery container when devcontainer configuration fails.',
        true,
      ).catch(() => {})
      throw error
    }
  }
}
export const setup = async (): Promise<void> => {
  await getToken()
  await progress('Loading your GitHub repositories…')
  const repositories = await Api.listRepositories()
  const manualLabel = 'Enter a repository manually…'
  const selected = await showQuickPick({
    items: [
      ...repositories.map((repository) => ({
        label: repository.full_name,
        value: repository.full_name,
        description: repository.private ? 'Private' : 'Public',
      })),
      {
        label: manualLabel,
        value: manualLabel,
        description: 'Type owner/repository',
      },
    ],
    placeholder: repositories.length
      ? 'Repository to create a Codespace in (search your GitHub repositories)'
      : 'No repositories returned by GitHub. Enter one manually.',
  })
  const name =
    typeof selected === 'string'
      ? selected
      : (selected as { label?: string } | undefined)?.label
  const repository =
    name === manualLabel
      ? await showQuickPick({
          items: [],
          acceptInput: true,
          placeholder: 'Enter repository as owner/name',
        })
      : name
  if (typeof repository !== 'string' || !repository) return
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new InvalidRepositoryError('Enter a repository as owner/name.')
  const confirmation = await showQuickPick({
    items: [
      {
        label: 'Create and Connect',
        value: 'Create and Connect',
        description: `Create a Codespace in ${repository}. GitHub compute and storage charges may apply.`,
      },
      { label: 'Cancel', value: 'Cancel', description: '' },
    ],
    placeholder: 'Create Codespace using GitHub defaults?',
  })
  if (
    confirmation !== 'Create and Connect' &&
    (confirmation as { label?: string })?.label !== 'Create and Connect'
  )
    return
  await progress(`Creating Codespace in ${repository}…`)
  const codespace = await Api.request<Api.Codespace>('', 'POST', { repository })
  await connectSelected(codespace)
}
export const connect = async (): Promise<void> => {
  const codespace = await pickCodespace('Select a Codespace to connect to')
  if (codespace) await connectSelected(codespace)
}
const start = async (): Promise<void> => {
  const codespace = await pickCodespace('Select a Codespace to start')
  if (!codespace) return
  await Api.request(`/${codespace.name}/start`, 'POST')
  await progress(
    `Starting ${codespace.name}. Run Codespaces: Connect to Codespace when ready.`,
  )
}
const stop = async (): Promise<void> => {
  const codespace = await pickCodespace('Select a Codespace to stop')
  if (!codespace) return
  await Api.request(`/${codespace.name}/stop`, 'POST')
  if (connectedName === codespace.name) {
    await release()
    await executeCommand('Workspace.setUri', 'memfs:///')
  }
  await progress(
    `Stopped ${codespace.name}. GitHub storage charges may still apply.`,
  )
}
const report = (fn: () => Promise<void>) => async (): Promise<void> => {
  try {
    await fn()
  } catch (error) {
    await showNotification(
      'error',
      error instanceof Error ? error.message : 'Codespaces command failed',
    )
  }
}
export const activate = async (): Promise<void> => {
  if (activated) return
  await activateApi()
  registerFileSystemProvider(fileSystem)
  const commands = {
    'codespaces.setup': setup,
    'codespaces.connect': connect,
    'codespaces.start': start,
    'codespaces.openInBrowser': async () => {
      const name =
        lastAttemptedName ||
        (await pickCodespace('Select a Codespace to open in GitHub'))?.name
      if (name)
        await executeCommand(
          'Open.openUrl',
          `https://github.com/codespaces/${encodeURIComponent(name)}`,
          true,
        )
    },
    'codespaces.stop': stop,
    'codespaces.authorize': async () => {
      await executeCommand(
        'Open.openUrl',
        `${backendUrl}/auth/github?returnTo=${encodeURIComponent(siteUrl)}`,
        true,
      )
    },
    'codespaces.disconnect': async () => {
      await release()
      await executeCommand('Workspace.setUri', 'memfs:///')
    },
    // Retained for previously configured gateways and transport regression tests.
    'codespaces.connectGateway': async () => {
      const input = await showQuickPick({
        items: [],
        acceptInput: true,
        placeholder: 'Codespace forwarded HTTPS URL',
      })
      if (typeof input !== 'string' || !input) return
      await release()
      const controller = new AbortController()
      operation = controller
      const endpoint = getEndpoint(input)
      await openWorkspace(
        endpoint.host,
        await connectToGateway(endpoint, await getToken()),
        controller.signal,
      )
    },
  }
  for (const [id, callback] of Object.entries(commands))
    registerCommand({
      id,
      execute: async () => {
        setTimeout(
          () =>
            void report(async () => {
              if (
                id === 'codespaces.disconnect' ||
                id === 'codespaces.authorize' ||
                id === 'codespaces.openInBrowser'
              ) {
                await callback()
                return
              }
              if (busy)
                throw new OperationInProgressError(
                  'A Codespaces operation is already in progress. Use Disconnect to cancel it.',
                )
              busy = true
              try {
                await callback()
              } finally {
                busy = false
              }
            })(),
          0,
        )
      },
    })
  registerCommand({
    id: Connection.commandId,
    execute: Connection.getWebSocketUrl,
  })
  activated = true
}
export const deactivate = async (): Promise<void> => {
  activated = false
  await release()
}
