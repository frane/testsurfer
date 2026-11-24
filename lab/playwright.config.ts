import { defineConfig, devices } from '@playwright/test';

// The same config drives the lab on Playwright and on testsurfer
// (`testsurfer test` reads it). 127.0.0.1 and localhost are the two
// origins the cross-origin cases need.
const port = Number(process.env.LAB_PORT ?? 4173);

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  reporter: [['json', { outputFile: 'results/playwright.json' }], ['list']],
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: { command: 'node server.mjs', url: `http://127.0.0.1:${port}/index.html`, reuseExistingServer: true },
  projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }],
});
