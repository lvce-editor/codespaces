import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getAppPreview,
  readAppPreview,
} from '../src/parts/AppPreview/AppPreview.ts'

const config = (port: unknown = 3000, action = 'openPreview') =>
  JSON.stringify({
    forwardPorts: [port],
    portsAttributes: { '3000': { label: 'Bad Apple', onAutoForward: action } },
  })
test('resolves explicit preview ports to HTTPS Codespaces forwarding URLs', () => {
  for (const port of [3000, 'localhost:3000', '127.0.0.1:3000']) {
    assert.deepEqual(getAppPreview(config(port), 'happy-cat'), {
      port: 3000,
      label: 'Bad Apple',
      url: 'https://happy-cat-3000.app.github.dev/',
    })
  }
  assert.equal(
    getAppPreview(
      '// comment\n' + config().replace('[3000]', '[3000,]'),
      'happy-cat',
    )?.port,
    3000,
  )
})
test('does not auto-open unconfigured, invalid, or non-local ports', () => {
  for (const port of [0, 65536, 1.5, 'db:3000', '3000', null, {}, -3000])
    assert.equal(getAppPreview(config(port), 'happy-cat'), undefined)
  for (const action of ['ignore', 'silent', 'notify', 'openBrowser'])
    assert.equal(getAppPreview(config(3000, action), 'happy-cat'), undefined)
  for (const source of [
    '{}',
    'null',
    '[]',
    '{bad json}',
    '{"forwardPorts":[3000],"portsAttributes":null}',
  ])
    assert.equal(getAppPreview(source, 'happy-cat'), undefined)
  assert.equal(getAppPreview(config(), 'host/path'), undefined)
})
test('reads root fallback only when the standard config is missing', async () => {
  const paths: string[] = []
  const result = await readAppPreview(
    'codespaces://happy-cat/workspaces/project/',
    'happy-cat',
    async (uri) => {
      paths.push(uri)
      if (paths.length === 1)
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      return config()
    },
    new AbortController().signal,
  )
  assert.equal(result?.port, 3000)
  assert.deepEqual(paths, [
    'codespaces://happy-cat/workspaces/project/.devcontainer/devcontainer.json',
    'codespaces://happy-cat/workspaces/project/.devcontainer.json',
  ])
})
test('does not open stale previews after disconnect or hide filesystem errors', async () => {
  const controller = new AbortController()
  await assert.rejects(
    readAppPreview(
      'codespaces://happy-cat/project',
      'happy-cat',
      async () => {
        controller.abort()
        return config()
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  )
  await assert.rejects(
    readAppPreview(
      'codespaces://happy-cat/project',
      'happy-cat',
      async () => {
        throw new Error('offline')
      },
      new AbortController().signal,
    ),
    /offline/,
  )
})
