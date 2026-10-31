import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cartWith, checkout, closeDb, countRows, db, makeApp, putItem, resetDb, stockOf } from './helpers';

// Every test does its setup sequentially, then fires the competing requests together
// with Promise.all. app.inject runs the handlers concurrently in this process, each on its
// own pooled connection, so the requests really do race inside Postgres.

function statuses(responses: LightMyRequestResponse[]): number[] {
  return responses.map((r) => r.statusCode).sort((a, b) => a - b);
}

async function soldQuantity(productId: string): Promise<number> {
  const { rows } = await db().query<{ n: number }>(
    `SELECT COALESCE(SUM(quantity), 0)::bigint AS n FROM order_lines WHERE product_id = $1`,
    [productId],
  );
  return rows[0]!.n;
}

describe('concurrent checkout', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    app = await makeApp();
  });
  afterEach(() => app.close());
  afterAll(closeDb);

  // I1 (no oversell). Catches: products read without FOR UPDATE, so several checkouts
  // see stock 3 and all succeed (or, with the CHECK constraint, some fail with a 500).
  it('20 carts race for 3 units of sku_print: exactly 3 orders, stock 0', async () => {
    const carts = [];
    for (let i = 0; i < 20; i++) carts.push(await cartWith(app, { sku_print: 1 }));

    const responses = await Promise.all(carts.map((id) => checkout(app, id)));

    const created = responses.filter((r) => r.statusCode === 201);
    const rejected = responses.filter((r) => r.statusCode === 409);
    expect(created).toHaveLength(3);
    expect(rejected).toHaveLength(17);
    expect(created.length + rejected.length).toBe(20); // nothing else, in particular no 500
    for (const r of rejected) {
      expect(r.json().error).toMatchObject({
        code: 'INSUFFICIENT_INVENTORY',
        details: { items: [{ productId: 'sku_print', requested: 1, available: 0 }] },
      });
    }
    expect(await stockOf('sku_print')).toBe(0);
    expect(await countRows('orders')).toBe(3);
    expect(await soldQuantity('sku_print')).toBe(3);
  });

  // I1 with multi-unit lines. Catches: a check of "stock > 0" instead of "stock >= qty",
  // or a decrement computed from a stale read.
  it('10 carts each wanting 2 of 3 units: exactly 1 order, stock 1', async () => {
    const carts = [];
    for (let i = 0; i < 10; i++) carts.push(await cartWith(app, { sku_print: 2 }));

    const responses = await Promise.all(carts.map((id) => checkout(app, id)));

    expect(statuses(responses)).toEqual([201, ...Array(9).fill(409)]);
    expect(await stockOf('sku_print')).toBe(1);
    expect(await countRows('orders')).toBe(1);
    expect(await soldQuantity('sku_print')).toBe(2);
  });

  // I2 + I3 (one order per cart, idempotent retry). Catches: a cart read without
  // FOR UPDATE, where two retries both see OPEN; the second then hits the
  // orders.cart_id UNIQUE constraint (a 500) or, without it, creates a second order.
  it('retry storm: 10 simultaneous checkouts of one cart produce one order', async () => {
    const cartId = await cartWith(app, { sku_print: 1 });

    const responses = await Promise.all(Array.from({ length: 10 }, () => checkout(app, cartId)));

    expect(statuses(responses)).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    const orderIds = new Set(responses.map((r) => r.json().id));
    expect(orderIds.size).toBe(1);
    for (const r of responses.filter((r) => r.statusCode === 200)) {
      expect(r.headers['idempotent-replayed']).toBe('true');
    }
    expect(await countRows('orders')).toBe(1);
    expect(await stockOf('sku_print')).toBe(2);
  });

  // I1 + liveness. Catches: product locks taken in cart order instead of id order, which
  // deadlocks when two carts hold the same products in opposite order (Postgres aborts
  // one transaction with 40P01, which would surface as a 500).
  it('30 carts with the same two products in opposite orders: no deadlock, exact stock', async () => {
    const carts = [];
    for (let i = 0; i < 15; i++) {
      carts.push(await cartWith(app, { sku_mug: 1, sku_cap: 1 }));
      carts.push(await cartWith(app, { sku_cap: 1, sku_mug: 1 }));
    }

    const responses = await Promise.all(carts.map((id) => checkout(app, id)));

    expect(statuses(responses)).toEqual(Array(30).fill(201));
    expect(await stockOf('sku_mug')).toBe(50 - 30);
    expect(await stockOf('sku_cap')).toBe(40 - 30);
    expect(await countRows('orders')).toBe(30);
  });

  // I3 / cart-order consistency. Catches: a cart edit that does not lock the cart row or
  // re-check status, so the edit lands after checkout read the items and the cart
  // silently disagrees with the order (or is edited after it was checked out).
  it('edit vs checkout race always has a consistent outcome (x10)', async () => {
    for (let round = 0; round < 10; round++) {
      const cartId = await cartWith(app, { sku_tee: 1 });

      const [put, co] = await Promise.all([putItem(app, cartId, 'sku_tee', 2), checkout(app, cartId)]);

      expect(co.statusCode).toBe(201);
      const orderedQty = co.json().lines[0].quantity;
      if (put.statusCode === 200) {
        expect(orderedQty).toBe(2);
      } else {
        expect(put.statusCode).toBe(409);
        expect(put.json().error.code).toBe('CART_ALREADY_CHECKED_OUT');
        expect(orderedQty).toBe(1);
      }
      const { rows } = await db().query<{ quantity: number }>(
        `SELECT quantity FROM cart_items WHERE cart_id = $1`,
        [cartId],
      );
      expect(rows[0]!.quantity).toBe(orderedQty);
    }
  });
});
