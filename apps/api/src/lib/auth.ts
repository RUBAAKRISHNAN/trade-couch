import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { config, withTx, type Pool } from '@tradecore/shared/node';
import { AppError } from '../errors';

export interface AccessClaims {
  sub: string;
  role: 'USER' | 'ADMIN' | 'BOT';
  name: string;
}

export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 7 * 24 * 3600;
export const REFRESH_COOKIE = 'tc_rt';

const key = () => new TextEncoder().encode(config.jwtSecret);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function hashPassword(pw: string) {
  return bcrypt.hash(pw, 10);
}
export function verifyPassword(pw: string, hash: string) {
  return bcrypt.compare(pw, hash);
}

/** Short-lived access token (15 min), sent as `Authorization: Bearer …`. */
export async function signAccess(c: AccessClaims): Promise<string> {
  return new SignJWT({ role: c.role, name: c.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.sub)
    .setIssuedAt()
    .setIssuer('tradecore')
    .setExpirationTime(`${ACCESS_TTL_S}s`)
    .sign(key());
}

export async function verifyAccess(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, key(), { issuer: 'tradecore', algorithms: ['HS256'] });
    return { sub: payload.sub!, role: payload.role as AccessClaims['role'], name: payload.name as string };
  } catch {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  }
}

/**
 * Refresh tokens are random strings; only their SHA-256 hash is stored. Each login starts a token
 * "family". Every refresh ROTATES the token (old one revoked, new one issued in the same family).
 * If a token that was already rotated is presented again, someone replayed it (possible theft):
 * the whole family is revoked and the user must log in again.
 */
export async function issueRefresh(
  pool: Pool,
  userId: string,
  familyId: string = randomUUID(),
): Promise<{ token: string; id: string }> {
  const token = randomBytes(32).toString('base64url');
  const r = await pool.query<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING id`,
    [userId, familyId, sha256(token), REFRESH_TTL_S],
  );
  return { token, id: r.rows[0]!.id };
}

export async function rotateRefresh(pool: Pool, token: string): Promise<{ userId: string; token: string }> {
  const out = await withTx(pool, async (c) => {
    const r = await c.query<{
      id: string;
      user_id: string;
      family_id: string;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      'SELECT id, user_id, family_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
      [sha256(token)],
    );
    const row = r.rows[0];
    if (!row) throw new AppError(401, 'UNAUTHORIZED', 'Unknown refresh token');
    if (row.revoked_at) {
      // REUSE DETECTED: revoke every token in this family. Return (don't throw) so the revocation COMMITS.
      await c.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
        [row.family_id],
      );
      return { reuse: true as const };
    }
    if (row.expires_at.getTime() < Date.now())
      throw new AppError(401, 'UNAUTHORIZED', 'Refresh token expired');
    const next = randomBytes(32).toString('base64url');
    const ins = await c.query<{ id: string }>(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING id`,
      [row.user_id, row.family_id, sha256(next), REFRESH_TTL_S],
    );
    await c.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [
      row.id,
      ins.rows[0]!.id,
    ]);
    return { reuse: false as const, userId: row.user_id, token: next };
  });
  if (out.reuse) throw new AppError(401, 'TOKEN_REUSE', 'Refresh token reuse detected; please log in again');
  return { userId: out.userId, token: out.token };
}

export async function revokeRefresh(pool: Pool, token: string) {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
    [sha256(token)],
  );
}
