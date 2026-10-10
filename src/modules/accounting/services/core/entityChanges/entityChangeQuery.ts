/**
 * Reading entity_changes (migration 890) — the per-entity timeline and the
 * company-wide feed. Runs as the request's app_user, so RLS
 * (entity_changes_read) already binds the tenant and the reader's role; the
 * `types` filter states the same rule for the caller (entityChangeTypes.ts)
 * so a narrower reader asks only for what they may see. Newest first, paged
 * by `seq`. Sensitive values come back masked (entityChangeMasking.ts).
 */
import { sql } from '@/lib/neon';
import { changeFields } from './entityChangeMasking';
import type { Channel, EntityChangePage, EntityChangeView, EntityType } from './entityChangeTypes';

export interface EntityChangeRow {
  id: string;
  seq: string;
  entity_type: EntityType;
  entity_id: string;
  op: 'create' | 'update' | 'delete';
  changed: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor: string;
  actor_name: string | null;
  subject_name: string | null;
  channel: Channel;
  impersonator: string | null;
  recorded_at: Date | string;
}

export interface ListEntityChangesOptions {
  /** The types this reader may see (mayReadType); never empty. */
  types: readonly EntityType[];
  entityType?: EntityType;
  entityId?: string;
  /** Only changes older than this seq (the previous page's nextCursor). */
  before?: string;
  limit?: number;
}

export const MAX_PAGE = 100;

const nameOf = (p: Record<string, unknown> | null, key: string): string | null => {
  const v = p?.[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
};

/** What the entity was called, from what the change recorded of it. */
export function entityLabel(type: EntityType, row: Pick<EntityChangeRow, 'before' | 'after' | 'subject_name'>): string | null {
  const p = row.after ?? row.before;
  switch (type) {
    case 'gl_account': {
      const code = nameOf(p, 'account_code');
      const name = nameOf(p, 'account_name');
      return [code, name].filter(Boolean).join(' ') || null;
    }
    case 'payroll_employee':
      return [nameOf(p, 'first_name'), nameOf(p, 'last_name')].filter(Boolean).join(' ') || nameOf(p, 'employee_number');
    case 'company_user':
      return row.subject_name ?? nameOf(p, 'user_id');
    case 'company_user_permission':
      return [row.subject_name ?? nameOf(p, 'user_id'), nameOf(p, 'module_key')].filter(Boolean).join(' · ') || null;
    case 'company_invitation':
      return nameOf(p, 'email');
    case 'approval_enforcement':
      return nameOf(p, 'document_type');
    default:
      return nameOf(p, 'name');
  }
}

export function toView(row: EntityChangeRow, reveal = false): EntityChangeView {
  return {
    id: row.id,
    seq: String(row.seq),
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityLabel: entityLabel(row.entity_type, row),
    op: row.op,
    fields: changeFields(row.entity_type, row.changed, row.before, row.after, reveal),
    actor: row.actor,
    actorName: row.actor_name,
    channel: row.channel,
    impersonator: row.impersonator,
    recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at),
  };
}

/**
 * The rows of entity_changes for this company, with the actor's and (for a
 * member or permission) the subject's name — names resolve only for current
 * members (approval_company_member_name); a script's 'db:<role>' has none.
 */
export async function selectEntityChanges(companyId: string, opts: {
  types: readonly EntityType[]; entityType?: EntityType; entityId?: string; before?: string; changeId?: string; limit: number;
}): Promise<EntityChangeRow[]> {
  return (await sql`
    SELECT ec.id, ec.seq::TEXT AS seq, ec.entity_type, ec.entity_id, ec.op, ec.changed, ec.before, ec.after,
           ec.actor, ec.channel, ec.impersonator, ec.recorded_at,
           CASE WHEN ec.actor LIKE 'db:%' THEN NULL
                ELSE public.approval_company_member_name(ec.company_id, ec.actor) END AS actor_name,
           CASE WHEN ec.entity_type IN ('company_user', 'company_user_permission')
                THEN public.approval_company_member_name(ec.company_id, COALESCE(ec.after, ec.before) ->> 'user_id')
           END AS subject_name
    FROM entity_changes ec
    WHERE ec.company_id = ${companyId}::UUID
      AND ec.entity_type = ANY(${[...opts.types]}::TEXT[])
      AND (${opts.entityType ?? null}::TEXT IS NULL OR ec.entity_type = ${opts.entityType ?? null}::TEXT)
      AND (${opts.entityId ?? null}::UUID IS NULL OR ec.entity_id = ${opts.entityId ?? null}::UUID)
      AND (${opts.changeId ?? null}::UUID IS NULL OR ec.id = ${opts.changeId ?? null}::UUID)
      AND (${opts.before ?? null}::BIGINT IS NULL OR ec.seq < ${opts.before ?? null}::BIGINT)
    ORDER BY ec.seq DESC
    LIMIT ${opts.limit}
  `) as EntityChangeRow[];
}

export async function listEntityChanges(companyId: string, opts: ListEntityChangesOptions): Promise<EntityChangePage> {
  if (opts.types.length === 0) return { items: [], nextCursor: null };
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_PAGE);
  const rows = await selectEntityChanges(companyId, { ...opts, limit: limit + 1 });
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => toView(r)),
    nextCursor: rows.length > limit ? String(page[page.length - 1]!.seq) : null,
  };
}
