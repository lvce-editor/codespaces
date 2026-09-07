import { deepStrictEqual, rejects } from 'node:assert/strict'
import { test } from 'node:test'
import {
  createPortProvider,
  getConfiguredPorts,
} from '../src/parts/PortProvider/PortProvider.ts'

test('loads configured port 3000 with its Codespaces address', async () => {
  const requested: string[] = []
  const provider = createPortProvider(async (uri) => {
    requested.push(uri)
    return '{ // app server\n "forwardPorts": [3000,], }'
  })
  deepStrictEqual(
    await provider.providePorts('codespaces://test-space/workspaces/app'),
    [
      {
        port: 3000,
        forwardedAddress: 'https://test-space-3000.app.github.dev/',
        origin: 'devcontainer.json',
      },
    ],
  )
  deepStrictEqual(requested, [
    'codespaces://test-space/workspaces/app/.devcontainer/devcontainer.json',
  ])
})

test('handles both config locations and missing configurations', async () => {
  const provider = createPortProvider(async (uri) => {
    if (uri.endsWith('/.devcontainer/devcontainer.json'))
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return '{"forwardPorts": [3000]}'
  })
  deepStrictEqual(
    await provider.providePorts('codespaces://test-space/workspaces/app/'),
    getConfiguredPorts('{"forwardPorts":[3000]}', 'test-space'),
  )
  const missing = createPortProvider(async () => {
    throw new Error('ENOENT')
  })
  deepStrictEqual(
    await missing.providePorts('codespaces://test-space/workspaces/app'),
    [],
  )
})

test('validates, sorts and deduplicates configured ports', () => {
  const ports = getConfiguredPorts(
    JSON.stringify({
      forwardPorts: [
        3000,
        'localhost:5173',
        '127.0.0.1:3000',
        0,
        65536,
        1.5,
        'db:5432',
        null,
      ],
    }),
    'test-space',
  )
  deepStrictEqual(
    ports.map((port) => port.port),
    [3000, 5173],
  )
  deepStrictEqual(getConfiguredPorts('{invalid', 'test-space'), [])
  deepStrictEqual(getConfiguredPorts('{}', 'test-space'), [])
  deepStrictEqual(
    getConfiguredPorts('{"forwardPorts":[3000]}', 'attacker.example'),
    [],
  )
  deepStrictEqual(
    getConfiguredPorts(
      '{"forwardPorts":[3000]}',
      'test-space-3774.app.github.dev',
    ),
    getConfiguredPorts('{"forwardPorts":[3000]}', 'test-space'),
  )
})

test('preserves connection errors instead of showing an empty port list', async () => {
  const provider = createPortProvider(async () => {
    throw new Error('disconnected')
  })
  await rejects(
    async () => provider.providePorts('codespaces://test-space/workspaces/app'),
    /disconnected/,
  )
  deepStrictEqual(await provider.providePorts('file:///workspaces/app'), [])
})
