import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, readFile, rm, glob } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createGateway } from '../server/src/Gateway.ts'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const browserOrigin = `http://127.0.0.1:${process.env.LVCE_CODESPACES_TEST_PORT || 4173}`
let backend: ChildProcess
let gateway: Awaited<ReturnType<typeof createGateway>>
let workspace: string
let originalExtension: { path: string; source: string } | undefined
test.afterEach(async () => {
  if (originalExtension) {
    await writeFile(originalExtension.path, originalExtension.source)
    originalExtension = undefined
  }
})

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
        fileURLToPath(import.meta.resolve('@lvce-editor/server/src/server.js')),
      '--as-remote-ssh-server',
      '--port=0',
      '--connection-token=test-backend-secret',
      workspace,
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
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
    allowedOrigin: browserOrigin,
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
  await page.keyboard.press('F1')
  await page
    .getByRole('combobox', {
      name: 'Type the name of a command to run.',
      exact: true,
    })
    .fill('>Codespaces: Connect to Manual Gateway')
  await page
    .getByRole('option', {
      name: 'Codespaces: Connect to Manual Gateway',
      exact: true,
    })
    .click()
  const input = page.getByRole('combobox', { name: /^Codespace forwarded/ })
  await expect(input).toHaveAttribute('placeholder', /Codespace forwarded/)
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

test('creates, connects and stops a Codespace entirely from Pages', async ({
  page,
  context,
  request,
}) => {
  const id = 'a'.repeat(64)
  const operations: string[] = []
  const auth = await request.post(
    `http://127.0.0.1:${gateway.port}/auth/connect`,
    {
      headers: {
        Origin: browserOrigin,
        Authorization: 'Bearer test-lvce-token',
      },
    },
  )
  const { sessionToken } = await auth.json()
  const codespace = {
    name: 'browser-test-codespace',
    state: 'Available',
    repository: { full_name: 'test/project' },
  }
  await context.route('https://lvce-editor.dev/account/me', (route) =>
    route.fulfill({ json: { displayName: 'Codespaces Test' } }),
  )
  await context.route('https://lvce-editor.dev/codespaces**', async (route) => {
    const req = route.request()
    const pathname = new URL(req.url()).pathname
    expect(req.headers().authorization).toBe('Bearer test-lvce-token')
    if (pathname.endsWith('/auth/websocket-ticket')) {
      const response = await request.post(
        `http://127.0.0.1:${gateway.port}/auth/websocket-ticket`,
        {
          headers: {
            Origin: browserOrigin,
            Authorization: `Bearer ${sessionToken}`,
          },
        },
      )
      await route.fulfill({ json: await response.json() })
      return
    }
    operations.push(`${req.method()} ${pathname}`)
    if (pathname === '/codespaces' && req.method() === 'POST') {
      expect(req.postDataJSON()).toEqual({ repository: 'test/project' })
      await route.fulfill({ status: 201, json: codespace })
      return
    }
    if (pathname.endsWith('/connect')) {
      await route.fulfill({
        status: 202,
        json: {
          id,
          websocketUrl: `wss://lvce-editor.dev/codespaces/connections/${id}/`,
        },
      })
      return
    }
    if (
      pathname === `/codespaces/connections/${id}` &&
      req.method() === 'GET'
    ) {
      await route.fulfill({
        json: { id, state: 'ready', workspacePath: workspace },
      })
      return
    }
    if (pathname === '/codespaces') {
      await route.fulfill({ json: { total_count: 1, codespaces: [codespace] } })
      return
    }
    await route.fulfill({ json: {} })
  })
  // Playwright cannot route WebSockets created in workers. Substitute only the
  // fixture transport destination in the served extension, leaving the actual
  // ticket exchange, RPC, and remote filesystem implementation intact.
  const [extensionPath] = await Array.fromAsync(
    glob(path.join(repoRoot, 'dist/**/codespacesMain.js')),
  )
  originalExtension = {
    path: extensionPath,
    source: await readFile(extensionPath, 'utf8'),
  }
  const shim = `const fixtureWebSocketUrl = (url) => {
    if (url.origin === 'wss://lvce-editor.dev' && url.pathname.startsWith('/codespaces/connections/${id}/')) {
      url.protocol = 'ws:';
      url.host = '127.0.0.1:${gateway.port}';
      url.pathname = url.pathname.replace('/codespaces/connections/${id}', '');
    }
    return url.href;
  };\n`
  // Return the fixture destination to filesystem and core process workers.
  // afterEach restores the artifact before CI can upload it to GitHub Pages.
  expect(originalExtension.source).toContain('return url.href;')
  await writeFile(
    extensionPath,
    shim +
      originalExtension.source.replace(
        'return url.href;',
        'return fixtureWebSocketUrl(url);',
      ),
  )
  await page.goto('/codespaces/')
  await page.waitForSelector('.Workbench')
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('auth-worker', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('auth')
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const database = req.result
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
  await page.keyboard.press('F1')
  await page
    .getByRole('combobox', {
      name: 'Type the name of a command to run.',
      exact: true,
    })
    .fill('>Codespaces: Set Up a Codespace')
  await page
    .getByRole('option', {
      name: 'Codespaces: Set Up a Codespace',
      exact: true,
    })
    .click()
  const repository = page.getByRole('combobox', {
    name: /^Repository to create/,
  })
  await repository.fill('test/project')
  await repository.press('Enter')
  await page.getByRole('option', { name: /Create and Connect/ }).click()
  await expect(
    page.getByText('codespaces-proof.txt', { exact: true }),
  ).toBeVisible({ timeout: 45_000 })
  await page.getByText('codespaces-proof.txt', { exact: true }).dblclick()
  await expect(
    page.getByText('Hello from the real remote LVCE backend!', { exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('Browser-only connection saved this.')
  await page.keyboard.press('Control+s')
  await expect
    .poll(() => readFile(path.join(workspace, 'codespaces-proof.txt'), 'utf8'))
    .toContain('Browser-only connection saved this.')
  await page.keyboard.press('F1')
  await page
    .getByRole('combobox', {
      name: 'Type the name of a command to run.',
      exact: true,
    })
    .fill('>Codespaces: Stop Codespace')
  await page
    .getByRole('option', { name: 'Codespaces: Stop Codespace', exact: true })
    .click()
  await page.getByRole('option', { name: /browser-test-codespace/ }).click()
  await expect
    .poll(() => operations)
    .toContain('POST /codespaces/browser-test-codespace/stop')
  await expect
    .poll(() => operations)
    .toContain(`DELETE /codespaces/connections/${id}`)
  expect(operations).toContain('POST /codespaces')
  expect(operations).toContain(
    'POST /codespaces/browser-test-codespace/connect',
  )
})
