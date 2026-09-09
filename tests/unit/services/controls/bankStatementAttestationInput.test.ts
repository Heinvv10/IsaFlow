import {expect,it} from 'vitest';
import {parseBankStatementAttestation} from '@/modules/accounting/services/controls/bankStatementAttestationInput';
const input={bankAccountId:'11111111-1111-4111-8111-111111111111',sourceDocumentId:'22222222-2222-4222-8222-222222222222',expectedSourceHash:'a'.repeat(64),
 periodStart:'2026-08-01',periodEnd:'2026-08-31',sourceCount:0,openingBalance:'1000.00',closingBalance:'1000',currency:'ZAR'};
it('accepts a zero-movement statement with exact amounts and dates',()=>{
 expect(parseBankStatementAttestation(input)).toMatchObject({sourceCount:0,openingBalance:'1000',closingBalance:'1000'});
});
it.each([{sourceCount:-1},{sourceCount:1.5},{periodStart:'2026-02-30'},{periodEnd:'2026-07-31'},{openingBalance:1000},
 {closingBalance:'NaN'},{currency:'zar'},{expectedSourceHash:'bad'},{companyId:'foreign'},{verified:true},{reviewerPersonId:'actor'}])
 ('refuses malformed or caller-authority input %j',change=>expect(()=>parseBankStatementAttestation({...input,...change})).toThrow());
