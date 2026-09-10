import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildBankAllocationLines} from '@/modules/accounting/services/bank/bankAllocationPlan';
const bank=randomUUID(),control=randomUUID();
for(const kind of ['supplier','customer'] as const)for(const amount of ['115','-115','120290','-120290'])it(`${kind} ${amount}: real immutable plan uses gross balanced party legs without VAT`,()=>{
 const lines=buildBankAllocationLines({version:1,kind,bankTransactionId:randomUUID(),partyId:randomUUID(),applications:[]},{bankAccountId:bank,signedAmount:amount,controlAccountId:control,vatAccountId:randomUUID()});
 const gross=String(Math.abs(Number(amount))),positive=Number(amount)>0;
 expect(lines).toHaveLength(2);
 expect(lines.find(l=>l.accountId===bank)).toMatchObject({debit:positive?gross:'0',credit:positive?'0':gross,vatType:null});
 expect(lines.find(l=>l.accountId===control)).toMatchObject({debit:positive?'0':gross,credit:positive?gross:'0',vatType:null});
 expect(lines.reduce((n,l)=>n+Number(l.debit),0)).toBe(Number(gross));
 expect(lines.reduce((n,l)=>n+Number(l.credit),0)).toBe(Number(gross));
});
