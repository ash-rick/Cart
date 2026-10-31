import 'dotenv/config';
import { reset } from '../scripts/dbtools';

/** Once per run: rebuild the test schema from migrations so it never drifts. */
export default async function globalSetup(): Promise<void> {
  const url =
    process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/checkout_test';
  await reset(url);
}
