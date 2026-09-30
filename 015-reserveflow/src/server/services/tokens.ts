import type { Queryable } from '../db/pool.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';

const DAY = 86_400_000;

/** Issue a manage-link token. Only the SHA-256 hash is stored. */
export async function issueManageToken(q: Queryable, businessId: string, bookingId: string, bookingEnd: Date): Promise<string> {
  const token = randomToken(32);
  const expires = new Date(Math.max(bookingEnd.getTime(), Date.now()) + 30 * DAY);
  await q.query(`INSERT INTO manage_tokens (business_id, booking_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)`, [
    businessId,
    bookingId,
    sha256Hex(token),
    expires,
  ]);
  return token;
}

export async function revokeManageTokens(q: Queryable, bookingId: string): Promise<number> {
  const r = await q.query(`UPDATE manage_tokens SET revoked_at = now() WHERE booking_id = $1 AND revoked_at IS NULL`, [bookingId]);
  return r.rowCount ?? 0;
}

export async function revokeTokenByPlain(q: Queryable, token: string): Promise<void> {
  await q.query(`UPDATE manage_tokens SET revoked_at = now() WHERE token_hash = $1`, [sha256Hex(token)]);
}

/** Resolve a manage token to its booking id (valid, unrevoked, unexpired). */
export async function resolveManageToken(q: Queryable, token: string): Promise<{ bookingId: string; businessId: string } | null> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
  const r = await q.query(
    `UPDATE manage_tokens SET last_used_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING booking_id, business_id`,
    [sha256Hex(token)],
  );
  if (!r.rows[0]) return null;
  return { bookingId: r.rows[0].booking_id, businessId: r.rows[0].business_id };
}

export function manageUrl(baseUrl: string, token: string): string {
  // token is carried in the URL fragment so it never reaches server access logs or Referer headers
  return `${baseUrl}/manage#t=${token}`;
}
