import type {ControlTx} from './contracts';
import {assertControlTx} from './context';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {JournalRiskRow,JournalThreshold} from './journalRiskAnalysis';
interface SourceRow extends JournalRiskRow {population:string;lineCount:number;lines:unknown[];periodEventVersion:number|null;reversalOwned:boolean;changeCount:number}
/** One statement snapshot; aggregates count complete populations without returning unbounded row lists. */
export async function loadJournalRiskPopulation(ctx:ControlTx,cutoff:string|null){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:reports');
 const rows=await ctx.sql`SELECT j.id,j.entry_date::text AS "accountingDate",COALESCE(j.posted_at,j.created_at)::text AS "actualAt",
  CASE WHEN j.posted_at IS NULL THEN 'created_at' ELSE 'posted_at' END AS "actualBasis",
  COALESCE(j.posted_by,j.created_by)::text AS "personId",c.default_currency AS currency,
  COALESCE(lines.amount,0)::text AS amount,j.reversal_of_id::text AS "reversalOfId",j.reversed_at::text AS "reversedAt",
  event.id::text AS "periodEventId",event.new_version AS "periodEventVersion",
  CASE WHEN event.action IN ('fiscal_period.close','year_closed_period') THEN 'closed'
   WHEN event.action='fiscal_period.lock' THEN 'locked' WHEN event.action='fiscal_period.reopen' THEN 'open' ELSE NULL END AS "periodState",
  COALESCE(changes.facts,'[]'::jsonb) AS changes,COALESCE(changes.count,0)::int AS "changeCount",
  v.version,COUNT(*) OVER()::text AS population,COALESCE(lines.count,0)::int AS "lineCount",COALESCE(lines.facts,'[]'::jsonb) AS lines,
  (j.reversal_of_id IS NULL OR EXISTS(SELECT 1 FROM gl_journal_entries original WHERE original.company_id=j.company_id AND original.id=j.reversal_of_id)) AS "reversalOwned"
 FROM gl_journal_entries j JOIN companies c ON c.id=j.company_id
 LEFT JOIN LATERAL(SELECT cv.* FROM control_entity_versions cv WHERE cv.company_id=j.company_id AND cv.entity_type='journal_entry' AND lower(cv.entity_id)=j.id::text ORDER BY (cv.entity_id=j.id::text) DESC,cv.entity_id COLLATE "C" LIMIT 1) v ON true
 LEFT JOIN LATERAL(SELECT SUM(l.debit) AS amount,COUNT(*) AS count,
   (SELECT jsonb_agg(f) FROM(SELECT x.id,x.gl_account_id,x.debit::text,x.credit::text FROM gl_journal_lines x
    WHERE x.company_id=j.company_id AND x.journal_entry_id=j.id ORDER BY x.id LIMIT 101) f) AS facts
   FROM gl_journal_lines l WHERE l.company_id=j.company_id AND l.journal_entry_id=j.id) lines ON true
 LEFT JOIN LATERAL(SELECT COUNT(*) AS count,(SELECT jsonb_agg(f) FROM(
   SELECT x.id,x.action,x.new_version,x.occurred_at,x.accounting_date,history.id AS "periodEventId",
    CASE WHEN history.action IN ('fiscal_period.close','year_closed_period') THEN 'closed'
     WHEN history.action='fiscal_period.lock' THEN 'locked' WHEN history.action='fiscal_period.reopen' THEN 'open' ELSE NULL END AS "periodState"
   FROM control_change_events x LEFT JOIN LATERAL(SELECT e.id,e.action FROM control_change_events e
    JOIN fiscal_periods p ON p.company_id=e.company_id AND p.id::text=lower(e.entity_id)
    WHERE e.company_id=j.company_id AND e.entity_type='fiscal_period' AND p.id=j.fiscal_period_id
     AND e.action IN ('fiscal_period.close','fiscal_period.lock','fiscal_period.reopen','year_closed_period')
     AND e.occurred_at<=x.occurred_at ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1) history ON true
   WHERE x.company_id=j.company_id AND x.entity_type='journal_entry' AND x.entity_id=COALESCE(v.entity_id,j.id::text)
    AND x.action NOT IN ('baseline_observed','journal.post') ORDER BY x.occurred_at,x.id LIMIT 101) f) AS facts
   FROM control_change_events n WHERE n.company_id=j.company_id AND n.entity_type='journal_entry' AND n.entity_id=COALESCE(v.entity_id,j.id::text)
    AND n.action NOT IN ('baseline_observed','journal.post')) changes ON true
 LEFT JOIN LATERAL(SELECT e.id,e.new_version,e.action,e.occurred_at FROM control_change_events e
   JOIN fiscal_periods p ON p.company_id=e.company_id AND p.id::text=lower(e.entity_id)
   WHERE e.company_id=j.company_id AND e.entity_type='fiscal_period' AND p.id=j.fiscal_period_id
    AND e.action IN ('fiscal_period.close','fiscal_period.lock','fiscal_period.reopen','year_closed_period')
    AND e.occurred_at<=j.posted_at ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1) event ON true
 WHERE j.company_id=${ctx.principal.companyId}::uuid AND j.status='posted'
  AND (${cutoff}::date IS NULL OR j.entry_date<=${cutoff}::date) ORDER BY j.id LIMIT 10001` as SourceRow[];
 const policies=await ctx.sql`SELECT id,control_version AS version,condition_value::text AS amount,condition_operator AS operator,
  condition_field,aggregate_window_days,aggregate_by FROM approval_rules WHERE company_id=${ctx.principal.companyId}::uuid
  AND document_type='journal_entry' AND is_active=true ORDER BY id LIMIT 101` as Array<JournalThreshold&{condition_field:string;aggregate_window_days:number|null;aggregate_by:string|null}>;
 const usable=policies.filter(p=>['amount','total'].includes(p.condition_field)&&['greater_than','greater_equal'].includes(p.operator)&&p.aggregate_window_days===null&&p.aggregate_by===null);
 return{rows:rows.slice(0,10000),populationCount:Number(rows[0]?.population??0),over:rows.length>10000,
  thresholds:usable.slice(0,100),policies,missingPolicy:policies.length>100||usable.length!==policies.length};
}
