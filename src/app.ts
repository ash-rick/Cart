import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config';
import { createPool, type Pool } from './db';
import { healthRoutes } from './routes/health';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: Pool;
  }
}

/**
 * Builds the app without listening. Each app owns its own pg Pool, closed with the app,
 * so tests can build an app per test with different config (for example a small n).
 */
export async function buildApp(configOverrides: Partial<Config> = {}): Promise<FastifyInstance> {
  const config = loadConfig(configOverrides);
  const app = Fastify({ logger: process.env.NODE_ENV === 'test' ? false : { level: 'info' } });

  const pool = createPool(config.databaseUrl);
  pool.on('error', (err) => app.log.error({ err }, 'idle pg client error'));
  app.decorate('config', config);
  app.decorate('db', pool);
  app.addHook('onClose', async () => {
    await pool.end();
  });

  await app.register(healthRoutes);
  return app;
}
