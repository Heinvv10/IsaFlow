import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {operationalCheckHttpFixture} from './operationalCheckHttpFixture';
import type {RpcReply} from '../mcp-http/client';
import type {ControlCheckResult} from '@/modules/accounting/services/controls/contracts';
let f:Awaited<ReturnType<typeof operationalCheckHttpFixture>>;
beforeAll(async()=>{f=await operationalCheckHttpFixture();},30000);afterAll(async()=>{if(f)await f.close();});
const names=['three_way_match_exceptions','journal_risk_checks','bank_statement_completeness','payroll_control_checks'];
function result(reply:RpcReply):ControlCheckResult{
 expect(reply.error).toBeUndefined();expect(reply.result?.isError).not.toBe(true);
 return JSON.parse(reply.result!.content!.map(row=>row.text).join('\n')) as ControlCheckResult;
}
it('serves all four registered shared checks through real PAT HTTP and preserves missing-source coverage',async()=>{
 const manifest=await f.client.rpc(f.f.u1.tokens[0]!.raw,'tools/list');
 for(const name of names)expect(manifest.result?.tools?.filter(tool=>tool.name===name)).toHaveLength(1);
 for(const name of names){
  const data=result(await f.call(name));expect(data.checkId).toBe(name);expect(data.populationCount).toBe(0);expect(data.findings).toEqual([]);
  if(name==='bank_statement_completeness'){expect(data.status).toBe('unknown');expect(data.missingSources).toContain('source_statement_population_unavailable');}
  if(name==='payroll_control_checks'){expect(data.status).toBe('unknown');expect(data.missingSources).toContain('independent_employee_settlement_evidence_unavailable');}
 }
});
it('detects an actual backdated source journal once and isolates it from a second tenant',async()=>{
 const id=randomUUID(),period=(await f.pool.query('SELECT id FROM fiscal_periods WHERE company_id=$1 LIMIT 1',[f.f.companyA])).rows[0].id;
 await f.pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,source,status,created_by,posted_by,posted_at,created_at)
 VALUES($1,$2,'2026-09-01',$3,'manual','posted',$4,$4,'2026-09-09T20:00:00Z','2026-09-09T20:00:00Z')`,[id,f.f.companyA,period,f.f.u1.id]);
 await f.pool.query('INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit) VALUES($1,$2,$3,123.45,0),($1,$2,$4,0,123.45)',[id,f.f.companyA,f.from,f.to]);
 const data=result(await f.call('journal_risk_checks',{limit:1}));expect(data.populationCount).toBe(1);expect(data.findingCount).toBe(1);
 expect(data.amountTotals).toEqual({ZAR:'123.45'});expect(data.findings[0]?.classification).toBe('candidate');
 expect(data.findings[0]?.message).toContain('backdated_accounting_date');
 expect(result(await f.call('journal_risk_checks',{},'u3')).populationCount).toBe(0);
});
it.each([['three_way_match_exceptions','invoices'],['journal_risk_checks','reports'],['bank_statement_completeness','banking'],['payroll_control_checks','payroll']])('rechecks current %s authority without changing broad PAT scopes',async(name,module)=>{
 const token=f.f.u1.tokens[0]!,before=(await f.pool.query('SELECT scopes FROM personal_access_tokens WHERE company_id=$1 AND id=$2',[f.f.companyA,token.id])).rows[0].scopes;
 result(await f.call(name));
 await f.pool.query('INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,$3,false)',[f.f.companyA,f.f.u1.id,module]);
 try{const denied=await f.call(name);expect(denied.result?.isError).toBe(true);expect(denied.result?.content?.map(row=>row.text).join(' ')).not.toMatch(/SELECT |SQLSTATE|password|token_hash/);}
 finally{await f.pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key=$3',[f.f.companyA,f.f.u1.id,module]);}
 result(await f.call(name));
 expect((await f.pool.query('SELECT scopes FROM personal_access_tokens WHERE company_id=$1 AND id=$2',[f.f.companyA,token.id])).rows[0].scopes).toEqual(before);
 const effects=await f.snapshot();expect(effects.effects).toEqual([]);expect(effects.approvals).toEqual([]);expect(effects.changes).toEqual([]);
 const receipt=(await f.pool.query("SELECT count(*)::int AS n FROM mcp_invocation_attempts a JOIN mcp_invocation_receipts r ON r.company_id=a.company_id AND r.attempt_id=a.id WHERE a.company_id=$1 AND a.tool=$2 AND r.status IN ('rejected','error') AND r.reported_write=false",[f.f.companyA,name])).rows[0];expect(receipt.n).toBeGreaterThan(0);
});
