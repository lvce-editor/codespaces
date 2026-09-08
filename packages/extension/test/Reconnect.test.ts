import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { build } from 'esbuild'

const load = async () => {
  const result = await build({
    stdin: {
      contents: `export * from '../src/parts/Main/Main.ts';
      export { commands, output, notifications, workspaceOpening, workspaceResult } from '@lvce-editor/api';`,
      resolveDir: import.meta.dirname,
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    mainFields: ['module', 'main'],
    write: false,
    plugins: [
      {
        name: 'editor-api',
        setup(builder) {
          builder.onResolve({ filter: /^@lvce-editor\/api$/ }, () => ({
            path: 'api',
            namespace: 'test',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents: `
          export const commands = new Map(), output = [], notifications = [];
          export const workspaceOpening = Promise.withResolvers(), workspaceResult = Promise.withResolvers();
          export const activate = async () => {};
          export const getAccessToken = async () => 'test-token';
          export const registerCommand = command => commands.set(command.id, command.execute);
          export const registerFileSystemProvider = () => {};
          export const registerPortProvider = () => ({ dispose() {} });
          export const registerView = () => ({ dispose() {} });
          export const createOutputChannel = () => ({ replace: async message => output.push(message) });
          export const openOutputView = async () => {};
          export const showNotification = async (...args) => notifications.push(args);
          export const showQuickPick = async () => 'happy-cat';
          export const mkdir = async () => {};
          export const writeFile = async () => {};
          export const openUri = async () => {};
          export const executeCommand = async (command, uri) => {
            if (command === 'Workspace.setUri' && uri.startsWith('codespaces:')) {
              workspaceOpening.resolve();
              await workspaceResult.promise;
            }
          };
        `,
          }))
        },
      },
    ],
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + `\n//# sourceURL=reconnect-${Math.random()}.mjs`).toString('base64')}`
  )
}

test('disconnect settles a stalled workspace opening and permits another connect', async (t) => {
  const main = await load()
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string, init: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/auth/github-token'))
        return Response.json({ accessToken: 'github-token' })
      if (url.includes('/user/codespaces'))
        return Response.json({
          codespaces: [
            {
              name: 'happy-cat',
              state: 'Available',
              repository: { full_name: 'test/project' },
            },
          ],
          total_count: 1,
        })
      if (url.endsWith('/happy-cat/connect'))
        return Response.json({
          id: 'session',
          websocketUrl: 'wss://lvce-editor.dev/codespaces/connections/session/',
        })
      if (init.method === 'DELETE') return new Response(null, { status: 204 })
      return Response.json({
        state: 'ready',
        workspacePath: '/workspaces/project',
      })
    },
  )
  await main.activate()
  t.after(async () => {
    main.workspaceResult.resolve()
    await main.deactivate()
  })
  await main.commands.get('codespaces.connect')()
  await main.workspaceOpening.promise
  await main.commands.get('codespaces.disconnect')()
  // Drain command dispatch and cancellation continuations without resolving the
  // old workspace request: that is precisely the reconnect hang being tested.
  await new Promise((resolve) => setTimeout(resolve, 20))
  await main.commands.get('codespaces.connect')()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(
    main.output.some((message: string) =>
      message.includes('Connection cancelled.'),
    ),
  )
  assert.ok(
    !main.notifications.some((args: string[]) =>
      args.join(' ').includes('already in progress'),
    ),
  )
  await setImmediate()
})
