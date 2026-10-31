import 'dotenv/config';
import { defineConfig } from 'vitest/config';

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/checkout_test';

export default defineConfig({
  test: {
    // All test files share one database, so they must not run at the same time.
    fileParallelism: false,
    globalSetup: ['./test/globalSetup.ts'],
    env: { TEST_DATABASE_URL: testDatabaseUrl, NODE_ENV: 'test' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
