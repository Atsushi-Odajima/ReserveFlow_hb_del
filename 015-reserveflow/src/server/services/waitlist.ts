import type { Queryable } from '../db/pool.js';
import { localDateOf, minutesOfDay } from '../engine/time.js';

export interface WaitlistMatch {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  party_size: number;
}

/**
 * Waitlist entries that could fit a freed slot. Used to SHOW candidates to the business only —
 * nothing is ever booked automatically and a waitlist entry never guarantees a booking.
 */
export async function findWaitlistMatches(
  q: Queryable,
  businessId: string,
  s: { serviceId: string; staffId: string | null; start: Date; partySize: number; timezone: string },
): Promise<WaitlistMatch[]> {
  const date = localDateOf(s.start.getTime(), s.timezone);
  const mins = minutesOfDay(s.start.getTime(), s.timezone);
  const r = await q.query<WaitlistMatch>(
    `SELECT id, name, email, phone, party_size FROM waitlist_entries
      WHERE business_id = $1 AND status = 'waiting' AND expires_at > now() AND service_id = $2
        AND (staff_id IS NULL OR staff_id = $3) AND $4::date BETWEEN date_from AND date_to
        AND $5 >= time_from_min AND $5 < time_to_min AND party_size <= $6
      ORDER BY created_at`,
    [businessId, s.serviceId, s.staffId, date, mins, Math.max(s.partySize, 1)],
  );
  return r.rows;
}

export async function expireWaitlist(q: Queryable): Promise<number> {
  const r = await q.query(`UPDATE waitlist_entries SET status = 'expired', updated_at = now() WHERE status IN ('waiting','contacted') AND expires_at <= now()`);
  return r.rowCount ?? 0;
}
