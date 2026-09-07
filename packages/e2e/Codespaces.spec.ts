import { test, expect } from '@playwright/test'

test('sign-in callback returns to Codespaces and preserves the callback for account restoration', async ({
  page,
}) => {
  await page.goto(
    '/codespaces/auth/callback.html?code=test-code&state=test-state',
  )
  await expect(page).toHaveURL(/\/codespaces\/$/)
  const callback = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open('auth-worker')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const read = database
            .transaction('auth')
            .objectStore('auth')
            .get('oidcCallbackUrl')
          read.onerror = () => reject(read.error)
          read.onsuccess = () => {
            database.close()
            resolve(read.result)
          }
        }
      }),
  )
  expect(new URL(callback).pathname).toBe('/codespaces/auth/callback.html')
  expect(new URL(callback).searchParams.get('code')).toBe('test-code')
  expect(new URL(callback).searchParams.get('state')).toBe('test-state')
})

test('Pages export loads and exposes Codespaces commands', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/codespaces/')
  await page.waitForSelector('.Workbench', { timeout: 45_000 })
  await page.keyboard.press('F1')
  await page
    .getByRole('combobox', {
      name: 'Type the name of a command to run.',
      exact: true,
    })
    .fill('>Codespaces:')
  await expect(
    page.getByText('Codespaces: Connect to Codespace', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Codespaces: Set Up a Codespace', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Codespaces: Disconnect', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Codespaces: Open in Browser', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Codespaces: Stop All Codespaces', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Codespaces: View Creation Log', { exact: true }),
  ).toBeVisible()
  expect(errors).toEqual([])
})
test('setup instructions and executable download are deployed', async ({
  page,
  request,
}) => {
  await page.goto('/codespaces/setup.html')
  await expect(
    page.getByRole('heading', { name: 'Use your Codespace in LVCE Editor' }),
  ).toBeVisible()
  const script = await request.get('/codespaces/setup.mjs')
  expect(script.ok()).toBeTruthy()
  expect(await script.text()).toContain('lvce-editor.dev/oidc/me')
})

test('signed-out setup asks for the existing LVCE login', async ({ page }) => {
  await page.goto('/codespaces/')
  await page.waitForSelector('.Workbench')
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
  await expect(
    page.getByText(
      'Sign in to LVCE using the account button, then run this command again.',
      { exact: true },
    ),
  ).toBeVisible()
})

test('failed setup automatically opens the creation log in the editor', async ({
  page,
  context,
}) => {
  const operations: string[] = []
  await context.route('https://lvce-editor.dev/account/me', (route) =>
    route.fulfill({ json: { displayName: 'Codespaces Test' } }),
  )
  await context.route('https://api.github.com/user/codespaces*', (route) =>
    route.fulfill({
      json: {
        codespaces: [
          {
            name: 'failed-container',
            state: 'Available',
            repository: { full_name: 'test/project' },
          },
        ],
        total_count: 1,
      },
    }),
  )
  await context.route(
    'https://lvce-editor.dev/codespaces/**',
    async (route) => {
      const pathname = new URL(route.request().url()).pathname
      operations.push(`${route.request().method()} ${pathname}`)
      if (pathname.endsWith('/auth/github-token'))
        await route.fulfill({ json: { accessToken: 'github-test-token' } })
      else if (pathname.endsWith('/failed-container/connect'))
        await route.fulfill({
          json: {
            id: 'session',
            websocketUrl:
              'wss://lvce-editor.dev/codespaces/connections/session/',
          },
        })
      else if (pathname.endsWith('/failed-container/creation-log'))
        await route.fulfill({
          json: { content: 'Failed to create container: image not found.\n' },
        })
      else if (route.request().method() === 'DELETE')
        await route.fulfill({ status: 204 })
      else
        await route.fulfill({
          json: {
            state: 'failed',
            error: 'Could not install the LVCE runtime.',
          },
        })
    },
  )
  await page.goto('/codespaces/')
  await page.waitForSelector('.Workbench')
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
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
      }),
  )
  await page.keyboard.press('F1')
  await page
    .getByRole('combobox', {
      name: 'Type the name of a command to run.',
      exact: true,
    })
    .fill('>Codespaces: Connect to Codespace')
  await page
    .getByRole('option', {
      name: 'Codespaces: Connect to Codespace',
      exact: true,
    })
    .click()
  await page.getByRole('option', { name: /failed-container/ }).click()
  await expect(
    page.getByText('creation.log', { exact: true }).first(),
  ).toBeVisible()
  await expect(
    page.getByText('Failed to create container: image not found.', {
      exact: true,
    }),
  ).toBeVisible()
  expect(operations).toContain('GET /codespaces/failed-container/creation-log')
  expect(operations).toContain('DELETE /codespaces/connections/session')
  expect(operations.some((operation) => operation.endsWith('/stop'))).toBe(
    false,
  )
})
