import {afterEach,beforeEach,expect,it} from 'vitest';
import {transferControlFixture} from './bankTransferControlFixture';
let f:Awaited<ReturnType<typeof transferControlFixture>>;
beforeEach(async()=>{f=await transferControlFixture();});afterEach(async()=>{if(f)await f.close();});
it('prepares external transfer instructions without caller-supplied matching selection',async()=>{
 const bank=await f.bank(),prepared=await f.prepare(bank);
 expect(await f.saved(prepared.intentId)).toMatchObject({version:1,kind:'transfer',bankTransactionId:bank,counterpartyAccountId:f.to,transfer:{mode:'post',oppositeBankTransactionId:null}});
 expect((await f.pool.query("SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source='auto_bank_transfer'",[f.f.companyA])).rows).toHaveLength(0);
});
