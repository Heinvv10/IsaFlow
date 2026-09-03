/**
 * The ledger audit trail: who posted to the general ledger, and whether that
 * attribution is a recorded fact or an inference.
 *
 * WHY THIS EXISTS. On production, 4,948 of Brightsphere's 4,949 journal
 * entries carry the same created_by. 2,287 of them are stamped
 * `mcp:<tool>:v1` and are provably agent work; 2,589 are stamped
 * `human:<userId>` and prove nothing, because createJournalEntry falls back to
 * defaultHumanMeta whenever a caller omits the meta. An auditor cannot form a
 * view on controls over a ledger that cannot say who posted to it.
 *
 * Migrations 530/531 added actor_type / actor_token_jti and this reads them.
 * Legacy rows are NULL and are DERIVED here at read time via
 * resolveLegacyActorType — never backfilled. Every row therefore carries its
 * provenance, so a reader can tell which rows to go and check by hand.
 *
 * It supersedes listAgentPostings, which only ever saw `posting_agent LIKE
 * 'mcp:%'` — i.e. the postings that were already provable.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import {
  resolveLegacyActorType,
  resolveRecordedActorType,
  isActorType,
  type ActorType,
  type ActorProvenance,
} from '@/lib/mcp/contracts/actor';
import { encodeCursor, type CursorKey } from '@/lib/mcp/contracts/cursor';
import { summarise } from './auditTrailAttribution';
import type { ExcludedRow } from '@/lib/mcp/contracts/envelope';

/** Which column an entity_id is matched against. Documented in the tool. */
export const AUDIT_ENTITY_TYPES = [
  'journal',            // je.id
  'source_record',      // je.source_record_id — the bank tx / invoice / note behind it
  'source_document',    // je.source_document_id — captured_documents
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const AUDIT_ACTIONS = ['draft', 'posted', 'reversed'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditTrailFilters {
  from: string;
  to: string;
  limit: number;
  actorType?: ActorType;
  tokenJti?: string;
  userId?: string;
  source?: string;
  entityType?: AuditEntityType;
  entityId?: string;
  action?: AuditAction;
  cursor?: CursorKey | null;
}

export interface AuditTrailEntry {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  description: string;
  source: string;
  status: string;
  action: AuditAction;
  amount: number;
  actorType: ActorType;
  actorProvenance: ActorProvenance;
  /** Why a derived value may be wrong. Null on a recorded one. */
  actorCaveat: string | null;
  actorTokenJti: string | null;
  postingAgent: string | null;
  /** Who RAISED it (created_by). */
  userId: string | null;
  userName: string | null;
  /**
   * Who POSTED it (posted_by) — a different question from who raised it, and
   * the one an auditor asks about segregation of duties. Null on a draft.
   */
  postedByUserId: string | null;
  postedByUserName: string | null;
  createdAt: string;
  postedAt: string | null;
  reversedAt: string | null;
  reversalOfId: string | null;
  sourceRecordId: string | null;
}

export interface AttributionSplit { recorded: number; derived: number }

export interface AuditTrailPage {
  rows: AuditTrailEntry[];
  /** Attributable rows matching the filters, before paging. */
  rowsTotal: number;
  /**
   * Rows in the filtered range before the attribution split — present only
   * when the caller applied no actor-side filter. With an actor filter the
   * result is a SELECTION and completeness is not a claim being made, so
   * asserting one would manufacture a false fault (CONTRACTS.md §1).
   */
  universeTotal?: number;
  excludedRows: ExcludedRow[];
  nextCursor: string | null;
  /** MAX(created_at) of the rows consumed. Never now(). */
  postedThrough: string;
  attribution: {
    recorded: number;
    derived: number;
    byActorType: Record<ActorType, AttributionSplit>;
  };
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function actionOf(row: DbRow): AuditAction {
  if (row.reversed_at != null) return 'reversed';
  return String(row.status ?? '') === 'posted' ? 'posted' : 'draft';
}

function mapEntry(r: DbRow): AuditTrailEntry {
  const postingAgent = r.posting_agent != null ? String(r.posting_agent) : null;
  const recorded = isActorType(r.actor_type) ? r.actor_type : null;
  // ONE actor model: contracts/actor.ts decides, this only supplies the inputs.
  const resolved = recorded
    ? resolveRecordedActorType(recorded)
    : resolveLegacyActorType(postingAgent);
  return {
    journalEntryId: String(r.id),
    entryNumber: String(r.entry_number ?? ''),
    entryDate: fmtDate(r.entry_date),
    description: String(r.description ?? ''),
    source: String(r.source ?? 'manual'),
    status: String(r.status ?? ''),
    action: actionOf(r),
    amount: Number(r.amount ?? 0),
    actorType: resolved.actorType,
    actorProvenance: resolved.provenance,
    actorCaveat: resolved.caveat ?? null,
    actorTokenJti: r.actor_token_jti != null ? String(r.actor_token_jti) : null,
    postingAgent,
    userId: r.created_by != null ? String(r.created_by) : null,
    userName: r.created_by_name != null ? String(r.created_by_name) : null,
    postedByUserId: r.posted_by != null ? String(r.posted_by) : null,
    postedByUserName: r.posted_by_name != null ? String(r.posted_by_name) : null,
    createdAt: iso(r.created_at),
    postedAt: r.posted_at != null ? iso(r.posted_at) : null,
    reversedAt: r.reversed_at != null ? iso(r.reversed_at) : null,
    reversalOfId: r.reversal_of_id != null ? String(r.reversal_of_id) : null,
    sourceRecordId: r.source_record_id != null ? String(r.source_record_id) : null,
  };
}

export async function queryAuditTrail(
  companyId: string,
  f: AuditTrailFilters,
): Promise<AuditTrailPage> {
  try {
    const actorType = f.actorType ?? null;
    const tokenJti = f.tokenJti ?? null;
    const userId = f.userId ?? null;
    const source = f.source ?? null;
    const action = f.action ?? null;
    const entityId = f.entityId ?? null;
    const entityType = f.entityType ?? null;
    const cur = f.cursor?.parts ?? null;
    const curDate = cur ? cur[0]! : null;
    const curId = cur ? cur[1]! : null;

    // Ordered oldest-last: an audit trail is read newest first, and the cursor
    // names the last row served (entry_date, id) so a concurrent posting
    // cannot shift a page.
    const rows = (await sql`
      SELECT je.id, je.entry_number, je.entry_date, je.description, je.source, je.status,
             je.posting_agent, je.actor_type, je.actor_token_jti,
             je.created_by, je.posted_by, je.created_at, je.posted_at, je.reversed_at,
             je.reversal_of_id, je.source_record_id, je.source_document_id,
             CONCAT_WS(' ', u.first_name, u.last_name) AS created_by_name,
             CONCAT_WS(' ', pu.first_name, pu.last_name) AS posted_by_name,
             COALESCE(SUM(jl.debit), 0) AS amount
      FROM gl_journal_entries je
      LEFT JOIN gl_journal_lines jl
        ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
      -- users.id is character varying(255) and created_by/posted_by are uuid,
      -- so the UUID side is cast to TEXT, never the other way (CI guard).
      -- Both joins are OUTER: a posting whose user row is missing must not
      -- vanish from the trail, and must not silently become someone else.
      LEFT JOIN users u ON u.id::TEXT = je.created_by::TEXT
      LEFT JOIN users pu ON pu.id::TEXT = je.posted_by::TEXT
      WHERE je.company_id = ${companyId}::UUID
        AND je.entry_date >= ${f.from}::DATE
        AND je.entry_date <= ${f.to}::DATE
        AND (je.actor_type IS NOT NULL OR je.posting_agent IS NOT NULL)
        AND (${actorType}::TEXT IS NULL OR (
              je.actor_type = ${actorType}
              OR (je.actor_type IS NULL AND ${actorType} = 'agent'  AND je.posting_agent LIKE 'mcp:%')
              OR (je.actor_type IS NULL AND ${actorType} = 'system' AND je.posting_agent LIKE 'system:%')
              OR (je.actor_type IS NULL AND ${actorType} = 'human'  AND je.posting_agent IS NOT NULL
                  AND je.posting_agent NOT LIKE 'mcp:%' AND je.posting_agent NOT LIKE 'system:%')))
        AND (${tokenJti}::TEXT IS NULL OR je.actor_token_jti = ${tokenJti})
        AND (${userId}::TEXT IS NULL OR je.created_by::TEXT = ${userId})
        AND (${source}::TEXT IS NULL OR je.source = ${source})
        AND (${action}::TEXT IS NULL OR (
              (${action} = 'reversed' AND je.reversed_at IS NOT NULL)
              OR (${action} = 'posted' AND je.reversed_at IS NULL AND je.status = 'posted')
              OR (${action} = 'draft'  AND je.reversed_at IS NULL AND je.status <> 'posted')))
        AND (${entityId}::TEXT IS NULL OR (
              (${entityType} = 'journal'         AND je.id::TEXT = ${entityId})
              OR (${entityType} = 'source_record'   AND je.source_record_id::TEXT = ${entityId})
              OR (${entityType} = 'source_document' AND je.source_document_id::TEXT = ${entityId})))
        AND (${curDate}::TEXT IS NULL
             OR (je.entry_date, je.id::TEXT) < (${curDate}::DATE, ${curId}::TEXT))
      GROUP BY je.id, u.first_name, u.last_name, pu.first_name, pu.last_name
      ORDER BY je.entry_date DESC, je.id DESC
      LIMIT ${f.limit + 1}
    `) as DbRow[];

    const page = rows.slice(0, f.limit).map(mapEntry);
    const nextCursor = rows.length > f.limit && page.length > 0
      ? encodeCursor({ parts: [page[page.length - 1]!.entryDate, page[page.length - 1]!.journalEntryId] })
      : null;

    const summary = await summarise(companyId, f, actorType, tokenJti, userId, source, action, entityType, entityId);
    return { rows: page, nextCursor, ...summary };
  } catch (err) {
    log.error('Failed to query audit trail', { companyId, error: err }, 'accounting');
    throw err;
  }
}

