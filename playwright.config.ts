import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: 'packages/e2e',
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${process.env.LVCE_CODESPACES_TEST_PORT || 4173}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node packages/build/src/serve-static.ts',
    url: `http://127.0.0.1:${process.env.LVCE_CODESPACES_TEST_PORT || 4173}/codespaces/`,
    reuseExistingServer: !process.env.CI,
  },
})
