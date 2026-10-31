import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    await app.db.query('SELECT 1');
    return { status: 'ok' };
  });
}
