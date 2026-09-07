import {
  BackendStartupTimeoutError,
  InvalidAccountIdError,
} from '../shared/src/Errors.ts'
import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm, glob } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createGateway } from '../server/src/parts/Gateway/Gateway.ts'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const browserOrigin = `http://127.0.0.1:${process.env.LVCE_CODESPACES_TEST_PORT || 4173}`
let backend: ChildProcess
let gateway: Awaited<ReturnType<typeof createGateway>>
let gatewayOptions: Parameters<typeof createGateway>[0]
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
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  const lines = createInterface({ input: backend.stdout! })
  const timer = setTimeout(
    () => reject(new BackendStartupTimeoutError('Backend startup timeout')),
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
  const backendPort = await promise
  // Only the identity provider is a fixture. The gateway and LVCE backend are real.
  gatewayOptions = {
    owner: 'test-owner',
    allowedOrigin: browserOrigin,
    publicUrl: 'http://127.0.0.1:0',
    workspacePath: workspace,
    backendPort,
    backendToken: 'test-backend-secret',
    port: 0,
    verifyAccount: async (token) => {
      if (token !== 'test-lvce-token')
        throw new InvalidAccountIdError('Invalid test identity')
      return 'test-owner'
    },
  }
  gateway = await createGateway(gatewayOptions)
})
test.afterAll(async () => {
  if (gateway) await gateway.close()
  if (backend && backend.exitCode === null) {
    backend.kill()
    await once(backend, 'exit')
  }
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

test('opens a working terminal after the relay closes and reconnects', async ({
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
  const runCommand = async (name: string): Promise<void> => {
    await page.keyboard.press('Control+Shift+p')
    await page
      .getByRole('combobox', {
        name: 'Type the name of a command to run.',
        exact: true,
      })
      .fill(`>${name}`)
    await page.getByRole('option', { name, exact: true }).click()
  }
  const connect = async (): Promise<void> => {
    await runCommand('Codespaces: Connect to Manual Gateway')
    const input = page.getByRole('combobox', { name: /^Codespace forwarded/ })
    await input.fill(`http://127.0.0.1:${gateway.port}`)
    await input.press('Enter')
    await expect(
      page.getByText('codespaces-proof.txt', { exact: true }),
    ).toBeVisible()
    const terminals = page.locator('.PanelTab[name="Terminals"]')
    if (!(await terminals.isVisible())) await runCommand('Layout: Toggle Panel')
    await terminals.click()
  }
  const verifyTerminal = async (file: string): Promise<void> => {
    const input = page.locator('.xterm-helper-textarea')
    await expect(input).toBeVisible()
    await input.pressSequentially(`printf working > ${file}`)
    await input.press('Enter')
    await expect
      .poll(() => readFile(path.join(workspace, file), 'utf8').catch(() => ''))
      .toBe('working')
  }
  await connect()
  await verifyTerminal('before-reconnect.txt')
  await runCommand('Codespaces: Disconnect')
  await expect(
    page.getByRole('heading', { name: '/', exact: true }),
  ).toBeVisible()
  const port = gateway.port
  // Real socket closure is essential: an HTTP-only cleanup fixture cannot catch
  // a worker reusing an RPC connection after the relay has terminated it.
  await gateway.close()
  gateway = await createGateway({ ...gatewayOptions, port })
  await connect()
  await page.getByRole('button', { name: 'New Terminal', exact: true }).click()
  await verifyTerminal('after-reconnect.txt')
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
    const { promise, resolve, reject } = Promise.withResolvers<void>()
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
    await promise
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
  await mkdir(path.join(workspace, '.devcontainer'), { recursive: true })
  await writeFile(
    path.join(workspace, '.devcontainer/devcontainer.json'),
    `{
    // Open the forwarded app next to the remote source code.
    "forwardPorts": [3000],
    "portsAttributes": { "3000": { "label": "Bad Apple", "onAutoForward": "openPreview" } }
  }`,
  )
  let previewRequests = 0
  await context.route(
    'https://browser-test-codespace-3000.app.github.dev/',
    (route) => {
      previewRequests++
      return route.fulfill({
        contentType: 'text/html',
        body: '<h1>Running application</h1><button onclick="this.textContent=\'App is interactive\'">Test app</button>',
      })
    },
  )
  const id = 'a'.repeat(64)
  const operations: string[] = []
  let startupState = 'Provisioning'
  let setupStage: string | undefined
  let setupReady = false
  const repositoryPages: number[] = []
  const repositories = [
    ...Array.from({ length: 200 }, (_, i) => ({
      full_name: `test/repository-${i}`,
      private: false,
    })),
    { full_name: 'test/project', private: true },
  ]
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
  let cleanupFails = false
  let tokenRequests = 0
  let statePolls = 0
  let refreshRequests = 0
  await context.route('https://lvce-editor.dev/oidc/token', async (route) => {
    const req = route.request()
    const body = new URLSearchParams(req.postData() || '')
    expect(req.method()).toBe('POST')
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('test-refresh-token')
    expect(body.get('client_id')).toBe('lvce-editor-web')
    refreshRequests++
    await route.fulfill({
      json: {
        access_token: 'test-lvce-token',
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    })
  })
  await context.route('https://api.github.com/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const pathname = url.pathname
    expect(req.headers().authorization).toBe('Bearer test-github-token')
    expect(url.searchParams.has('token')).toBe(false)
    operations.push(`${req.method()} ${pathname}`)
    if (pathname === '/user/repos') {
      const pageNumber = Number(url.searchParams.get('page'))
      repositoryPages.push(pageNumber)
      await route.fulfill({
        json: repositories.slice((pageNumber - 1) * 100, pageNumber * 100),
      })
      return
    }
    if (
      pathname === '/repos/test/project/codespaces' &&
      req.method() === 'POST'
    ) {
      expect(req.postDataJSON()).toEqual({})
      codespace.state = 'Shutdown'
      await route.fulfill({ status: 201, json: codespace })
      return
    }
    if (
      pathname === '/user/codespaces/browser-test-codespace/start' &&
      req.method() === 'POST'
    ) {
      codespace.state = 'Starting'
      await route.fulfill({ status: 204 })
      return
    }
    if (
      pathname === '/user/codespaces/browser-test-codespace' &&
      req.method() === 'GET'
    ) {
      statePolls++
      codespace.state = startupState
      await route.fulfill({ json: codespace })
      return
    }
    if (pathname === '/user/codespaces') {
      await route.fulfill({ json: { total_count: 1, codespaces: [codespace] } })
      return
    }
    if (
      pathname === '/user/codespaces/browser-test-codespace/stop' &&
      req.method() === 'POST'
    ) {
      codespace.state = 'Shutdown'
      await route.fulfill({ status: 204 })
      return
    }
    throw new Error(`Unexpected GitHub request: ${req.method()} ${pathname}`)
  })
  await context.route('https://lvce-editor.dev/codespaces**', async (route) => {
    const req = route.request()
    const pathname = new URL(req.url()).pathname
    expect(req.headers().authorization).toBe('Bearer test-lvce-token')
    expect(req.postData() || '').not.toContain('test-github-token')
    operations.push(`${req.method()} ${pathname}`)
    if (
      pathname === '/codespaces/auth/github-token' &&
      req.method() === 'POST'
    ) {
      tokenRequests++
      await route.fulfill({
        json: { accessToken: 'test-github-token' },
        headers: { 'cache-control': 'no-store' },
      })
      return
    }
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
    if (
      pathname === '/codespaces/browser-test-codespace/connect' &&
      req.method() === 'POST'
    ) {
      expect(codespace.state).toBe('Available')
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
        json: {
          id,
          state: setupReady ? 'ready' : 'starting',
          stage: setupStage,
          workspacePath: workspace,
        },
      })
      return
    }
    if (
      pathname === '/codespaces/browser-test-codespace/connections' &&
      cleanupFails
    ) {
      await route.fulfill({
        status: 502,
        json: { error: 'Cleanup unavailable' },
      })
      return
    }
    if (
      [
        `/codespaces/connections/${id}`,
        '/codespaces/browser-test-codespace/connections',
      ].includes(pathname) &&
      req.method() === 'DELETE'
    ) {
      await route.fulfill({ status: 204 })
      return
    }
    throw new Error(`Unexpected backend request: ${req.method()} ${pathname}`)
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
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const req = indexedDB.open('auth-worker', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('auth')
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const database = req.result
      const transaction = database.transaction('auth', 'readwrite')
      transaction.objectStore('auth').put('expired-lvce-token', 'accessToken')
      transaction.objectStore('auth').put('test-refresh-token', 'refreshToken')
      transaction.objectStore('auth').put('lvce-editor-web', 'oidcClientId')
      transaction
        .objectStore('auth')
        .put(String(Date.now() - 60_000), 'accessTokenExpiresAt')
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
    }
    await promise
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
  await page
    .getByRole('option', { name: /^test\/project/ })
    .click({ timeout: 5000 })
  expect(repositoryPages).toEqual([1, 2, 3])
  await page.getByRole('option', { name: /Create and Connect/ }).click()
  await expect(
    page.getByText(/GitHub is provisioning the Codespace/),
  ).toBeVisible()
  await expect(page.getByText(/Elapsed: 0m [1-9]\d*s/)).toBeVisible()
  startupState = 'Starting'
  await expect(page.getByText(/GitHub is starting the Codespace/)).toBeVisible()
  startupState = 'Available'
  // Older backends omit stage; waiting must still be visible.
  await expect(
    page.getByText(/Waiting for remote setup and the private connection/),
  ).toBeVisible()
  setupStage = 'installing-server'
  await expect(
    page.getByText(/Checking and installing the LVCE remote server/),
  ).toBeVisible()
  // Output virtualizes its rows and follows the latest progress. Scroll back to
  // verify earlier stages remain available after the current stage advances.
  await page.getByRole('log').hover()
  await page.mouse.wheel(0, -1000)
  await expect(
    page.getByText(/GitHub is provisioning the Codespace/),
  ).toBeVisible()
  await page.mouse.wheel(0, 1000)
  setupStage = 'opening-tunnel'
  await expect(
    page.getByText(/Establishing the private connection/),
  ).toBeVisible()
  setupReady = true
  await expect(
    page.getByText(/Connected to browser-test-codespace\./),
  ).toBeVisible()
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
  const preview = page.locator('iframe.CodespacesPreviewFrame')
  await expect(preview).toHaveAttribute(
    'src',
    'https://browser-test-codespace-3000.app.github.dev/',
  )
  const app = page.frameLocator('iframe.CodespacesPreviewFrame')
  await expect(
    app.getByRole('heading', { name: 'Running application' }),
  ).toBeVisible()
  await app.getByRole('button', { name: 'Test app' }).click()
  await expect(
    app.getByRole('button', { name: 'App is interactive' }),
  ).toBeVisible()
  const editorBounds = await page.locator('.Editor').first().boundingBox()
  const previewBounds = await preview.boundingBox()
  expect(editorBounds!.x + editorBounds!.width).toBeLessThanOrEqual(
    previewBounds!.x + 1,
  )
  await expect(preview).toHaveAttribute(
    'sandbox',
    /allow-scripts allow-same-origin/,
  )
  await page.screenshot({
    path: test.info().outputPath('application-preview.png'),
  })
  const requestsBeforeReload = previewRequests
  await page.getByRole('button', { name: 'Reload', exact: true }).click()
  await expect.poll(() => previewRequests).toBeGreaterThan(requestsBeforeReload)
  await expect(app.getByRole('button', { name: 'Test app' })).toBeVisible()

  await page.locator('.PanelTab[name="Terminals"]').click()
  const terminalInput = page.locator('.xterm-helper-textarea')
  await expect(terminalInput).toBeVisible()
  await terminalInput.pressSequentially(
    "printf 'Remote terminal worked' > terminal-proof.txt",
  )
  await terminalInput.press('Enter')
  await expect
    .poll(() =>
      readFile(path.join(workspace, 'terminal-proof.txt'), 'utf8').catch(
        () => '',
      ),
    )
    .toBe('Remote terminal worked')
  await page
    .getByRole('tab', { name: 'codespaces-proof.txt Close', exact: true })
    .getByRole('button', { name: 'Close', exact: true })
    .click()
  const stopFromPicker = async (): Promise<void> => {
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
  }
  await stopFromPicker()
  await expect
    .poll(() => operations)
    .toContain('POST /user/codespaces/browser-test-codespace/stop')
  await expect
    .poll(() => operations)
    .toContain(`DELETE /codespaces/connections/${id}`)
  await expect(preview).toHaveCount(0)
  expect(operations).toContain('POST /repos/test/project/codespaces')
  expect(operations).toContain(
    'POST /user/codespaces/browser-test-codespace/start',
  )
  expect(operations).toContain(
    'DELETE /codespaces/browser-test-codespace/connections',
  )
  expect(statePolls).toBeGreaterThanOrEqual(3)
  expect(tokenRequests).toBe(2)
  expect(refreshRequests).toBe(1)
  expect(
    operations.indexOf('DELETE /codespaces/browser-test-codespace/connections'),
  ).toBeGreaterThan(
    operations.indexOf('POST /user/codespaces/browser-test-codespace/stop'),
  )
  expect(operations).toContain(
    'POST /codespaces/browser-test-codespace/connect',
  )
  cleanupFails = true
  await stopFromPicker()
  await expect(
    page.getByText(
      /Stopped browser-test-codespace.*Could not close all editor connections/,
    ),
  ).toBeVisible()
  expect(tokenRequests).toBe(3)
  expect(
    operations.filter(
      (value) => value === 'POST /user/codespaces/browser-test-codespace/stop',
    ),
  ).toHaveLength(2)
})
