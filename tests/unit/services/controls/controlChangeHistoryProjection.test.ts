import {expect,it} from 'vitest';
import {projectHistoryValues} from '@/modules/accounting/services/controls/controlChangeHistoryProjection';
it('preserves exact nested payroll and classification material and records only sensitive redactions',()=>{
 const input={before:null,after:{amount:'123.45',components:[{amount:'7000.01',component_id:'component'}],classification:{account_subtype:'bank',parent_account_id:'parent'},bank_account_number:'123456789',nested:{accountNumber:'987654321',access_token:'secret'}}};
 const result=projectHistoryValues(input);
 expect(result.after).toMatchObject({amount:'123.45',components:[{amount:'7000.01',component_id:'component'}],classification:{account_subtype:'bank',parent_account_id:'parent'}});
 expect(result.redactedPaths).toEqual(['/after/bank_account_number','/after/nested/access_token','/after/nested/accountNumber']);
 expect(JSON.stringify(result)).not.toContain('123456789');expect(JSON.stringify(result)).not.toContain('987654321');expect(JSON.stringify(result)).not.toContain('secret');
});
it('rejects noncanonical evidence instead of silently losing fields',()=>{
 expect(()=>projectHistoryValues({before:null,after:{missing:undefined}})).toThrow();
});
