import type { Config } from '../config';
import { withTransaction, type Pool } from '../db';

export interface Report {
  currency: 'USD';
  totalOrders: number;
  grossRevenueCents: number;
  totalDiscountCents: number;
  netRevenueCents: number;
  productsSold: { productId: string; name: string; quantity: number; grossCents: number }[];
  coupons: { generated: number; available: number; redeemed: number };
  milestones: {
    n: number;
    percent: number;
    ordersUntilNextMilestone: number;
    eligibleUngeneratedMilestones: number;
  };
}

/**
 * Computed on demand from orders, order_lines and coupons; nothing is stored.
 *
 * REPEATABLE READ: every query below sees the same snapshot. Under READ COMMITTED, an
 * order committing between the orders query and the order_lines query would make
 * productsSold disagree with grossRevenueCents, or count a coupon as redeemed whose order
 * is not in totalOrders yet. READ ONLY: Postgres itself rejects any write here (I8).
 */
export async function getReport(pool: Pool, config: Config): Promise<Report> {
  return withTransaction(
    pool,
    async (client) => {
      const totals = await client.query<{
        totalOrders: number;
        grossRevenueCents: number;
        totalDiscountCents: number;
        netRevenueCents: number;
      }>(
        `SELECT COUNT(*)::bigint                          AS "totalOrders",
                COALESCE(SUM(subtotal_cents), 0)::bigint  AS "grossRevenueCents",
                COALESCE(SUM(discount_cents), 0)::bigint  AS "totalDiscountCents",
                COALESCE(SUM(total_cents), 0)::bigint     AS "netRevenueCents"
           FROM orders`,
      );

      // The name comes from the most recent order's snapshot, never from products.
      const products = await client.query<Report['productsSold'][number]>(
        `SELECT ol.product_id                                              AS "productId",
                (array_agg(ol.product_name ORDER BY o.created_at DESC))[1] AS name,
                SUM(ol.quantity)::bigint                                   AS quantity,
                SUM(ol.line_total_cents)::bigint                           AS "grossCents"
           FROM order_lines ol
           JOIN orders o ON o.id = ol.order_id
          GROUP BY ol.product_id
          ORDER BY ol.product_id`,
      );

      const coupons = await client.query<{
        generated: number;
        available: number;
        redeemed: number;
        maxMilestone: number;
      }>(
        `SELECT COUNT(*)::bigint                                         AS generated,
                COUNT(*) FILTER (WHERE status = 'AVAILABLE')::bigint     AS available,
                COUNT(*) FILTER (WHERE status = 'REDEEMED')::bigint      AS redeemed,
                COALESCE(MAX(milestone), 0)                              AS "maxMilestone"
           FROM coupons`,
      );

      const t = totals.rows[0]!;
      const { maxMilestone, ...couponCounts } = coupons.rows[0]!;
      const n = config.couponEveryNOrders;
      const reached = Math.floor(t.totalOrders / n);

      return {
        currency: 'USD',
        ...t,
        productsSold: products.rows,
        coupons: couponCounts,
        milestones: {
          n,
          percent: config.couponPercent,
          // Orders still needed to reach the next milestone that has not been reached yet.
          ordersUntilNextMilestone: (reached + 1) * n - t.totalOrders,
          eligibleUngeneratedMilestones: Math.max(reached - maxMilestone, 0),
        },
      };
    },
    { isolationLevel: 'REPEATABLE READ', readOnly: true },
  );
}
