import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, generateCoupon, makeApp, placeOrders, resetDb } from './helpers';

describe('admin coupon generation (n = 3, x = 15)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    app = await makeApp({ couponEveryNOrders: 3, couponPercent: 15 });
  });
  afterEach(() => app.close());
  afterAll(closeDb);

  it('0 orders -> 409 NO_ELIGIBLE_MILESTONE with progress details', async () => {
    const res = await generateCoupon(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'NO_ELIGIBLE_MILESTONE',
      details: { n: 3, ordersPlaced: 0, nextMilestone: 1, ordersUntilNextMilestone: 3 },
    });
  });

  it('2 orders -> 409; 3 orders -> 201 milestone 1; again -> 409', async () => {
    await placeOrders(app, 2);
    let res = await generateCoupon(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({ ordersPlaced: 2, ordersUntilNextMilestone: 1 });

    await placeOrders(app, 1);
    res = await generateCoupon(app);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      code: expect.stringMatching(/^SAVE-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/),
      milestone: 1,
      percent: 15,
      status: 'AVAILABLE',
      createdAt: expect.any(String),
    });

    res = await generateCoupon(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({
      ordersPlaced: 3,
      nextMilestone: 2,
      ordersUntilNextMilestone: 3,
    });
  });

  it('6 orders and no coupons -> milestones 1 then 2, then 409', async () => {
    await placeOrders(app, 6);
    expect((await generateCoupon(app)).json().milestone).toBe(1);
    expect((await generateCoupon(app)).json().milestone).toBe(2);
    expect((await generateCoupon(app)).statusCode).toBe(409);

    const list = await app.inject({ method: 'GET', url: '/admin/coupons' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([
      expect.objectContaining({ milestone: 1, status: 'AVAILABLE', redeemedAt: null }),
      expect.objectContaining({ milestone: 2, status: 'AVAILABLE', redeemedAt: null }),
    ]);
  });

  it('snapshots the percent at generation time', async () => {
    await placeOrders(app, 3);
    await generateCoupon(app);
    await app.close();
    app = await makeApp({ couponEveryNOrders: 3, couponPercent: 50 });

    const list = await app.inject({ method: 'GET', url: '/admin/coupons' });
    expect(list.json()[0].percent).toBe(15);
  });
});
