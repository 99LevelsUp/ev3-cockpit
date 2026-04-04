import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    testMatch: '**/*.spec.ts',
    timeout: 30_000,
    retries: 0,
    reporter: 'list',
});
