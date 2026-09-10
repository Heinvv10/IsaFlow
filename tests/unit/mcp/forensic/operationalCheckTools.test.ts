import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({threeWay:vi.fn(),journal:vi.fn(),bank:vi.fn(),payroll:vi.fn(),context:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/threeWayMatchChecks',()=>({checkThreeWayMatchExceptions:mocks.threeWay}));
vi.mock('@/modules/accounting/services/controls/journalRiskChecks',()=>({checkJournalRisks:mocks.journal}));
vi.mock('@/modules/accounting/services/controls/bankStatementCompletenessChecks',()=>({checkBankStatementCompleteness:mocks.bank}));
vi.mock('@/modules/accounting/services/controls/payrollControlChecks',()=>({checkPayrollControls:mocks.payroll}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:mocks.context}));
import {operationalCheckTools} from '@/lib/mcp/tools/forensicOperationalChecks';
const ctx={companyId:'transport-company',userId:'transport-person',scopes:['read:reports'],tokenJti:'token',oauthAppId:null};
const bound={principal:{companyId:'issued-company',personId:'issued-person'}};
const result={checkId:'synthetic',status:'unknown',populationCount:123,excludedCount:2,findingCount:121,
 amountTotals:{ZAR:'123.45'},findings:[{kind:'synthetic'}],nextCursor:'next',coverage:['current_values'],missingSources:['independent_source_unavailable']};
const checkers=[mocks.threeWay,mocks.journal,mocks.bank,mocks.payroll];
beforeEach(()=>{vi.clearAllMocks();mocks.context.mockReturnValue(bound);for(const fn of checkers)fn.mockResolvedValue(result);});
it('exposes precisely the four missing shared detective checks',()=>{
 expect(operationalCheckTools.map(t=>t.name)).toEqual(['three_way_match_exceptions','journal_risk_checks','bank_statement_completeness','payroll_control_checks']);
});
it.each([0,1,2,3])('passes issued authority and preserves the full result for check %i',async index=>{
 const tool=operationalCheckTools[index]!;
 expect(tool).toMatchObject({scope:'read:reports',write:false});expect(tool.requiresPost).toBeUndefined();
 expect(tool.inputSchema.additionalProperties).toBe(false);
 const response=await tool.handler({limit:20,cutoff:'2026-08-31',cursor:'prior'},ctx);
 expect(checkers[index]).toHaveBeenCalledWith(bound,{limit:20,cutoff:'2026-08-31',cursor:'prior'});
 expect(JSON.parse(response.content[0]!.text)).toEqual(result);
});
it.each([{limit:101},{limit:0},{limit:1.5},{cutoff:'2026-02-31'},{cursor:'x'.repeat(1025)},{company_id:'foreign'}])('refuses malformed input before shared access: %j',async args=>{
 for(const tool of operationalCheckTools)expect((await tool.handler(args,ctx)).isError).toBe(true);
 expect(mocks.context).not.toHaveBeenCalled();for(const fn of checkers)expect(fn).not.toHaveBeenCalled();
});
it.each([0,1,2,3])('propagates real shared-service refusal for check %i',async index=>{
 checkers[index]!.mockRejectedValueOnce(new Error('Current permission revoked'));
 await expect(operationalCheckTools[index]!.handler({},ctx)).rejects.toThrow('Current permission revoked');
});
