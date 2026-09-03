/**
 * The attribution census behind audit_trail: how many postings in the filtered
 * range record their actor, how many are inferred from posting_agent, and
 * which record nothing at all.
 *
 * Split out of auditTrailLedgerService for the 300-line cap; it is the same
 * WHERE clause as the page query and must stay in step with it. The
 * `universeTotal` count is deliberately a SEPARATE query from the bucket
 * count, so a divergence between the two predicates shows up as a
 * completeness fault instead of a silently narrower report.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { isActorType, type ActorType } from '@/lib/mcp/contracts/actor';
import type { ExcludedRow } from '@/lib/mcp/contracts/envelope';
import type { AuditTrailFilters, AuditTrailPage, AttributionSplit } from './auditTrailLedgerService';

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

const EMPTY_SPLIT = (): Record<ActorType, AttributionSplit> => ({
  human: { recorded: 0, derived: 0 },
  agent: { recorded: 0, derived: 0 },
  system: { recorded: 0, derived: 0 },
});

/** Counts, attribution split and posted_through over the WHOLE filtered set. */
export async function summarise(
  companyId: string, f: AuditTrailFilters,
  actorType: string | null, tokenJti: string | null, userId: string | null,
  source: string | null, action: string | null,
  entityType: string | null, entityId: string | null,
): Promise<Omit<AuditTrailPage, 'rows' | 'nextCursor'>> {
  const buckets = (await sql`
    SELECT COALESCE(je.actor_type,
             CASE WHEN je.posting_agent LIKE 'mcp:%' THEN 'agent'
                  WHEN je.posting_agent LIKE 'system:%' THEN 'system'
                  ELSE 'human' END) AS bucket,
           (je.actor_type IS NOT NULL) AS recorded,
           COUNT(*) AS cnt, MAX(je.created_at) AS latest
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.entry_date >= ${f.from}::DATE AND je.entry_date <= ${f.to}::DATE
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
            (${entityType} = 'journal'          AND je.id::TEXT = ${entityId})
            OR (${entityType} = 'source_record'   AND je.source_record_id::TEXT = ${entityId})
            OR (${entityType} = 'source_document' AND je.source_document_id::TEXT = ${entityId})))
    GROUP BY 1, 2
  `) as DbRow[];

  // A posting with NEITHER column set records nothing about who made it. That
  // is an assurance finding, not a row to silently drop into the human bucket.
  const unattributed = (await sql`
    SELECT je.id, je.entry_number, COALESCE(SUM(jl.debit), 0) AS amount
    FROM gl_journal_entries je
    LEFT JOIN gl_journal_lines jl
      ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
    WHERE je.company_id = ${companyId}::UUID
      AND je.entry_date >= ${f.from}::DATE AND je.entry_date <= ${f.to}::DATE
      AND je.actor_type IS NULL AND je.posting_agent IS NULL
    GROUP BY je.id
    ORDER BY je.entry_date DESC, je.id DESC
    LIMIT 200
  `) as DbRow[];

  const byActorType = EMPTY_SPLIT();
  let recorded = 0;
  let derived = 0;
  let latest = 0;
  for (const b of buckets) {
    const bucket = isActorType(b.bucket) ? b.bucket : 'human';
    const n = Number(b.cnt ?? 0);
    if (b.recorded === true) { byActorType[bucket].recorded += n; recorded += n; }
    else { byActorType[bucket].derived += n; derived += n; }
    if (b.latest != null) latest = Math.max(latest, new Date(iso(b.latest)).getTime());
  }

  const excludedRows: ExcludedRow[] = unattributed.map((r) => ({
    id: String(r.id),
    reason: 'unattributed_posting',
    documentNumber: String(r.entry_number ?? ''),
    amount: Number(r.amount ?? 0),
    detail: 'Neither actor_type nor posting_agent is set — nothing records who made this posting.',
  }));

  const isSelection = actorType !== null || tokenJti !== null;
  const universe = isSelection
    ? undefined
    : Number((((await sql`
        SELECT COUNT(*) AS cnt FROM gl_journal_entries je
        WHERE je.company_id = ${companyId}::UUID
          AND je.entry_date >= ${f.from}::DATE AND je.entry_date <= ${f.to}::DATE
          AND (${userId}::TEXT IS NULL OR je.created_by::TEXT = ${userId})
          AND (${source}::TEXT IS NULL OR je.source = ${source})
          AND (${action}::TEXT IS NULL OR (
                (${action} = 'reversed' AND je.reversed_at IS NOT NULL)
                OR (${action} = 'posted' AND je.reversed_at IS NULL AND je.status = 'posted')
                OR (${action} = 'draft'  AND je.reversed_at IS NULL AND je.status <> 'posted')))
          AND (${entityId}::TEXT IS NULL OR (
                (${entityType} = 'journal'          AND je.id::TEXT = ${entityId})
                OR (${entityType} = 'source_record'   AND je.source_record_id::TEXT = ${entityId})
                OR (${entityType} = 'source_document' AND je.source_document_id::TEXT = ${entityId})))
      `) as DbRow[])[0]?.cnt) ?? 0);

  return {
    rowsTotal: recorded + derived,
    ...(universe === undefined ? {} : { universeTotal: universe }),
    excludedRows,
    postedThrough: new Date(latest).toISOString(),
    attribution: { recorded, derived, byActorType },
  };
}
