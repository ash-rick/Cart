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

export async function createCart(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/carts' });
  if (res.statusCode !== 201) throw new Error(`createCart failed: ${res.statusCode} ${res.body}`);
  return res.json().id;
}

export function putItem(app: FastifyInstance, cartId: string, productId: string, quantity: unknown) {
  return app.inject({
    method: 'PUT',
    url: `/carts/${cartId}/items/${productId}`,
    payload: { quantity },
  });
}

/** Creates a cart holding the given items and returns its id. */
export async function cartWith(
  app: FastifyInstance,
  items: Record<string, number>,
): Promise<string> {
  const cartId = await createCart(app);
  for (const [productId, quantity] of Object.entries(items)) {
    const res = await putItem(app, cartId, productId, quantity);
    if (res.statusCode !== 200) throw new Error(`putItem failed: ${res.statusCode} ${res.body}`);
  }
  return cartId;
}

export async function stockOf(productId: string): Promise<number> {
  const { rows } = await db().query<{ stock: number }>(`SELECT stock FROM products WHERE id = $1`, [
    productId,
  ]);
  return rows[0]!.stock;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
