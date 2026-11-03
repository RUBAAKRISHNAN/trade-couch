import { PrismaClient } from '@prisma/client';
import { pgConfig } from '@tradecore/shared/node';

/** Prisma reads its URL from PG_* env vars (password URL-encoded); used only for simple CRUD. */
export function createPrisma(database?: string): PrismaClient {
  const c = pgConfig(database);
  const url = c.connectionString
    ? `${c.connectionString}${c.connectionString.includes('?') ? '&' : '?'}connection_limit=5`
    : `postgresql://${encodeURIComponent(c.user!)}:${encodeURIComponent(String(c.password))}@${c.host}:${c.port}/${c.database}?connection_limit=5`;
  return new PrismaClient({ datasourceUrl: url });
}
