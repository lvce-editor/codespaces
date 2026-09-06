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
import { getAccountId, getToken } from './Auth.ts'
import * as Connection from './Connection.ts'
import { fileSystem } from './FileSystem.ts'
import { getEndpoint, getSetupCommand, siteUrl } from './Urls.ts'
import { connectToGateway } from './Connect.ts'

let activated = false
let connecting = false
let operationId = 0

export const setup = async (): Promise<void> => {
  const owner = await getAccountId(await getToken())
  const channel = createOutputChannel('codespaces')
  await channel.replace(
    `Run this command in your Codespace terminal (Node.js 24+):\n\n${getSetupCommand(owner)}\n\nThen forward port 3774 as Public. The gateway requires your LVCE account.\nInstructions: ${siteUrl}setup.html\n`,
  )
  await openOutputView({ channel: 'codespaces' })
}

export const connect = async (value?: string): Promise<void> => {
  if (connecting) return
  connecting = true
  const operation = ++operationId
  try {
    const input =
      value ||
      (await showQuickPick({
        items: [],
        acceptInput: true,
        placeholder:
          'Codespace name or forwarded HTTPS URL (run Codespaces: Set Up a Codespace first)',
      }))
    if (typeof input !== 'string' || !input) return
    const endpoint = getEndpoint(input)
    const result = await connectToGateway(endpoint, await getToken())
    if (operation !== operationId) return
    await Connection.dispose()
    Connection.set(result)
    const uri = new URL(`codespaces://${endpoint.host}`)
    uri.pathname = result.workspacePath
    // Let the command finish before changing the workspace / extension host.
    setTimeout(() => {
      if (operation !== operationId) return
      void executeCommand('Workspace.setUri', uri.href, '/', {
        command: Connection.commandId,
        workspacePath: result.workspacePath,
      }).catch(async () => {
        await Connection.dispose()
        await showNotification(
          'error',
          'Could not open the Codespaces workspace. Run Connect again.',
        )
      })
    }, 0)
  } finally {
    connecting = false
  }
}

const report =
  <T extends unknown[]>(fn: (...args: T) => Promise<void>) =>
  async (...args: T): Promise<void> => {
    try {
      await fn(...args)
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
  registerCommand({
    id: 'codespaces.setup',
    execute: async () => {
      setTimeout(() => void report(setup)(), 0)
    },
  })
  registerCommand({
    id: 'codespaces.connect',
    execute: async (value?: string) => {
      setTimeout(() => void report(connect)(value), 0)
    },
  })
  registerCommand({
    id: Connection.commandId,
    execute: Connection.getWebSocketUrl,
  })
  registerCommand({
    id: 'codespaces.disconnect',
    execute: report(async () => {
      operationId++
      await Connection.dispose()
      await executeCommand('Workspace.setUri', 'memfs:///')
    }),
  })
  activated = true
}
export const deactivate = async (): Promise<void> => {
  activated = false
  operationId++
  await Connection.dispose()
}
