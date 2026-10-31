import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cartWith, checkout, closeDb, db, generateCoupon, makeApp, placeOrders, resetDb } from './helpers';

interface OrderBody {
  subtotalCents: number;
  totalCents: number;
  discount: null | { amountCents: number };
  lines: { productId: string; productName: string; quantity: number; lineTotalCents: number }[];
}

describe('GET /admin/report (n = 3, x = 10)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    app = await makeApp({ couponEveryNOrders: 3, couponPercent: 10 });
  });
  afterEach(() => app.close());
  afterAll(closeDb);

  const report = async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/report' });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it('empty store: everything is zero or empty', async () => {
    expect(await report()).toEqual({
      currency: 'USD',
      totalOrders: 0,
      grossRevenueCents: 0,
      totalDiscountCents: 0,
      netRevenueCents: 0,
      productsSold: [],
      coupons: { generated: 0, available: 0, redeemed: 0 },
      milestones: { n: 3, percent: 10, ordersUntilNextMilestone: 3, eligibleUngeneratedMilestones: 0 },
    });
  });

  it('reconciles with the orders and coupons the API returned', async () => {
    const orderIds: string[] = [];
    const place = async (items: Record<string, number>, couponCode?: string) => {
      const res = await checkout(app, await cartWith(app, items), couponCode ? { couponCode } : {});
      expect(res.statusCode).toBe(201);
      orderIds.push(res.json().id);
    };

    orderIds.push(...(await placeOrders(app, 3))); // 3 x sku_sticker
    const couponA = (await generateCoupon(app)).json().code; // milestone 1
    await place({ sku_mug: 2, sku_sticker: 1 }, couponA);
    await place({ sku_hoodie: 1 });
    await place({ sku_print: 1 }); // 6 orders
    const couponB = (await generateCoupon(app)).json().code; // milestone 2
    await place({ sku_cap: 3 }, couponB);

    // A failed checkout must contribute nothing: stock drops after the items were added.
    const failCart = await cartWith(app, { sku_print: 2, sku_tee: 1 });
    await db().query(`UPDATE products SET stock = 1 WHERE id = 'sku_print'`);
    expect((await checkout(app, failCart)).statusCode).toBe(409);

    await place({ sku_tee: 1 }); // 8 orders
    await place({ sku_tee: 2 }); // 9 orders: milestone 3 reached, not generated

    // Recompute independently from GET /orders/:id.
    const orders: OrderBody[] = [];
    for (const id of orderIds) {
      orders.push((await app.inject({ method: 'GET', url: `/orders/${id}` })).json());
    }
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const gross = sum(orders.map((o) => o.subtotalCents));
    const discounts = sum(orders.map((o) => o.discount?.amountCents ?? 0));
    const net = sum(orders.map((o) => o.totalCents));
    const byProduct = new Map<string, { quantity: number; grossCents: number; name: string }>();
    for (const line of orders.flatMap((o) => o.lines)) {
      const p = byProduct.get(line.productId) ?? { quantity: 0, grossCents: 0, name: line.productName };
      p.quantity += line.quantity;
      p.grossCents += line.lineTotalCents;
      byProduct.set(line.productId, p);
    }

    const r = await report();
    expect(r.totalOrders).toBe(9);
    expect(r.totalOrders).toBe(orders.length);
    expect(r.grossRevenueCents).toBe(gross);
    expect(r.totalDiscountCents).toBe(discounts);
    expect(r.netRevenueCents).toBe(net);
    expect(r.grossRevenueCents - r.totalDiscountCents).toBe(r.netRevenueCents);
    expect(r.productsSold).toEqual(
      [...byProduct.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([productId, p]) => ({ productId, ...p })),
    );
    // The failed cart's sku_print x2 is absent: only the one successful print order counts.
    expect(r.productsSold.find((p: { productId: string }) => p.productId === 'sku_print').quantity).toBe(1);
    expect(r.coupons).toEqual({ generated: 2, available: 0, redeemed: 2 });
    expect(r.coupons.redeemed).toBe(orders.filter((o) => o.discount !== null).length);
    expect(r.milestones).toEqual({
      n: 3,
      percent: 10,
      ordersUntilNextMilestone: 3,
      eligibleUngeneratedMilestones: 1,
    });

    // Snapshot names: renaming a product does not change the report.
    await db().query(`UPDATE products SET name = 'Renamed', price_cents = 1 WHERE id = 'sku_mug'`);
    expect(await report()).toEqual(r);
  });

  it('is read-only: repeated calls return identical bodies and change nothing', async () => {
    await placeOrders(app, 3);
    await generateCoupon(app);

    const state = async () =>
      (
        await db().query(
          `SELECT (SELECT COUNT(*) FROM orders) AS orders,
                  (SELECT COUNT(*) FROM order_lines) AS lines,
                  (SELECT COUNT(*) FROM coupons) AS coupons,
                  (SELECT COUNT(*) FROM carts) AS carts,
                  (SELECT json_agg(json_build_array(id, stock, status) ORDER BY id)
                     FROM (SELECT p.id, p.stock, NULL AS status FROM products p
                           UNION ALL SELECT c.code, NULL, c.status FROM coupons c) s) AS rows`,
        )
      ).rows[0];

    const before = await state();
    const first = await report();
    const second = await report();
    expect(second).toEqual(first);
    expect(await state()).toEqual(before);
  });
});
