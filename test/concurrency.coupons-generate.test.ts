import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  countRows,
  db,
  generateCoupon,
  makeApp,
  placeOrders,
  raceBehindTableLock,
  resetDb,
} from './helpers';

// I5: at most one coupon per milestone, and never more coupons than milestones reached.
//
// raceBehindTableLock makes all calls start before any of them can insert, so they really
// overlap. (A plain Promise.all was not enough: the transaction is so short that the calls
// mostly ran one after another, and an earlier version of this test passed even with the
// concurrency control removed.)
//
// Catches: removing the advisory lock. Concurrent calls then compute the same milestone;
// UNIQUE(milestone) rejects the duplicates, and the losers surface as 500s.
describe('concurrent coupon generation (n = 3)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    app = await makeApp({ couponEveryNOrders: 3 });
  });
  afterEach(() => app.close());
  afterAll(closeDb);

  const tenAtOnce = () => Promise.all(Array.from({ length: 10 }, () => generateCoupon(app)));

  it('3 orders, 10 simultaneous calls -> exactly one coupon', async () => {
    await placeOrders(app, 3);

    const responses = await raceBehindTableLock('coupons', 10, tenAtOnce);

    const created = responses.filter((r) => r.statusCode === 201);
    const refused = responses.filter((r) => r.statusCode === 409);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(9);
    for (const r of refused) expect(r.json().error.code).toBe('NO_ELIGIBLE_MILESTONE');
    expect(created[0]!.json().milestone).toBe(1);
    expect(await countRows('coupons')).toBe(1);
  });

  it('6 orders, 10 simultaneous calls -> exactly milestones 1 and 2', async () => {
    await placeOrders(app, 6);

    const responses = await raceBehindTableLock('coupons', 10, tenAtOnce);

    const created = responses.filter((r) => r.statusCode === 201);
    const refused = responses.filter((r) => r.statusCode === 409);
    expect(created).toHaveLength(2);
    expect(refused).toHaveLength(8);
    expect(created.map((r) => r.json().milestone).sort()).toEqual([1, 2]);
    const { rows } = await db().query<{ milestone: number }>(
      `SELECT milestone FROM coupons ORDER BY milestone`,
    );
    expect(rows.map((r) => r.milestone)).toEqual([1, 2]);
  });

  // Reproduces a review finding: with a bounded retry instead of a lock, 12 calls racing
  // for 12 pending milestones ended as 3 x 201 and 9 x 500.
  it('12 orders with n = 1, 12 simultaneous calls -> milestones 1..12, no errors', async () => {
    await app.close();
    app = await makeApp({ couponEveryNOrders: 1 });
    await placeOrders(app, 12);

    const responses = await raceBehindTableLock('coupons', 12, () =>
      Promise.all(Array.from({ length: 12 }, () => generateCoupon(app))),
    );

    expect(responses.map((r) => r.statusCode)).toEqual(Array(12).fill(201));
    expect(responses.map((r) => r.json().milestone).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    expect(await countRows('coupons')).toBe(12);
  });
});
