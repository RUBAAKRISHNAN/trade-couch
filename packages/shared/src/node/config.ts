import { DEFAULT_USD_INR } from '../instruments';

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}

/** Postgres connection settings from PG_* env vars. The password is never logged. */
export function pgConfig(database = process.env.DB_NAME ?? 'tradecore') {
  return {
    user: req('PG_USER'),
    password: req('PG_PASSWORD'),
    host: process.env.PG_HOST ?? 'localhost',
    port: Number(process.env.PG_PORT ?? 5432),
    database,
  };
}

export const config = {
  get redisUrl() {
    return process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  },
  get apiPort() {
    return Number(process.env.API_PORT ?? 4300);
  },
  get webOrigin() {
    return (process.env.WEB_ORIGIN ?? 'http://localhost:5200').split(',');
  },
  get jwtSecret() {
    const s = process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me-0123456789';
    if (process.env.NODE_ENV === 'production' && s.startsWith('dev-only'))
      throw new Error('Set JWT_SECRET in production');
    return s;
  },
  get usdInr() {
    return Number(process.env.USD_INR ?? DEFAULT_USD_INR);
  },
  get marketFeeds() {
    return (process.env.MARKET_FEEDS ?? 'coinbase,kraken,simulated').split(',').map((s) => s.trim());
  },
  get aiProvider() {
    return process.env.AI_PROVIDER ?? '';
  },
};
