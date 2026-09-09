import {expect,it} from 'vitest';
import {bankStatementSourceFingerprint} from '@/modules/accounting/services/controls/bankStatementAttestationSource';
it('binds actual statement bytes and current owned account and currency facts',()=>{
 const source={account:{id:'bank',account_type:'asset',account_subtype:'bank',is_active:true},
 document:{id:'document',hash:'a'.repeat(64),status:'matched'},currency:'ZAR'};
 const original=bankStatementSourceFingerprint(source);
 expect(original).toMatch(/^[a-f0-9]{64}$/);
 expect(bankStatementSourceFingerprint({...source})).toBe(original);
 expect(bankStatementSourceFingerprint({...source,currency:'USD'})).not.toBe(original);
 expect(bankStatementSourceFingerprint({...source,account:{...source.account,is_active:false}})).not.toBe(original);
 expect(bankStatementSourceFingerprint({...source,document:{...source.document,hash:'b'.repeat(64)}})).not.toBe(original);
});
