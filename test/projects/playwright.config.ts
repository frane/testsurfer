import { defineConfig, devices } from '@playwright/test';

// Projects: a setup project that logs in, a desktop project and a
// mobile one that depend on it and start from its storage state.
export default defineConfig({
  testDir: './tests',
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    { name: 'desktop', dependencies: ['setup'], use: { storageState: 'state.json' } },
    { name: 'mobile', dependencies: ['setup'], use: { ...devices['iPhone 13'], storageState: 'state.json' } },
  ],
});
