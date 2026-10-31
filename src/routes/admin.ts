import type { FastifyInstance } from 'fastify';
import { generateCoupon, listCoupons } from '../services/couponService';
import { getReport } from '../services/reportService';

// Administrative operations. Auth is out of scope; the /admin prefix marks them as privileged.
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post('/admin/coupons', async (_req, reply) => {
    return reply.status(201).send(await generateCoupon(app.db, app.config));
  });

  app.get('/admin/coupons', async () => listCoupons(app.db));

  app.get('/admin/report', async () => getReport(app.db, app.config));
}
