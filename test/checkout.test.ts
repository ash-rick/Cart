import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cartStatus,
  cartWith,
  checkout,
  closeDb,
  countRows,
  createCart,
  db,
  makeApp,
  putItem,
  resetDb,
  stockOf,
} from './helpers';

describe('checkout and orders', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    app = await makeApp();
  });
  afterEach(() => app.close());
  afterAll(closeDb);

  it('happy path: correct totals, stock decremented, cart CHECKED_OUT', async () => {
    const cartId = await cartWith(app, { sku_mug: 2, sku_sticker: 3 });

    const res = await checkout(app, cartId, { expectedTotalCents: 2598 + 597 });
    expect(res.statusCode).toBe(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    const order = res.json();
    expect(order).toMatchObject({
      cartId,
      status: 'PLACED',
      currency: 'USD',
      lines: [
        { productId: 'sku_mug', productName: 'Ceramic Mug', unitPriceCents: 1299, quantity: 2, lineTotalCents: 2598 },
        { productId: 'sku_sticker', productName: 'Sticker Pack', unitPriceCents: 199, quantity: 3, lineTotalCents: 597 },
      ],
      subtotalCents: 3195,
      discount: null,
      totalCents: 3195,
    });
    expect(await stockOf('sku_mug')).toBe(48);
    expect(await stockOf('sku_sticker')).toBe(997);
    expect(await cartStatus(cartId)).toBe('CHECKED_OUT');

    const fetched = await app.inject({ method: 'GET', url: `/orders/${order.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(order);
  });

  it('an order keeps its snapshot after the product price and name change (I7)', async () => {
    const cartId = await cartWith(app, { sku_hoodie: 1 });
    const order = (await checkout(app, cartId)).json();

    await db().query(
      `UPDATE products SET price_cents = 9999, name = 'Renamed Hoodie' WHERE id = 'sku_hoodie'`,
    );

    const res = await app.inject({ method: 'GET', url: `/orders/${order.id}` });
    expect(res.json().lines[0]).toMatchObject({
      productName: 'Zip Hoodie',
      unitPriceCents: 5999,
      lineTotalCents: 5999,
    });
    expect(res.json().totalCents).toBe(5999);
  });

  it('expectedTotalCents mismatch -> 409 PRICE_CHANGED, and nothing changes', async () => {
    const cartId = await cartWith(app, { sku_mug: 1 });
    // The client saw 1299, then the price went up before checkout.
    await db().query(`UPDATE products SET price_cents = 1399 WHERE id = 'sku_mug'`);

    const res = await checkout(app, cartId, { expectedTotalCents: 1299 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'PRICE_CHANGED',
      details: { expectedTotalCents: 1299, actualTotalCents: 1399 },
    });
    expect(await stockOf('sku_mug')).toBe(50);
    expect(await cartStatus(cartId)).toBe('OPEN');
    expect(await countRows('orders')).toBe(0);

    // Failures are not cached: retrying with the new total succeeds.
    const retry = await checkout(app, cartId, { expectedTotalCents: 1399 });
    expect(retry.statusCode).toBe(201);
  });

  it('empty cart -> 422 CART_EMPTY', async () => {
    const cartId = await createCart(app);
    const res = await checkout(app, cartId);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('CART_EMPTY');
    expect(await cartStatus(cartId)).toBe('OPEN');
  });

  it('quantities above stock -> 409 listing every shortfall, and nothing changes', async () => {
    const cartId = await cartWith(app, { sku_print: 3, sku_hoodie: 5, sku_mug: 1 });
    await db().query(`UPDATE products SET stock = 1 WHERE id = 'sku_print'`);
    await db().query(`UPDATE products SET stock = 2 WHERE id = 'sku_hoodie'`);

    const res = await checkout(app, cartId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'INSUFFICIENT_INVENTORY',
      details: {
        items: [
          { productId: 'sku_hoodie', requested: 5, available: 2 },
          { productId: 'sku_print', requested: 3, available: 1 },
        ],
      },
    });
    expect(await stockOf('sku_mug')).toBe(50);
    expect(await stockOf('sku_print')).toBe(1);
    expect(await cartStatus(cartId)).toBe('OPEN');
    expect(await countRows('orders')).toBe(0);
  });

  it('a sequential replay returns the same order with 200 and decrements stock once (I3)', async () => {
    const cartId = await cartWith(app, { sku_print: 2 });
    const first = await checkout(app, cartId);
    expect(first.statusCode).toBe(201);

    // Stock has since run out: the retry must still return the order, not a 409.
    await db().query(`UPDATE products SET stock = 0 WHERE id = 'sku_print'`);

    const replay = await checkout(app, cartId);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(await countRows('orders')).toBe(1);
    expect(await stockOf('sku_print')).toBe(0);
  });

  it('stock is decremented exactly once across a replay', async () => {
    const cartId = await cartWith(app, { sku_print: 2 });
    await checkout(app, cartId);
    await checkout(app, cartId);
    expect(await stockOf('sku_print')).toBe(1);
  });

  it('a replay with a different couponCode -> 409 CART_ALREADY_CHECKED_OUT', async () => {
    const cartId = await cartWith(app, { sku_mug: 1 });
    const order = (await checkout(app, cartId)).json();

    const res = await checkout(app, cartId, { couponCode: 'SAVE-ANYTHING' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'CART_ALREADY_CHECKED_OUT',
      details: { existingOrderId: order.id },
    });
  });

  it('editing a checked-out cart -> 409 CART_ALREADY_CHECKED_OUT', async () => {
    const cartId = await cartWith(app, { sku_mug: 1 });
    await checkout(app, cartId);

    const put = await putItem(app, cartId, 'sku_mug', 2);
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe('CART_ALREADY_CHECKED_OUT');

    const del = await app.inject({ method: 'DELETE', url: `/carts/${cartId}/items/sku_mug` });
    expect(del.statusCode).toBe(409);
  });

  it('validates the checkout body and ids', async () => {
    const cartId = await cartWith(app, { sku_mug: 1 });
    for (const body of [{ expectedTotalCents: 12.5 }, { expectedTotalCents: '1299' }, { coupon: 'X' }]) {
      const res = await checkout(app, cartId, body);
      expect(res.statusCode).toBe(400);
    }
    expect((await checkout(app, 'not-a-uuid')).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/orders/not-a-uuid' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/orders/00000000-0000-4000-8000-000000000000' })).json()
        .error.code,
    ).toBe('ORDER_NOT_FOUND');
  });

  it('checkout with no body at all works', async () => {
    const cartId = await cartWith(app, { sku_mug: 1 });
    const res = await app.inject({ method: 'POST', url: `/carts/${cartId}/checkout` });
    expect(res.statusCode).toBe(201);
  });
});
