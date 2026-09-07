import { expect, test, type Page } from '@playwright/test'

const seedSignIn = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    ;(window as any).proofSignIn = new Promise<void>((resolve) => {
      const request = indexedDB.open('auth-worker', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('auth')
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction('auth', 'readwrite')
        transaction.objectStore('auth').put('fixture-lvce-token', 'accessToken')
        transaction.oncomplete = () => {
          db.close()
          resolve()
        }
      }
    })
  })
}

test('experimental static bundle loads without Node globals and explains missing sign-in', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/codespaces/experimental/')
  await page
    .getByRole('button', { name: 'Load Codespaces', exact: true })
    .click()
  await expect(page.getByRole('status')).toContainText(
    'Sign in using the LVCE editor link',
  )
  expect(errors).toEqual([])
  await expect(
    page.getByRole('textbox', { name: 'File contents' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Start terminal', exact: true }),
  ).toBeVisible()
})

test('lifecycle runs directly against GitHub and cancelling never stops compute', async ({
  page,
}) => {
  await seedSignIn(page)
  const operations: string[] = []
  await page.route('https://lvce-editor.dev/codespaces/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    operations.push(`${route.request().method()} ${path}`)
    expect(route.request().headers().authorization).toBe(
      'Bearer fixture-lvce-token',
    )
    await route.fulfill({
      status: path.endsWith('/github-token') ? 200 : 502,
      json: path.endsWith('/github-token')
        ? { accessToken: 'fixture-github-token' }
        : { error: 'Fixture: no live tunnel' },
    })
  })
  await page.route('https://api.github.com/**', async (route) => {
    expect(route.request().headers().authorization).toBe(
      'Bearer fixture-github-token',
    )
    const path = new URL(route.request().url()).pathname
    operations.push(`${route.request().method()} ${path}`)
    await route.fulfill({
      json: path.endsWith('/stop')
        ? {}
        : {
            total_count: 1,
            codespaces: [
              {
                name: 'fixture-space',
                state: 'Available',
                repository: { full_name: 'lvce-editor/codespaces' },
              },
            ],
          },
    })
  })
  await page.goto('/codespaces/experimental/')
  await page.evaluate(() => (window as any).proofSignIn)
  await page
    .getByRole('button', { name: 'Load Codespaces', exact: true })
    .click()
  await expect(page.getByRole('status')).toHaveText('1 Codespaces available.')
  await page
    .getByRole('button', { name: 'Connect / reconnect', exact: true })
    .click()
  await expect(page.getByRole('status')).toHaveText('Fixture: no live tunnel')
  await page
    .getByRole('button', { name: 'Disconnect / cancel', exact: true })
    .click()
  expect(operations.some((value) => value.endsWith('/stop'))).toBe(false)
  expect(operations).toContain(
    'POST /codespaces/fixture-space/browser-connection',
  )
  expect(
    operations.some(
      (value) => value.endsWith('/connect') || value.includes('/connections/'),
    ),
  ).toBe(false)
  await page
    .getByRole('button', { name: 'Stop Codespace', exact: true })
    .click()
  await expect
    .poll(() => operations.includes('POST /user/codespaces/fixture-space/stop'))
    .toBe(true)
})

test('expired credentials explain recovery without calling GitHub', async ({
  page,
}) => {
  await seedSignIn(page)
  const githubRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'api.github.com')
      githubRequests.push(request.url())
  })
  await page.route('https://lvce-editor.dev/codespaces/**', (route) =>
    route.fulfill({ status: 401, json: { error: 'Unauthorized' } }),
  )
  await page.goto('/codespaces/experimental/')
  await page.evaluate(() => (window as any).proofSignIn)
  await page
    .getByRole('button', { name: 'Load Codespaces', exact: true })
    .click()
  await expect(page.getByRole('status')).toHaveText(
    'LVCE sign-in expired. Open the editor to refresh it, then reconnect.',
  )
  expect(githubRequests).toEqual([])
})

test('disconnect cancels a discovery in progress and allows another attempt', async ({
  page,
}) => {
  await seedSignIn(page)
  let discoveries = 0
  const releases: (() => void)[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('https://lvce-editor.dev/codespaces/**', async (route) => {
    if (route.request().url().endsWith('/github-token')) {
      await route.fulfill({ json: { accessToken: 'fixture-github-token' } })
      return
    }
    discoveries++
    await new Promise<void>((resolve) => releases.push(resolve))
    await route
      .fulfill({ status: 502, json: { error: 'disconnected fixture' } })
      .catch(() => {})
  })
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({
      json: {
        codespaces: [
          {
            name: 'fixture-space',
            state: 'Available',
            repository: { full_name: 'lvce-editor/codespaces' },
          },
        ],
      },
    }),
  )
  try {
    await page.goto('/codespaces/experimental/')
    await page.evaluate(() => (window as any).proofSignIn)
    await page
      .getByRole('button', { name: 'Load Codespaces', exact: true })
      .click()
    await expect(page.getByRole('status')).toHaveText('1 Codespaces available.')
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page
        .getByRole('button', { name: 'Connect / reconnect', exact: true })
        .click()
      await expect.poll(() => discoveries).toBe(attempt)
      await page
        .getByRole('button', { name: 'Disconnect / cancel', exact: true })
        .click()
      await expect(
        page.getByRole('button', { name: 'Connect / reconnect', exact: true }),
      ).toBeEnabled()
      await expect(page.getByRole('status')).toContainText(
        'GitHub compute continues',
      )
    }
    expect(errors).toEqual([])
  } finally {
    for (const release of releases) release()
  }
})
