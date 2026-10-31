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

export function checkout(app: FastifyInstance, cartId: string, body: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: `/carts/${cartId}/checkout`, payload: body });
}

/** Places k orders through the API, one sku_sticker each. Returns the order ids. */
export async function placeOrders(app: FastifyInstance, k: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < k; i++) {
    const res = await checkout(app, await cartWith(app, { sku_sticker: 1 }));
    if (res.statusCode !== 201) throw new Error(`placeOrders failed: ${res.statusCode} ${res.body}`);
    ids.push(res.json().id);
  }
  return ids;
}

export function generateCoupon(app: FastifyInstance) {
  return app.inject({ method: 'POST', url: '/admin/coupons' });
}

/** Places enough orders to reach the next milestone, then generates its coupon code. */
export async function issueCoupon(app: FastifyInstance): Promise<string> {
  const ordersPlaced = await countRows('orders');
  const n = app.config.couponEveryNOrders;
  const nextMilestone = (await countRows('coupons')) + 1;
  await placeOrders(app, Math.max(nextMilestone * n - ordersPlaced, 0));
  const res = await generateCoupon(app);
  if (res.statusCode !== 201) throw new Error(`issueCoupon failed: ${res.statusCode} ${res.body}`);
  return res.json().code;
}

export async function couponStatus(code: string): Promise<string> {
  const { rows } = await db().query<{ status: string }>(`SELECT status FROM coupons WHERE code = $1`, [
    code,
  ]);
  return rows[0]!.status;
}

/**
 * Forces a race. Holds SHARE ROW EXCLUSIVE on `table` (reads pass, INSERT/UPDATE block),
 * starts `fire()`, waits until `waiters` statements are queued on a lock, then
 * releases it. Every request has done its reads by then, so all of them act on the same
 * stale snapshot at once, instead of finishing one by one because the transactions are short.
 */
export async function raceBehindTableLock<T>(
  table: 'coupons' | 'orders',
  waiters: number,
  fire: () => Promise<T>,
): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
    const pending = fire();
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await client.query<{ n: number }>(
        // Any waiter counts: on this table, or on a lock the app takes before writing it
        // (coupon generation queues on an advisory lock first).
        `SELECT COUNT(*) AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
          WHERE NOT l.granted AND d.datname = current_database()`,
      );
      if (rows[0]!.n >= waiters) break;
      if (Date.now() > deadline) throw new Error(`only ${rows[0]!.n}/${waiters} requests blocked`);
      await new Promise((r) => setTimeout(r, 20));
    }
    await client.query('COMMIT');
    return await pending;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function countRows(table: 'orders' | 'order_lines' | 'coupons'): Promise<number> {
  const { rows } = await db().query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return rows[0]!.n;
}

export async function cartStatus(cartId: string): Promise<string> {
  const { rows } = await db().query<{ status: string }>(`SELECT status FROM carts WHERE id = $1`, [
    cartId,
  ]);
  return rows[0]!.status;
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
