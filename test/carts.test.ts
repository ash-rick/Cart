import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, createCart, db, makeApp, putItem, resetDb } from './helpers';

describe('products and carts', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    app = await makeApp();
  });
  afterEach(() => app.close());
  afterAll(closeDb);

  it('lists the seeded products', async () => {
    const res = await app.inject({ method: 'GET', url: '/products' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toContainEqual({
      id: 'sku_mug',
      name: 'Ceramic Mug',
      priceCents: 1299,
      stock: 50,
    });
    expect(res.json()).toHaveLength(6);
  });

  it('creates an empty cart', async () => {
    const res = await app.inject({ method: 'POST', url: '/carts' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'OPEN',
      currency: 'USD',
      items: [],
      itemCount: 0,
      subtotalCents: 0,
      warnings: [],
    });
  });

  it('adds, updates and removes items with correct totals at each step', async () => {
    const cartId = await createCart(app);

    let res = await putItem(app, cartId, 'sku_mug', 2);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ itemCount: 2, subtotalCents: 2598 });

    res = await putItem(app, cartId, 'sku_sticker', 3);
    expect(res.json()).toMatchObject({ itemCount: 5, subtotalCents: 2598 + 597 });

    res = await putItem(app, cartId, 'sku_mug', 1);
    expect(res.json()).toMatchObject({ itemCount: 4, subtotalCents: 1299 + 597 });
    expect(res.json().items).toEqual([
      {
        productId: 'sku_mug',
        name: 'Ceramic Mug',
        unitPriceCents: 1299,
        quantity: 1,
        lineTotalCents: 1299,
        availableStock: 50,
        inStock: true,
      },
      expect.objectContaining({ productId: 'sku_sticker', quantity: 3, lineTotalCents: 597 }),
    ]);

    res = await app.inject({ method: 'DELETE', url: `/carts/${cartId}/items/sku_mug` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ itemCount: 3, subtotalCents: 597 });

    // DELETE is idempotent.
    res = await app.inject({ method: 'DELETE', url: `/carts/${cartId}/items/sku_mug` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ itemCount: 3, subtotalCents: 597 });

    res = await app.inject({ method: 'GET', url: `/carts/${cartId}` });
    expect(res.json()).toMatchObject({ itemCount: 3, subtotalCents: 597 });
  });

  it.each([0, -1, 1.5, '2', 101, undefined, null])('rejects quantity %s with 400', async (quantity) => {
    const cartId = await createCart(app);
    const res = await putItem(app, cartId, 'sku_mug', quantity);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    const cart = await app.inject({ method: 'GET', url: `/carts/${cartId}` });
    expect(cart.json().items).toEqual([]);
  });

  it('rejects a missing body with 400', async () => {
    const cartId = await createCart(app);
    const res = await app.inject({ method: 'PUT', url: `/carts/${cartId}/items/sku_mug` });
    expect(res.statusCode).toBe(400);
  });

  it('unknown product -> 422, unknown cart -> 404, malformed cart id -> 404', async () => {
    const cartId = await createCart(app);

    let res = await putItem(app, cartId, 'sku_nope', 1);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PRODUCT_NOT_FOUND');

    res = await putItem(app, '00000000-0000-4000-8000-000000000000', 'sku_mug', 1);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CART_NOT_FOUND');

    for (const url of ['/carts/not-a-uuid', '/carts/00000000-0000-4000-8000-000000000000']) {
      res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('CART_NOT_FOUND');
    }
    res = await putItem(app, 'not-a-uuid', 'sku_mug', 1);
    expect(res.statusCode).toBe(404);
  });

  it('PUT is idempotent: the same PUT twice leaves the quantity unchanged', async () => {
    const cartId = await createCart(app);
    await putItem(app, cartId, 'sku_cap', 3);
    const res = await putItem(app, cartId, 'sku_cap', 3);
    expect(res.json().items).toEqual([expect.objectContaining({ productId: 'sku_cap', quantity: 3 })]);
  });

  it('rejects a quantity above current stock with 409 (advisory check)', async () => {
    const cartId = await createCart(app);
    const res = await putItem(app, cartId, 'sku_print', 4);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'INSUFFICIENT_INVENTORY',
      details: { items: [{ productId: 'sku_print', requested: 4, available: 3 }] },
    });
  });

  it('shows live prices: a price change after adding is reflected in the view', async () => {
    const cartId = await createCart(app);
    await putItem(app, cartId, 'sku_mug', 2);
    await db().query(`UPDATE products SET price_cents = 1500 WHERE id = 'sku_mug'`);

    const res = await app.inject({ method: 'GET', url: `/carts/${cartId}` });
    expect(res.json().items[0]).toMatchObject({ unitPriceCents: 1500, lineTotalCents: 3000 });
    expect(res.json().subtotalCents).toBe(3000);
  });

  it('warns when stock drops below the quantity in the cart', async () => {
    const cartId = await createCart(app);
    await putItem(app, cartId, 'sku_print', 3);
    await db().query(`UPDATE products SET stock = 1 WHERE id = 'sku_print'`);

    const res = await app.inject({ method: 'GET', url: `/carts/${cartId}` });
    expect(res.json().items[0]).toMatchObject({ availableStock: 1, inStock: false });
    expect(res.json().warnings).toEqual([
      { code: 'INSUFFICIENT_INVENTORY', productId: 'sku_print', requested: 3, available: 1 },
    ]);
  });
});
