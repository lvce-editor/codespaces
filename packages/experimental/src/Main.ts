import { Buffer } from 'buffer'
import { broker } from './Auth.ts'
import { connect } from './Tunnel.ts'
import {
  createGithubClient,
  type GithubClient,
} from '../../extension/src/parts/GithubApi/GithubApi.ts'

const input = (id: string) => document.getElementById(id) as HTMLInputElement
const status = document.getElementById('status')!
const output = document.getElementById('output')!
const editor = document.getElementById('editor') as HTMLTextAreaElement
const choices = document.getElementById('codespaces') as HTMLSelectElement
let operation = new AbortController()
let session: Awaited<ReturnType<typeof connect>> | undefined
let terminalId: number | undefined
let unsubscribe: (() => void)[] = []
const report = (message: string): void => {
  status.textContent = message
}
const append = (text: string): void => {
  output.textContent = (output.textContent + text).slice(-200_000)
  output.scrollTop = output.scrollHeight
}
const github = async <T>(
  fn: (client: GithubClient) => Promise<T>,
  signal = operation.signal,
): Promise<T> => {
  const { accessToken } = await broker<{ accessToken: string }>(
    '/auth/github-token',
    signal,
  )
  const client = createGithubClient(accessToken, signal)
  try {
    return await fn(client)
  } finally {
    client.dispose()
  }
}
const current = () => {
  if (!session) throw new Error('Connect to a Codespace first')
  return session.management
}
const withTerminal = (): number => {
  if (terminalId === undefined) throw new Error('Start a terminal first')
  return terminalId
}
const list = async (): Promise<void> => {
  const rpc = current()
  const path = input('directory').value
  const entries: [string, number][] = await rpc.files('readdir', [
    rpc.uri(path),
  ])
  if (rpc !== session?.management) return
  const container = document.getElementById('files')!
  container.replaceChildren()
  for (const [name, type] of entries.toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = `${type & 2 ? '📁 ' : ''}${name}`
    button.onclick = () => {
      void run(async () => {
        const file = `${path.replace(/\/$/, '')}/${name}`
        if (type & 2) {
          input('directory').value = file
          await list()
        } else {
          input('path').value = file
          await openFile()
        }
      })
    }
    container.append(button)
  }
}
const openFile = async (): Promise<void> => {
  const rpc = current()
  const bytes = await rpc.files('readFile', [rpc.uri(input('path').value)])
  if (rpc !== session?.management) return
  if (!(bytes instanceof Uint8Array))
    throw new Error('Incompatible remote file response')
  editor.value = new TextDecoder().decode(bytes)
  report('File loaded from the Codespace.')
}
const stopTerminal = async (): Promise<void> => {
  const id = terminalId
  terminalId = undefined
  for (const dispose of unsubscribe.splice(0)) dispose()
  if (session && id !== undefined)
    await session.management.terminal('$shutdown', [id, true])
}
const disconnect = async (): Promise<void> => {
  const previous = session
  session = undefined
  const id = terminalId
  terminalId = undefined
  for (const dispose of unsubscribe.splice(0)) dispose()
  if (previous && id !== undefined) {
    await Promise.race([
      previous.management.terminal('$shutdown', [id, true]).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ])
  }
  operation.abort()
  previous?.close()
  operation = new AbortController()
  report('Disconnected. GitHub compute continues until you stop the Codespace.')
}
const startTerminal = async (): Promise<void> => {
  await stopTerminal()
  const rpc = current()
  const service = 'remoteterminal'
  unsubscribe = [
    rpc.listen(service, '$onProcessDataEvent', (value) => {
      if (value.id !== terminalId) return
      const data =
        typeof value.event === 'string' ? value.event : value.event.data
      append(data)
      void rpc
        .terminal('$acknowledgeDataEvent', [value.id, data.length])
        .catch(() => {})
    }),
    rpc.listen(service, '$onProcessReadyEvent', (value) => {
      if (value.id === terminalId)
        report(`Terminal running in ${value.event.cwd}`)
    }),
    rpc.listen(service, '$onProcessExitEvent', (value) => {
      if (value.id === terminalId) {
        terminalId = undefined
        append(`\n[Exited: ${value.event ?? 'unknown'}]\n`)
      }
    }),
    rpc.listen(service, '$onProcessOrphanQuestion', (value) => {
      if (value.id === terminalId)
        void rpc.terminal('$orphanQuestionReply', [value.id]).catch(() => {})
    }),
  ]
  const shell = await rpc.terminal('$getDefaultSystemShell', [])
  const cwd = input('directory').value
  const folder = {
    uri: rpc.uri(cwd),
    name: cwd.split('/').at(-1) || 'workspace',
    index: 0,
  }
  const result = await rpc.terminal('$createProcess', {
    configuration: {
      'terminal.integrated.env.linux': {},
      'terminal.integrated.env.osx': {},
      'terminal.integrated.env.windows': {},
      'terminal.integrated.cwd': '',
      'terminal.integrated.detectLocale': 'auto',
    },
    resolvedVariables: {},
    envVariableCollections: [],
    shellLaunchConfig: {
      executable: shell,
      args: [],
      cwd,
      env: {},
      useShellEnvironment: true,
    },
    workspaceId: `lvce-proof-${rpc.name}`,
    workspaceName: folder.name,
    workspaceFolders: [folder],
    activeWorkspaceFolder: folder,
    shouldPersistTerminal: false,
    options: {
      shellIntegration: { enabled: false, suggestEnabled: false, nonce: '' },
      windowsUseConptyDll: false,
      isScreenReaderOptimized: false,
    },
    cols: Number(input('cols').value),
    rows: Number(input('rows').value),
    unicodeVersion: '11',
    resolverEnv: {},
  })
  if (rpc !== session?.management) {
    await rpc
      .terminal('$shutdown', [result.persistentTerminalId, true])
      .catch(() => {})
    return
  }
  terminalId = result.persistentTerminalId
  const error = await rpc.terminal('$start', [terminalId])
  if (error?.message) throw new Error(error.message)
}
const run = async (fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    report(error instanceof Error ? error.message : 'Operation failed')
  }
}
const action = (id: string, fn: () => Promise<unknown>): void => {
  const button = document.getElementById(id) as HTMLButtonElement
  button.onclick = () => {
    button.disabled = true
    void run(fn).finally(() => {
      button.disabled = false
    })
  }
}
const refresh = async (): Promise<void> => {
  const selected = choices.value
  const values = await github((client) => client.list())
  choices.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement('option')
      option.value = value.name
      option.textContent = `${value.repository.full_name} — ${value.name} (${value.state})`
      return option
    }),
  )
  if (values.some((value) => value.name === selected)) choices.value = selected
  report(`${values.length} Codespaces available.`)
}
action('refresh', refresh)
action('repositories', async () => {
  const values = await github((client) => client.listRepositories())
  const datalist = document.getElementById('repository-list')!
  datalist.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement('option')
      option.value = value.full_name
      return option
    }),
  )
  report('Repository suggestions loaded.')
})
action('create', async () => {
  if (
    !confirm(
      `Create a Codespace for ${input('repository').value}? GitHub compute and storage charges apply.`,
    )
  )
    return
  const value = await github((client) =>
    client.create(input('repository').value),
  )
  await refresh()
  choices.value = value.name
})
action('connect', async () => {
  const name = choices.value
  if (!name) throw new Error('Select a Codespace')
  await disconnect()
  const signal = operation.signal
  await github(async (client) => {
    const space = (await client.list()).find((value) => value.name === name)
    if (!space) throw new Error('Codespace no longer exists')
    await client.ensureAvailable(space, async (message) => report(message))
  }, signal)
  const next = await connect(name, signal, report)
  if (signal.aborted) {
    next.close()
    return
  }
  session = next
  next.management.onClose = (error) => {
    if (session !== next) return
    session = undefined
    terminalId = undefined
    next.close()
    report(`${error.message}. Reconnect to open a new workspace session.`)
  }
  input('directory').value = next.workspacePath
  input('path').value = `${next.workspacePath}/lvce-browser-proof.txt`
  await list()
  report(
    'Connected directly to the Codespace. Files and terminals bypass backend-2.',
  )
})
action('disconnect', disconnect)
action('stop', async () => {
  const name = session?.management.name || choices.value
  if (!name) throw new Error('Select a Codespace')
  await disconnect()
  await github((client) => client.stop(name))
  await refresh()
})
action('list', list)
action('parent', async () => {
  input('directory').value =
    input('directory').value.replace(/\/?[^/]+\/?$/, '') || '/'
  await list()
})
action('open', openFile)
action('save', async () => {
  const rpc = current()
  await rpc.files('writeFile', [
    rpc.uri(input('path').value),
    Buffer.from(editor.value),
    { create: true, overwrite: true },
  ])
  await list()
  report('Saved in the Codespace.')
})
action('rename', async () => {
  const rpc = current()
  await rpc.files('rename', [
    rpc.uri(input('path').value),
    rpc.uri(input('destination').value),
    { overwrite: false },
  ])
  input('path').value = input('destination').value
  await list()
})
action('delete', async () => {
  const rpc = current()
  if (!confirm(`Delete ${input('path').value}?`)) return
  await rpc.files('delete', [
    rpc.uri(input('path').value),
    { recursive: false, useTrash: false },
  ])
  editor.value = ''
  await list()
})
action('terminal-start', startTerminal)
action('terminal-stop', stopTerminal)
const sendInput = async (): Promise<void> => {
  await current().terminal('$input', [
    withTerminal(),
    input('command').value + '\r',
  ])
  input('command').value = ''
}
action('send', sendInput)
input('command').onkeydown = (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    void run(sendInput)
  }
}
action('interrupt', async () =>
  current().terminal('$input', [withTerminal(), '\u0003']),
)
action('resize', async () => {
  const cols = Number(input('cols').value),
    rows = Number(input('rows').value)
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > 500 ||
    rows > 200
  )
    throw new Error('Invalid terminal dimensions')
  await current().terminal('$resize', [withTerminal(), cols, rows])
})
window.addEventListener('pagehide', () => {
  operation.abort()
  session?.close()
})
