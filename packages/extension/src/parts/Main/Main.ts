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
  registerView,
  registerFileSystemProvider,
  registerPortProvider,
  createOutputChannel,
  openOutputView,
  showQuickPick,
  showNotification,
} from '@lvce-editor/api'
import { waitForWorkspace } from '../WaitForWorkspace/WaitForWorkspace.ts'
import { getToken } from '../Auth/Auth.ts'
import * as Api from '../CodespacesApi/CodespacesApi.ts'
import {
  createGithubClient,
  type GithubClient,
  type Codespace,
} from '../GithubApi/GithubApi.ts'
import * as Connection from '../Connection/Connection.ts'
import { fileSystem } from '../FileSystem/FileSystem.ts'
import { backendUrl, siteUrl, getEndpoint } from '../Urls/Urls.ts'
import { createStartupProgress } from '../StartupProgress/StartupProgress.ts'
import { connectToGateway } from '../Connect/Connect.ts'
import { openCreationLog } from '../CreationLog/CreationLog.ts'
import { createPortProvider } from '../PortProvider/PortProvider.ts'
import { readAppPreview } from '../AppPreview/AppPreview.ts'
import {
  previewView,
  previewViewId,
  setAppPreview,
} from '../AppPreviewView/AppPreviewView.ts'

let previewRegistration: ReturnType<typeof registerView> | undefined
let output: ReturnType<typeof createOutputChannel> | undefined
let busy = false
let activated = false
let portProvider: ReturnType<typeof registerPortProvider> | undefined
let operation: AbortController | undefined
let management: AbortController | undefined
let session: string | undefined
let connectedName: string | undefined
let lastAttemptedName: string | undefined
const progress = async (message: string): Promise<void> => {
  output ||= createOutputChannel('codespaces')
  await output.replace(message)
  await openOutputView({ channel: 'codespaces' })
}
const pickCodespace = async (
  github: GithubClient,
  placeholder: string,
): Promise<Codespace | undefined> => {
  const codespaces = await github.list()
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
const release = async (cancelManagement = true): Promise<void> => {
  if (cancelManagement) management?.abort()
  operation?.abort()
  operation = undefined
  const previous = session
  session = undefined
  connectedName = undefined
  await setAppPreview(undefined).catch(() => {})
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
  await waitForWorkspace(
    executeCommand('Workspace.setUri', uri.href, '/', {
      command: Connection.commandId,
      workspacePath: value.workspacePath,
      terminalSpawnOptions: { command: 'bash', args: ['-i'] },
    }),
    signal,
  )
}
const connectSelected = async (
  codespace: Codespace,
  github: GithubClient,
  signal: AbortSignal,
): Promise<void> => {
  signal.throwIfAborted()
  lastAttemptedName = codespace.name
  await release(false)
  signal.throwIfAborted()
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
    await github.ensureAvailable(codespace, onProgress)
    signal.throwIfAborted()
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
    // A preview failure must not tear down a successfully connected workspace.
    try {
      const workspaceUri = new URL(`codespaces://${codespace.name}`)
      workspaceUri.pathname = result.workspacePath
      const preview = await readAppPreview(
        workspaceUri.href,
        codespace.name,
        fileSystem.readFile,
        controller.signal,
      )
      controller.signal.throwIfAborted()
      await setAppPreview(preview)
      if (preview) {
        controller.signal.throwIfAborted()
        await executeCommand(
          'Layout.showPreview',
          previewViewId,
          'ExtensionView',
        )
      }
    } catch (error) {
      if (!controller.signal.aborted)
        await showNotification(
          'error',
          `Could not open application preview: ${error instanceof Error ? error.message : error}`,
        )
    }
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
      await Connection.dispose()
    }
    if (!controller.signal.aborted) {
      try {
        await update('Opening the Codespace creation log…', true)
        await openCreationLog(codespace.name, controller.signal)
        await update('Opened creation.log.', true)
      } catch {
        if (!controller.signal.aborted)
          await update('Could not open the creation log.', true).catch(() => {})
      }
    }
    if (operation === controller) operation = undefined
    if (!controller.signal.aborted) {
      await update(
        'Run Codespaces: Open in Browser to inspect the container and view its creation logs. GitHub can provide a recovery container when devcontainer configuration fails.',
        true,
      ).catch(() => {})
      throw error
    }
  }
}
const runGithub = async (
  callback: (github: GithubClient, signal: AbortSignal) => Promise<void>,
): Promise<void> => {
  const controller = new AbortController()
  management = controller
  let github: GithubClient | undefined
  try {
    github = createGithubClient(
      (
        await Api.request<{ accessToken: string }>(
          '/auth/github-token',
          'POST',
          undefined,
          controller.signal,
        )
      ).accessToken,
      controller.signal,
    )
    await callback(github, controller.signal)
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    github?.dispose()
    if (management === controller) management = undefined
  }
}
export const setup = (): Promise<void> =>
  runGithub(async (github, signal) => {
    await progress('Loading your GitHub repositories…')
    const repositories = await github.listRepositories()
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
    const codespace = await github.create(repository)
    await connectSelected(codespace, github, signal)
  })
export const connect = async (): Promise<void> => {
  await progress('Loading your Codespaces…')
  await runGithub(async (github, signal) => {
    const codespace = await pickCodespace(
      github,
      'Select a Codespace to connect to',
    )
    if (codespace) await connectSelected(codespace, github, signal)
  })
}
const viewCreationLog = (): Promise<void> =>
  runGithub(async (github, signal) => {
    const name =
      lastAttemptedName ||
      (
        await pickCodespace(
          github,
          'Select a Codespace to view its creation log',
        )
      )?.name
    if (name) await openCreationLog(name, signal)
  })
const start = (): Promise<void> =>
  runGithub(async (github) => {
    const codespace = await pickCodespace(github, 'Select a Codespace to start')
    if (!codespace) return
    await github.start(codespace.name)
    await progress(
      `Starting ${codespace.name}. Run Codespaces: Connect to Codespace when ready.`,
    )
  })
const stopSelected = async (
  github: GithubClient,
  name: string,
): Promise<string> => {
  await github.stop(name)
  let cleanupFailed = false
  try {
    await Api.request(`/${name}/connections`, 'DELETE')
  } catch {
    cleanupFailed = true
  }
  if (connectedName === name) {
    try {
      await release(false)
      await executeCommand('Workspace.setUri', 'memfs:///')
    } catch {
      cleanupFailed = true
    }
  }
  return `Stopped ${name}. GitHub storage charges may still apply.${cleanupFailed ? ' Could not close all editor connections. Disconnect other sessions or wait for them to expire.' : ''}`
}
const stop = (): Promise<void> =>
  runGithub(async (github) => {
    const codespace = await pickCodespace(github, 'Select a Codespace to stop')
    if (!codespace) return
    await progress(await stopSelected(github, codespace.name))
  })
const stopAll = (): Promise<void> =>
  runGithub(async (github, signal) => {
    await progress('Loading your Codespaces…')
    const codespaces = (await github.list()).filter(
      ({ state }) =>
        !['Shutdown', 'ShuttingDown', 'Deleted', 'Archived'].includes(state),
    )
    if (!codespaces.length) {
      await progress('No active Codespaces to stop.')
      return
    }
    const messages: string[] = []
    let failed = 0
    for (const codespace of codespaces) {
      signal.throwIfAborted()
      await progress([...messages, `Stopping ${codespace.name}…`].join('\n'))
      try {
        messages.push(await stopSelected(github, codespace.name))
      } catch (error) {
        signal.throwIfAborted()
        failed++
        messages.push(
          `Failed to stop ${codespace.name}: ${error instanceof Error ? error.message : 'Codespaces command failed'}`,
        )
      }
    }
    signal.throwIfAborted()
    const summary = `Stopped ${codespaces.length - failed} of ${codespaces.length} Codespaces.`
    await progress([...messages, summary].join('\n'))
    if (failed)
      await showNotification(
        'error',
        `${summary} See Codespaces output for failures.`,
      )
  })
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
  portProvider = registerPortProvider(createPortProvider())
  previewRegistration = registerView(previewView)
  const commands = {
    'codespaces.setup': setup,
    'codespaces.connect': connect,
    'codespaces.start': start,
    'codespaces.viewCreationLog': viewCreationLog,
    'codespaces.refreshPorts': async () => {
      await executeCommand('Layout.showPanel', 'Ports')
      await executeCommand('Ports.refresh')
    },
    'codespaces.openInBrowser': async () => {
      const url = lastAttemptedName
        ? `https://github.com/codespaces/${encodeURIComponent(lastAttemptedName)}`
        : 'https://github.com/codespaces'
      await executeCommand('Open.openUrl', url, true)
    },
    'codespaces.stop': stop,
    'codespaces.stopAll': stopAll,
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
  portProvider?.dispose()
  portProvider = undefined
  activated = false
  await release()
  previewRegistration?.dispose()
  previewRegistration = undefined
}
