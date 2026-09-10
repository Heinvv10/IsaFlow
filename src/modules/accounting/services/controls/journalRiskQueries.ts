import type {ControlTx} from './contracts';
import {assertControlTx} from './context';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {JournalRiskSourceRow} from './journalRiskShared';
import {JOURNAL_RISK_DEFAULT_LIMITS,journalRiskPolicySql,journalRiskPopulationSql,journalRiskThresholds,
 type JournalRiskPolicyRow,type JournalRiskSourceLimits} from './journalRiskPopulationSql';
interface SourceRow extends JournalRiskSourceRow {population:string;lines:unknown[]}
/**
 * One statement snapshot; aggregates count complete populations without returning unbounded row lists.
 * The page size is a defaulted seam so a differential oracle can read past it; the returned `source` never carries it,
 * so `sourceHash` stays a function of the rows alone.
 */
export async function loadJournalRiskPopulation(ctx:ControlTx,cutoff:string|null,limits:JournalRiskSourceLimits=JOURNAL_RISK_DEFAULT_LIMITS){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:reports');
 const rows=await ctx.sql`${journalRiskPopulationSql({companyId:ctx.principal.companyId,cutoff,slabTuple:false,limits})}` as SourceRow[];
 const policies=await ctx.sql`${journalRiskPolicySql(ctx.principal.companyId)}` as JournalRiskPolicyRow[];
 const keep=limits.sourceFetch-1,{thresholds,missingPolicy}=journalRiskThresholds(policies);
 return{rows:rows.slice(0,keep),populationCount:Number(rows[0]?.population??0),over:rows.length>keep,thresholds,policies,missingPolicy};
}
