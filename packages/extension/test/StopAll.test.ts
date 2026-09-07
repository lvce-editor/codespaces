import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { build } from 'esbuild'

let fixtureId = 0
const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Command did not finish')
    await setTimeout(5)
  }
}
const codespace = (name: string, state = 'Available') => ({
  name,
  state,
  repository: { full_name: `owner/${name}` },
})
const fixture = async (
  t: TestContext,
  respond: (url: URL, init: RequestInit) => Response | Promise<Response>,
) => {
  const result = await build({
    stdin: {
      contents: `export * from './packages/extension/src/parts/Main/Main.ts';
        export { commands, output, notifications, executed } from '@lvce-editor/api';`,
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
            export const notifications = [];
            export const executed = [];
            export const activate = async () => {};
            export const getAccessToken = async () => 'test-token';
            export const registerCommand = command => commands.set(command.id, command.execute);
            export const registerFileSystemProvider = () => {};
            export const createOutputChannel = () => ({replace: async message => output.push(message)});
            export const openOutputView = async () => {};
            export const showNotification = async (...args) => notifications.push(args);
            export const showQuickPick = async () => 'connected';
            export const executeCommand = async (...args) => executed.push(args);
          `,
          }))
        },
      },
    ],
  })
  const main = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + `\n// fixture ${fixtureId++}`).toString('base64')}`
  )
  const requests: string[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string, init: RequestInit) => {
      const url = new URL(String(input))
      requests.push(`${init.method} ${url.pathname}${url.search}`)
      if (url.pathname.endsWith('/auth/github-token'))
        return Response.json({ accessToken: 'github-test-token' })
      if (url.pathname.endsWith('/connected/connect'))
        return Response.json({
          id: 'session',
          websocketUrl: 'wss://lvce-editor.dev/codespaces/connections/session/',
        })
      if (url.pathname === '/codespaces/connections/session')
        return init.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : Response.json({
              state: 'ready',
              workspacePath: '/workspaces/project',
            })
      return respond(url, init)
    },
  )
  await main.activate()
  t.after(() => main.deactivate())
  const run = async () => {
    await main.commands.get('codespaces.stopAll')()
    await waitFor(() =>
      /Stopped \d+ of \d+ Codespaces\.|No active Codespaces/.test(
        main.output.at(-1) || '',
      ),
    )
  }
  return { main, requests, run }
}

test('stop all follows pagination and continues after releasing the connected Codespace', async (t) => {
  let connecting = true
  const { main, requests, run } = await fixture(t, (url, init) => {
    if (url.pathname === '/user/codespaces') {
      const codespaces = connecting
        ? [codespace('connected')]
        : url.searchParams.get('page') === '1'
          ? [
              codespace('connected'),
              ...Array.from({ length: 99 }, (_, i) =>
                codespace(`stopped-${i}`, 'Shutdown'),
              ),
            ]
          : [codespace('other-repository', 'Starting')]
      return Response.json({ total_count: connecting ? 1 : 101, codespaces })
    }
    assert.ok(init.method === 'POST' || init.method === 'DELETE')
    return new Response(null, { status: 204 })
  })
  await main.connect()
  connecting = false
  await run()
  assert.deepEqual(
    requests.filter((value) => value.endsWith('/stop')),
    [
      'POST /user/codespaces/connected/stop',
      'POST /user/codespaces/other-repository/stop',
    ],
  )
  assert.ok(requests.includes('GET /user/codespaces?per_page=100&page=2'))
  assert.ok(requests.includes('DELETE /codespaces/connected/connections'))
  assert.ok(requests.includes('DELETE /codespaces/connections/session'))
  assert.ok(
    requests.includes('DELETE /codespaces/other-repository/connections'),
  )
  assert.deepEqual(main.executed.at(-1), ['Workspace.setUri', 'memfs:///'])
  assert.match(main.output.at(-1), /Stopped 2 of 2 Codespaces\./)
  assert.deepEqual(main.notifications, [])
})

test('stop all continues after stop and relay cleanup failures and reports both', async (t) => {
  const { main, requests, run } = await fixture(t, (url) => {
    if (url.pathname === '/user/codespaces')
      return Response.json({
        total_count: 3,
        codespaces: [
          codespace('denied'),
          codespace('cleanup-fails'),
          codespace('last'),
        ],
      })
    if (url.pathname === '/user/codespaces/denied/stop')
      return Response.json(
        { message: 'Policy denied stopping' },
        { status: 403 },
      )
    if (url.pathname === '/codespaces/cleanup-fails/connections')
      return Response.json({ error: 'Relay unavailable' }, { status: 502 })
    return new Response(null, { status: 204 })
  })
  await run()
  assert.ok(!requests.includes('DELETE /codespaces/denied/connections'))
  assert.ok(requests.includes('POST /user/codespaces/last/stop'))
  assert.match(
    main.output.at(-1),
    /Failed to stop denied: Policy denied stopping/,
  )
  assert.match(
    main.output.at(-1),
    /Stopped cleanup-fails.*Could not close all editor connections/,
  )
  assert.match(main.output.at(-1), /Stopped 2 of 3 Codespaces\./)
  await waitFor(() => main.notifications.length === 1)
  assert.match(main.notifications[0][1], /See Codespaces output for failures/)
})

for (const states of [
  [],
  ['Shutdown', 'ShuttingDown', 'Deleted', 'Archived'],
]) {
  test(`stop all handles no active Codespaces (${states.length} entries)`, async (t) => {
    const { main, requests, run } = await fixture(t, () =>
      Response.json({
        total_count: states.length,
        codespaces: states.map((state, i) => codespace(`inactive-${i}`, state)),
      }),
    )
    await run()
    assert.equal(main.output.at(-1), 'No active Codespaces to stop.')
    assert.ok(!requests.some((value) => value.endsWith('/stop')))
    assert.deepEqual(main.notifications, [])
  })
}

test('Disconnect cancels stop all without submitting more stop requests', async (t) => {
  const stopping = Promise.withResolvers<void>()
  const { main, requests } = await fixture(t, (url, init) => {
    if (url.pathname === '/user/codespaces')
      return Response.json({
        total_count: 2,
        codespaces: [codespace('first'), codespace('second')],
      })
    return new Promise((_resolve, reject) => {
      stopping.resolve()
      init.signal!.addEventListener(
        'abort',
        () => reject(init.signal!.reason),
        { once: true },
      )
    })
  })
  await main.commands.get('codespaces.stopAll')()
  await stopping.promise
  await main.commands.get('codespaces.disconnect')()
  await waitFor(() =>
    main.executed.some((args: string[]) => args[0] === 'Workspace.setUri'),
  )
  // The cancelled management command must release the busy guard.
  await setTimeout(5)
  await main.commands.get('codespaces.start')()
  await waitFor(
    () =>
      requests.filter((value) => value.includes('/auth/github-token'))
        .length === 2,
  )
  assert.deepEqual(
    requests.filter((value) => value.endsWith('/stop')),
    ['POST /user/codespaces/first/stop'],
  )
  assert.deepEqual(main.notifications, [])
  assert.doesNotMatch(main.output.at(-1), /Stopped \d+ of/)
})
