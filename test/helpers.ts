import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import type { Config } from '../src/config';
import { createPool, type Pool } from '../src/db';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL!;

let pool: Pool | undefined;

/** A pool for direct assertions and fixture tweaks, separate from the app's pool. */
export function db(): Pool {
  pool ??= createPool(testDatabaseUrl);
  return pool;
}

/** Truncates every table except schema_migrations, then reseeds. Call in beforeEach. */
export async function resetDb(): Promise<void> {
  const { rows } = await db().query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length > 0) {
    const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
    await db().query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  }
  const seedSql = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'seed.sql'), 'utf8');
  await db().query(seedSql);
}

/** Builds an app against the test DB. Close it with app.close() (see useApp). */
export async function makeApp(overrides: Partial<Config> = {}): Promise<FastifyInstance> {
  return buildApp({ databaseUrl: testDatabaseUrl, ...overrides });
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
