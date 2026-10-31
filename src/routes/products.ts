import type { FastifyInstance } from 'fastify';
import { listProducts } from '../services/cartService';

export async function productRoutes(app: FastifyInstance): Promise<void> {
  app.get('/products', async () => listProducts(app.db));
}
