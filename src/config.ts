import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default('postgres://postgres:postgres@localhost:5433/checkout'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  COUPON_EVERY_N_ORDERS: z.coerce.number().int().min(1).default(5),
  COUPON_PERCENT: z.coerce.number().int().min(1).max(100).default(10),
});

export const configSchema = z.object({
  databaseUrl: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  couponEveryNOrders: z.number().int().min(1),
  couponPercent: z.number().int().min(1).max(100),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

/**
 * Reads config from the environment, applies overrides, and validates the result.
 * Overrides are validated too, so a test cannot build an app with n = 0.
 */
export function loadConfig(
  overrides: Partial<Config> = {},
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const parsedEnv = envSchema.safeParse(env);
  if (!parsedEnv.success) {
    throw new ConfigError(`Invalid environment configuration:\n${formatIssues(parsedEnv.error)}`);
  }
  const e = parsedEnv.data;
  const parsed = configSchema.safeParse({
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    couponEveryNOrders: e.COUPON_EVERY_N_ORDERS,
    couponPercent: e.COUPON_PERCENT,
    ...overrides,
  });
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration:\n${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}
