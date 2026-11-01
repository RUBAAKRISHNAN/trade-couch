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
    return (process.env.MARKET_FEEDS ?? 'coinbase,binance,kraken,simulated').split(',').map((s) => s.trim());
  },
  get aiProvider() {
    return process.env.AI_PROVIDER ?? (process.env.GEMINI_API_KEY ? 'gemini' : '');
  },
  /** Gemini API key from Google AI Studio. Server-side only; never sent to the browser or logged. */
  get geminiApiKey() {
    return process.env.GEMINI_API_KEY ?? '';
  },
  /** Models to try in order (the first that answers wins). GEMINI_MODEL goes first if set. */
  get geminiModels() {
    const list = [
      process.env.GEMINI_MODEL,
      ...(
        process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.5-flash,gemini-3.6-flash,gemini-3.1-flash-lite'
      ).split(','),
    ]
      .map((m) => m?.trim())
      .filter((m): m is string => !!m);
    return [...new Set(list)];
  },
};
