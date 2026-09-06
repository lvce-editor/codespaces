import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { createGateway } from '../server/src/Gateway.ts'

let backend: ChildProcess
let gateway: Awaited<ReturnType<typeof createGateway>>
let workspace: string

test.beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'lvce-codespaces-e2e-'))
  await writeFile(
    path.join(workspace, 'codespaces-proof.txt'),
    'Hello from the real remote LVCE backend!\n',
  )
  backend = spawn(
    process.execPath,
    [
      process.env.LVCE_CODESPACES_TEST_BACKEND ||
        'node_modules/@lvce-editor/server/src/server.js',
      '--as-remote-ssh-server',
      '--port=0',
      '--connection-token=test-backend-secret',
      workspace,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const backendPort = await new Promise<number>((resolve, reject) => {
    const lines = createInterface({ input: backend.stdout! })
    const timer = setTimeout(
      () => reject(new Error('Backend startup timeout')),
      20_000,
    )
    backend.once('error', reject)
    lines.on('line', (line) => {
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(line)
      if (match) {
        clearTimeout(timer)
        lines.close()
        resolve(Number(match[1]))
      }
    })
  })
  // Only the identity provider is a fixture. The gateway and LVCE backend are real.
  gateway = await createGateway({
    owner: 'test-owner',
    allowedOrigin: 'http://127.0.0.1:4173',
    publicUrl: 'http://127.0.0.1:0',
    workspacePath: workspace,
    backendPort,
    backendToken: 'test-backend-secret',
    port: 0,
    verifyAccount: async (token) => {
      if (token !== 'test-lvce-token') throw new Error('Invalid test identity')
      return 'test-owner'
    },
  })
})
test.afterAll(async () => {
  if (gateway) await gateway.close()
  if (backend && backend.exitCode === null) {
    backend.kill()
    await once(backend, 'exit')
  }
  if (workspace) await rm(workspace, { recursive: true, force: true })
})
test('connects the Pages editor to real remote files', async ({
  page,
  context,
}) => {
  await context.route('https://lvce-editor.dev/account/me', (route) =>
    route.fulfill({ json: { displayName: 'Codespaces Test' } }),
  )
  await page.goto('/codespaces/')
  await page.waitForSelector('.Workbench')
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('auth-worker', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('auth')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('auth', 'readwrite')
        transaction.objectStore('auth').put('test-lvce-token', 'accessToken')
        transaction
          .objectStore('auth')
          .put(String(Date.now() + 3_600_000), 'accessTokenExpiresAt')
        transaction.oncomplete = () => {
          database.close()
          resolve()
        }
      }
    })
  })
  await context.route('https://lvce-editor.dev/oidc/me', (route) =>
    route.fulfill({ json: { sub: 'test-owner' } }),
  )
  await page.keyboard.press('F1')
  await page
    .getByRole('option', {
      name: 'Codespaces: Set Up a Codespace',
      exact: true,
    })
    .click()
  await expect(
    page.getByText(/curl --fail --silent --show-error/),
  ).toBeVisible()
  await page.keyboard.press('F1')
  await page
    .getByRole('option', {
      name: 'Codespaces: Connect to Codespace',
      exact: true,
    })
    .click()
  const input = page.getByRole('combobox', { name: /^Codespace name/ })
  await expect(input).toHaveAttribute('placeholder', /Codespace name/)
  await input.fill(`http://127.0.0.1:${gateway.port}`)
  await input.press('Enter')
  await expect(
    page.getByText('codespaces-proof.txt', { exact: true }),
  ).toBeVisible({ timeout: 45_000 })
  await page.getByText('codespaces-proof.txt', { exact: true }).dblclick()
  await expect(
    page.getByText('Hello from the real remote LVCE backend!', { exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('Saved from the Pages editor!')
  await page.keyboard.press('Control+s')
  await expect
    .poll(() => readFile(path.join(workspace, 'codespaces-proof.txt'), 'utf8'))
    .toContain('Saved from the Pages editor!')
})
