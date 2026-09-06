import {
  activate as activateApi,
  executeCommand,
  registerCommand,
  registerFileSystemProvider,
  showQuickInput,
  showNotification,
} from '@lvce-editor/api'
import { getAccountId, getToken } from './Auth.ts'
import * as Connection from './Connection.ts'
import { fileSystem } from './FileSystem.ts'
import { getEndpoint, getSetupCommand, siteUrl } from './Urls.ts'
import { connectToGateway } from './Connect.ts'

let activated = false
let connecting = false

export const setup = async (): Promise<void> => {
  const owner = await getAccountId(await getToken())
  await showQuickInput({
    value: getSetupCommand(owner),
    placeholder:
      'Copy this command and run it in your Codespace terminal (Node.js 24+). Setup instructions: ' +
      siteUrl +
      'setup.html',
  })
}

export const connect = async (value?: string): Promise<void> => {
  if (connecting) return
  connecting = true
  try {
    const input =
      value ||
      (await showQuickInput({
        placeholder:
          'Codespace name or forwarded HTTPS URL (run Codespaces: Set Up a Codespace first)',
      }))
    if (!input) return
    const endpoint = getEndpoint(input)
    const result = await connectToGateway(endpoint, await getToken())
    await Connection.dispose()
    Connection.set(result)
    const uri = new URL(`codespaces://${endpoint.host}`)
    uri.pathname = result.workspacePath
    // Let the command finish before changing the workspace / extension host.
    setTimeout(() => {
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
  (fn: (...args: any[]) => Promise<void>) =>
  async (...args: any[]): Promise<void> => {
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
  registerCommand({ id: 'codespaces.setup', execute: report(setup) })
  registerCommand({ id: 'codespaces.connect', execute: report(connect) })
  registerCommand({
    id: Connection.commandId,
    execute: Connection.getWebSocketUrl,
  })
  registerCommand({
    id: 'codespaces.disconnect',
    execute: report(async () => {
      await Connection.dispose()
      await executeCommand('Workspace.setUri', 'memfs:///')
    }),
  })
  activated = true
}
export const deactivate = async (): Promise<void> => {
  activated = false
  await Connection.dispose()
}
