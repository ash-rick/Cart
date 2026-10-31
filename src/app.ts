import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { loadConfig, type Config } from './config';
import { createPool, type Pool } from './db';
import { AppError, errorBody, errors } from './errors';
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

  registerErrorHandling(app);
  await app.register(healthRoutes);
  return app;
}

/**
 * Every error leaves as { error: { code, message, details? } }. Only AppError, zod issues
 * and Fastify's own client-error messages reach the client; anything else becomes a
 * generic 500 so stack traces, SQL and driver messages never leak.
 */
function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const err = errors.routeNotFound(request.method, request.url);
    void reply.status(err.httpStatus).send(errorBody(err));
  });

  app.setErrorHandler((err: unknown, request, reply) => {
    const appError = toAppError(err);
    if (appError) {
      return reply.status(appError.httpStatus).send(errorBody(appError));
    }
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  });
}

function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return errors.validation('Request validation failed', {
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  // Fastify's own 4xx errors: malformed JSON, empty JSON body, unsupported content type,
  // body too large. All are client input problems.
  const fe = err as Partial<FastifyError>;
  if (
    typeof fe.code === 'string' &&
    fe.code.startsWith('FST_') &&
    typeof fe.statusCode === 'number' &&
    fe.statusCode >= 400 &&
    fe.statusCode < 500
  ) {
    return errors.validation(fe.message ?? 'Invalid request');
  }
  return undefined;
}
