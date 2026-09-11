import {sql} from '@/lib/neon';
import {UUID_RE} from '@/lib/validation';
import type {JournalThreshold} from './journalRiskAnalysis';
/** Only the source page size is a seam; the threshold, change-fact and line-fact caps stay literals in the SQL below. */
export const JOURNAL_RISK_DEFAULT_LIMITS=Object.freeze({sourceFetch:10001});
export type JournalRiskSourceLimits=typeof JOURNAL_RISK_DEFAULT_LIMITS;
/** Slab tuple and cursor ORDER BY: the same three expressions, so a slab boundary is exactly an ORDER BY change. */
const SLAB_DAY=`((COALESCE(j.posted_at,j.created_at)) AT TIME ZONE 'Africa/Johannesburg')::date`;
const SLAB_PERSON=`COALESCE(j.posted_by,j.created_by)::text`,SLAB_CURRENCY='c.default_currency';
const COMMON=`j.id,j.entry_date::text AS "accountingDate",COALESCE(j.posted_at,j.created_at)::text AS "actualAt",
  CASE WHEN j.posted_at IS NULL THEN 'created_at' ELSE 'posted_at' END AS "actualBasis",
  ${SLAB_PERSON} AS "personId",${SLAB_CURRENCY} AS currency,
  COALESCE(lines.amount,0)::text AS amount,j.reversal_of_id::text AS "reversalOfId",j.reversed_at::text AS "reversedAt",
  event.id::text AS "periodEventId",event.new_version AS "periodEventVersion",
  CASE WHEN event.action IN ('fiscal_period.close','year_closed_period') THEN 'closed'
   WHEN event.action='fiscal_period.lock' THEN 'locked' WHEN event.action='fiscal_period.reopen' THEN 'open' ELSE NULL END AS "periodState",
  COALESCE(changes.facts,'[]'::jsonb) AS changes,COALESCE(changes.count,0)::int AS "changeCount",
  v.version,COALESCE(v.lineage_count,0)::int AS "lineageCount",(v.version_count>1 AND v.entity_id<>j.id::text) IS TRUE AS "lineageTie",COALESCE(lines.count,0)::int AS "lineCount",COALESCE(lines.facts,'[]'::jsonb) AS lines,
  (j.reversal_of_id IS NULL OR EXISTS(SELECT 1 FROM gl_journal_entries original WHERE original.company_id=j.company_id AND original.id=j.reversal_of_id)) AS "reversalOwned"`;
// Both LATERALs stay whole, including their capped facts sub-selects: the cursor never issues a per-parent child query.
// A period event matches `entity_id_canonical=j.fiscal_period_id::text`; with `p.id=j.fiscal_period_id` that is exactly the
// `p.id::text=e.entity_id_canonical` join it replaces, but j is outer, so it is a Param and an index condition under RLS.
const BODY=` FROM gl_journal_entries j JOIN companies c ON c.id=j.company_id
 LEFT JOIN LATERAL(SELECT cv.*,count(*) OVER() AS lineage_count,count(*) OVER(PARTITION BY cv.version) AS version_count FROM control_entity_versions cv WHERE cv.company_id=j.company_id AND cv.entity_type='journal_entry' AND cv.entity_id_canonical=j.id::text ORDER BY cv.version DESC,(cv.entity_id=j.id::text) DESC,cv.entity_id COLLATE "C" LIMIT 1) v ON true
 LEFT JOIN LATERAL(SELECT SUM(l.debit) AS amount,COUNT(*) AS count,
   (SELECT jsonb_agg(f) FROM(SELECT x.id,x.gl_account_id,x.debit::text,x.credit::text FROM gl_journal_lines x
    WHERE x.company_id=j.company_id AND x.journal_entry_id=j.id ORDER BY x.id LIMIT 101) f) AS facts
   FROM gl_journal_lines l WHERE l.company_id=j.company_id AND l.journal_entry_id=j.id) lines ON true
 LEFT JOIN LATERAL(SELECT COUNT(*) AS count,(SELECT jsonb_agg(f) FROM(
   SELECT x.id,x.action,x.new_version,x.occurred_at,x.accounting_date,history.id AS "periodEventId",
    CASE WHEN history.action IN ('fiscal_period.close','year_closed_period') THEN 'closed'
     WHEN history.action='fiscal_period.lock' THEN 'locked' WHEN history.action='fiscal_period.reopen' THEN 'open' ELSE NULL END AS "periodState"
   FROM control_change_events x LEFT JOIN LATERAL(SELECT e.id,e.action FROM control_change_events e
    JOIN fiscal_periods p ON p.company_id=e.company_id
    WHERE e.company_id=j.company_id AND e.entity_type='fiscal_period' AND p.id=j.fiscal_period_id AND e.entity_id_canonical=j.fiscal_period_id::text
     AND e.action IN ('fiscal_period.close','fiscal_period.lock','fiscal_period.reopen','year_closed_period')
     AND e.occurred_at<=x.occurred_at ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1) history ON true
   WHERE x.company_id=j.company_id AND x.entity_type='journal_entry' AND x.entity_id_canonical=j.id::text
    AND x.action NOT IN ('baseline_observed','journal.post') ORDER BY x.occurred_at,x.id LIMIT 101) f) AS facts
   FROM control_change_events n WHERE n.company_id=j.company_id AND n.entity_type='journal_entry' AND n.entity_id_canonical=j.id::text
    AND n.action NOT IN ('baseline_observed','journal.post')) changes ON true
 LEFT JOIN LATERAL(SELECT e.id,e.new_version,e.action,e.occurred_at FROM control_change_events e
   JOIN fiscal_periods p ON p.company_id=e.company_id
   WHERE e.company_id=j.company_id AND e.entity_type='fiscal_period' AND p.id=j.fiscal_period_id AND e.entity_id_canonical=j.fiscal_period_id::text
    AND e.action IN ('fiscal_period.close','fiscal_period.lock','fiscal_period.reopen','year_closed_period')
    AND e.occurred_at<=j.posted_at ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1) event ON true
 WHERE j.company_id=$1::uuid AND j.status='posted' AND ($2::date IS NULL OR j.entry_date<=$2::date)`;
export interface JournalRiskPopulationInput {companyId:string;cutoff:string|null;slabTuple:boolean;limits?:JournalRiskSourceLimits}
/**
 * One builder for both readings of the population. `slabTuple:false` keeps the paged detector's row shape and its
 * `COUNT(*) OVER()` byte for byte, so `sourceHash` and every fingerprint are unchanged; `slabTuple:true` drops the
 * window count (the stream counts rows itself), adds the three slab columns and orders by them for the cursor.
 */
export function journalRiskPopulationSql(input:JournalRiskPopulationInput){
 if(!UUID_RE.test(input.companyId))throw new Error('Invalid journal risk population tenant');
 if(input.cutoff!==null&&!/^\d{4}-\d{2}-\d{2}$/.test(input.cutoff))throw new Error('Invalid journal risk population cutoff');
 const values:unknown[]=[input.companyId,input.cutoff];
 if(input.slabTuple){
  return sql.unsafe(`SELECT ${COMMON},${SLAB_DAY} AS slab_day,${SLAB_PERSON} AS slab_person,${SLAB_CURRENCY} AS slab_currency${BODY}
   ORDER BY slab_day,slab_person,slab_currency,j.id`,values);
 }
 const limits=input.limits??JOURNAL_RISK_DEFAULT_LIMITS;
 if(!Number.isSafeInteger(limits.sourceFetch)||limits.sourceFetch<2)throw new Error('Invalid journal risk source limit');
 values.push(limits.sourceFetch);
 return sql.unsafe(`SELECT ${COMMON},COUNT(*) OVER()::text AS population${BODY} ORDER BY j.id LIMIT $3`,values);
}
/** The current-policy context, truncated and flagged exactly as the synchronous detector does (LIMIT 101, keep 100). */
export function journalRiskPolicySql(companyId:string){
 if(!UUID_RE.test(companyId))throw new Error('Invalid journal risk policy tenant');
 return sql.unsafe(`SELECT id,control_version AS version,condition_value::text AS amount,condition_operator AS operator,
  condition_field,aggregate_window_days,aggregate_by FROM approval_rules WHERE company_id=$1::uuid
  AND document_type='journal_entry' AND is_active=true ORDER BY id LIMIT 101`,[companyId]);
}
export interface JournalRiskPolicyRow extends JournalThreshold {condition_field:string;aggregate_window_days:number|null;aggregate_by:string|null}
/** Truncate and flag: unsupported or aggregate-bounded policies are context the detector cannot honour. */
export function journalRiskThresholds(policies:readonly JournalRiskPolicyRow[]){
 const usable=policies.filter(policy=>['amount','total'].includes(policy.condition_field)
  &&['greater_than','greater_equal'].includes(policy.operator)&&policy.aggregate_window_days===null&&policy.aggregate_by===null);
 return{thresholds:usable.slice(0,100),missingPolicy:policies.length>100||usable.length!==policies.length};
}
