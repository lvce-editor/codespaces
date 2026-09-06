import { test, expect } from '@playwright/test'

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
