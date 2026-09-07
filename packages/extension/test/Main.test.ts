import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

test('failed connection keeps recovery guidance and opens the attempted Codespace', async (t) => {
  const result = await build({
    stdin: {
      contents: `export * from './packages/extension/src/parts/Main/Main.ts';
        export { commands, output, opened, openedSignal } from '@lvce-editor/api';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
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
          export const commands = new Map();
          export const output = [];
          export const opened = [];
          export const openedSignal = Promise.withResolvers();
          export const activate = async () => {};
          export const getAccessToken = async () => 'test-token';
          export const registerCommand = command => commands.set(command.id, command.execute);
          export const registerFileSystemProvider = () => {};
          export const createOutputChannel = () => ({replace: async message => output.push(message)});
          export const openOutputView = async () => {};
          export const showNotification = async () => {};
          export const showQuickPick = async () => 'happy-cat';
          export const executeCommand = async (...args) => { opened.push(args); openedSignal.resolve(); };
        `,
          }))
        },
      },
    ],
  })
  const main = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + '\n//# sourceURL=codespaces-main-test.mjs').toString('base64')}`
  )
  const requests: string[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string, init: RequestInit) => {
      const url = String(input)
      requests.push(`${init.method} ${url}`)
      if (new URL(url).pathname === '/codespaces')
        return Response.json({
          codespaces: [
            {
              name: 'happy-cat',
              state: 'Available',
              repository: { full_name: 'owner/project' },
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
        state: 'failed',
        error: 'Could not connect over SSH.',
      })
    },
  )
  await main.activate()
  t.after(() => main.deactivate())
  await assert.rejects(main.connect(), /Could not connect over SSH/)
  assert.match(main.output.at(-1), /Could not connect over SSH/)
  assert.match(main.output.at(-1), /Codespaces: Open in Browser/)
  assert.ok(
    requests.includes(
      'DELETE https://lvce-editor.dev/codespaces/connections/session',
    ),
  )
  const before = requests.length
  await main.commands.get('codespaces.openInBrowser')()
  await main.openedSignal.promise
  assert.deepEqual(main.opened, [
    ['Open.openUrl', 'https://github.com/codespaces/happy-cat', true],
  ])
  assert.equal(requests.length, before)
})
