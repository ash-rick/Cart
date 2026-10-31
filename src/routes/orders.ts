import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkout, getOrder } from '../services/checkoutService';

const cartParams = z.object({ cartId: z.string() });
const orderParams = z.object({ orderId: z.string() });

// strict(): an unknown key (say, a misspelt "coupon") is rejected instead of silently
// checking out without the discount the client thinks it asked for.
const checkoutBody = z
  .object({
    couponCode: z.string().max(64).optional(),
    expectedTotalCents: z.number().int().min(0).optional(),
  })
  .strict();

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.post('/carts/:cartId/checkout', async (req, reply) => {
    const { cartId } = cartParams.parse(req.params);
    const body = checkoutBody.parse(req.body ?? {});
    const { order, replayed } = await checkout(app.db, { cartId, ...body });
    if (replayed) {
      return reply.status(200).header('Idempotent-Replayed', 'true').send(order);
    }
    return reply.status(201).send(order);
  });

  app.get('/orders/:orderId', async (req) => {
    const { orderId } = orderParams.parse(req.params);
    return getOrder(app.db, orderId);
  });
}
