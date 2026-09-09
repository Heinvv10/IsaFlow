import type {ControlTx} from './contracts';
import type {ParentJournalControl} from './generatedJournalPermit';
import {materializeHistoricalImportOperation} from './historicalImportMaterializer';
import {canonicalJson,canonicalMoney} from './canonical';
export async function readHistoricalJournalRelationship(ctx:ControlTx,control:ParentJournalControl,journalId:string,operation:'journal.post'|'journal.reverse'):Promise<unknown[]>{
 if(operation!=='journal.post'||control.parent.entityType!=='historical_import'||control.parent.operation!=='historical_import.post')return[];
 const material=await materializeHistoricalImportOperation(ctx,control.parent);
 const facts=material.observedSources[0]!.facts as {source:{contentHash:string;normalized:{mode:string}};period:{id:string};plan:Array<{glAccountId:string;debit:string;credit:string;description:string;vatType?:string}>};
 if(facts.source.normalized.mode!=='post_journal')return[];
 const headers=await ctx.sql`SELECT id,entry_date::text FROM gl_journal_entries WHERE company_id=${ctx.principal.companyId}::uuid
  AND id=${journalId}::uuid AND status='draft' AND source='auto_gl_import' AND source_record_id=${control.parent.entityId}::uuid
  AND entry_number=${`HI-${control.parent.entityId}`} AND entry_date=${control.permit.accountingDate}::date
  AND fiscal_period_id=${facts.period.id}::uuid AND source_document_hash=${facts.source.contentHash} FOR SHARE`;
 if(headers.length!==1)return[];
 const lines=await ctx.sql`SELECT gl_account_id,debit::text,credit::text,description,vat_type,cc1_id,cc2_id,bu_id,project_id,cost_center_id
  FROM gl_journal_lines WHERE company_id=${ctx.principal.companyId}::uuid AND journal_entry_id=${journalId}::uuid ORDER BY id FOR SHARE` as Record<string,unknown>[];
 const expected=facts.plan.map(l=>canonicalJson({account:l.glAccountId,debit:canonicalMoney(l.debit),credit:canonicalMoney(l.credit),description:l.description,vat:l.vatType??null})).sort();
 const actual=lines.map(l=>canonicalJson({account:l.gl_account_id,debit:canonicalMoney(String(l.debit)),credit:canonicalMoney(String(l.credit)),description:l.description,vat:l.vat_type})).sort();
 if(lines.some(l=>[l.cc1_id,l.cc2_id,l.bu_id,l.project_id,l.cost_center_id].some(v=>v!==null)))return[];
 return canonicalJson(expected)===canonicalJson(actual)?headers:[];
}
