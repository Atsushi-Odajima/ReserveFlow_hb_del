import type { Queryable } from '../db/pool.js';

export interface Actor {
  type: 'customer' | 'user' | 'system';
  userId?: string | null;
}

export const SYSTEM: Actor = { type: 'system' };
export const CUSTOMER: Actor = { type: 'customer' };

/** Record an audit entry. `summary` must never contain secrets (tokens, passwords) or full question answers. */
export async function audit(
  q: Queryable,
  businessId: string | null,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string | null,
  summary: Record<string, unknown> = {},
): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs (business_id, actor_type, actor_user_id, action, entity_type, entity_id, summary) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [businessId, actor.type, actor.userId ?? null, action, entityType, entityId, JSON.stringify(summary)],
  );
}
