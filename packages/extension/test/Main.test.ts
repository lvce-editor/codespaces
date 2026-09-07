import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

for (const outcome of ['available', 'unavailable', 'cancelled'] as const) {
  test(`failed connection opens its creation log: ${outcome}`, async (t) => {
    const result = await build({
      stdin: {
        contents: `export * from '../src/parts/Main/Main.ts';
        export { commands, output, opened, openedSignal, files, logs } from '@lvce-editor/api';`,
        resolveDir: import.meta.dirname,
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
          export const files = new Map();
          export const logs = [];
          export const mkdir = async () => {};
          export const writeFile = async (uri, content) => files.set(uri, content);
          export const openUri = async uri => logs.push(uri);
          export const openedSignal = Promise.withResolvers();
          export const activate = async () => {};
          export const getAccessToken = async () => 'test-token';
          export const registerCommand = command => commands.set(command.id, command.execute);
          export const registerFileSystemProvider = () => {};
          export const createOutputChannel = () => ({replace: async message => output.push(message)});
          export const openOutputView = async () => {};
          export const showNotification = async () => {};
          export const showQuickPick = async () => 'happy-cat';
          export const executeCommand = async (...args) => { if (args[0] === 'Open.openUrl') { opened.push(args); openedSignal.resolve(); } };
        `,
            }))
          },
        },
      ],
    })
    const main = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + `\n//# sourceURL=codespaces-main-${outcome}-test.mjs`).toString('base64')}`
    )
    const requests: string[] = []
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string, init: RequestInit) => {
        const url = String(input)
        requests.push(`${init.method} ${url}`)
        if (url.endsWith('/auth/github-token'))
          return Response.json({ accessToken: 'github-test-token' })
        if (new URL(url).pathname === '/user/codespaces')
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
            websocketUrl:
              'wss://lvce-editor.dev/codespaces/connections/session/',
          })
        if (url.endsWith('/happy-cat/creation-log')) {
          if (outcome === 'cancelled') {
            await main.deactivate()
            return Response.json({
              content: 'must not open after cancellation',
            })
          }
          if (outcome === 'unavailable')
            return Response.json({ error: 'Log unavailable' }, { status: 502 })
          return Response.json({
            content: 'Container creation failed: image not found.\n',
          })
        }
        if (init.method === 'DELETE') return new Response(null, { status: 204 })
        return Response.json({
          state: 'failed',
          error: 'Could not connect over SSH.',
        })
      },
    )
    await main.activate()
    t.after(() => main.deactivate())
    if (outcome === 'cancelled') await main.connect()
    else await assert.rejects(main.connect(), /Could not connect over SSH/)
    if (outcome === 'available') {
      const uri = 'memfs:///codespaces-happy-cat/creation.log'
      assert.deepEqual(main.logs, [uri])
      assert.equal(
        main.files.get(uri),
        'Container creation failed: image not found.\n',
      )
    } else assert.deepEqual(main.logs, [])
    assert.match(main.output.at(-1), /Could not connect over SSH/)
    if (outcome !== 'cancelled')
      assert.match(main.output.at(-1), /Codespaces: Open in Browser/)
    assert.match(main.output.at(-1), /Checking Codespace status/)
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
}
