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
/**
 * The resolved filters, as one object rather than nine positional arguments:
 * the excluded query and the universe query each take a DIFFERENT subset, and
 * a positional list made it invisible which was which — the blind review found
 * the excluded query had quietly been given none of them.
 */
export interface ResolvedFilters {
  actorType: string | null;
  tokenJti: string | null;
  userId: string | null;
  source: string | null;
  action: string | null;
  entityType: string | null;
  entityId: string | null;
  actingCompanyId: string | null;
  crossOnly: boolean;
}

/** Sampled excluded rows. The TOTAL is counted separately — see below. */
const EXCLUDED_SAMPLE_LIMIT = 200;

export async function summarise(
  companyId: string,
  f: AuditTrailFilters,
  q: ResolvedFilters,
): Promise<Omit<AuditTrailPage, 'rows' | 'nextCursor'>> {
  const { actorType, tokenJti, userId, source, action, entityType, entityId } = q;
  const { actingCompanyId, crossOnly } = q;
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
      AND (${actingCompanyId}::TEXT IS NULL OR je.acting_company_id::TEXT = ${actingCompanyId})
      AND (NOT ${crossOnly}::BOOLEAN
           OR (je.acting_company_id IS NOT NULL AND je.acting_company_id <> je.company_id))
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
  //
  // It carries the caller's NON-ACTOR filters. Blind review found it carried
  // none of them, so "manual journals with no attribution" returned the whole
  // company's unattributed rows. The actor filters are deliberately NOT
  // applied: a row with no actor cannot match one either way, and applying
  // them would empty the set exactly when the caller most needs to see it.
  const unattributed = (await sql`
    SELECT je.id, je.entry_number, COALESCE(SUM(jl.debit), 0) AS amount
    FROM gl_journal_entries je
    LEFT JOIN gl_journal_lines jl
      ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
    WHERE je.company_id = ${companyId}::UUID
      AND je.entry_date >= ${f.from}::DATE AND je.entry_date <= ${f.to}::DATE
      AND je.actor_type IS NULL AND je.posting_agent IS NULL
      AND (${actingCompanyId}::TEXT IS NULL OR je.acting_company_id::TEXT = ${actingCompanyId})
      AND (NOT ${crossOnly}::BOOLEAN
           OR (je.acting_company_id IS NOT NULL AND je.acting_company_id <> je.company_id))
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
    GROUP BY je.id
    ORDER BY je.entry_date DESC, je.id DESC
    LIMIT ${EXCLUDED_SAMPLE_LIMIT}
  `) as DbRow[];

  // The COUNT, separately, because the sample above is capped. Without this a
  // 201st unattributed row vanished from every figure with nothing flagged —
  // the completeness defect this whole programme exists to fix, reappearing
  // inside the completeness block.
  const [excludedCount] = (await sql`
    SELECT COUNT(*) AS cnt
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.entry_date >= ${f.from}::DATE AND je.entry_date <= ${f.to}::DATE
      AND je.actor_type IS NULL AND je.posting_agent IS NULL
      AND (${actingCompanyId}::TEXT IS NULL OR je.acting_company_id::TEXT = ${actingCompanyId})
      AND (NOT ${crossOnly}::BOOLEAN
           OR (je.acting_company_id IS NOT NULL AND je.acting_company_id <> je.company_id))
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
  `) as DbRow[];
  const excludedTotal = Number(excludedCount?.cnt ?? 0);

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

  // Withheld on a SELECTION rather than a census — an actor, token or firm
  // filter narrows to rows chosen by the caller, so completeness is not a
  // claim being made (CONTRACTS.md §1).
  //
  // A TRUNCATED SAMPLE IS NO LONGER A REASON TO WITHHOLD IT. buildEnvelope
  // now checks rowsTotal + excludedTotal, which is the true identity, so a
  // capped sample states its universe honestly and the envelope reports
  // truncatedExcludedRows for the reader.
  const isSelection =
    actorType !== null || tokenJti !== null || actingCompanyId !== null || crossOnly;
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
    excludedTotal,
    ...(universe === undefined ? {} : { universeTotal: universe }),
    excludedRows,
    postedThrough: new Date(latest).toISOString(),
    attribution: { recorded, derived, byActorType },
  };
}
