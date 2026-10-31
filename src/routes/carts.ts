import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createCart, getCart, removeItem, setItemQuantity } from '../services/cartService';

const cartParams = z.object({ cartId: z.string() });
// Product ids are short slugs (sku_mug). Anything else cannot name a product, and odd
// bytes (NUL is invalid in Postgres text) must not reach SQL.
const productIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'productId must be 1-64 letters, digits, _ or -');
const itemParams = z.object({ cartId: z.string(), productId: productIdSchema });
const setQuantityBody = z.object({ quantity: z.number().int().min(1).max(100) });

export async function cartRoutes(app: FastifyInstance): Promise<void> {
  app.post('/carts', async (_req, reply) => {
    return reply.status(201).send(await createCart(app.db));
  });

  app.get('/carts/:cartId', async (req) => {
    const { cartId } = cartParams.parse(req.params);
    return getCart(app.db, cartId);
  });

  app.put('/carts/:cartId/items/:productId', async (req) => {
    const { cartId, productId } = itemParams.parse(req.params);
    const { quantity } = setQuantityBody.parse(req.body);
    return setItemQuantity(app.db, cartId, productId, quantity);
  });

  app.delete('/carts/:cartId/items/:productId', async (req) => {
    const { cartId, productId } = itemParams.parse(req.params);
    return removeItem(app.db, cartId, productId);
  });
}
