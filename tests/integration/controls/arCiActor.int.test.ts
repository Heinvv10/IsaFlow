import {beforeAll,afterAll,expect,it} from 'vitest';
import {arCiFixture} from './arCiFixture';
import {createCreditNote} from '@/modules/accounting/services/ar/creditNoteService';
let f:Awaited<ReturnType<typeof arCiFixture>>;
beforeAll(async()=>{f=await arCiFixture();},30000);afterAll(async()=>{if(f)await f.close();});
it.each([false,true])('draft credit-note provenance cannot be forged by caller actor options (PAT=%s)',async pat=>{
 const note=await f.actor(()=>createCreditNote(f.f.companyA,{type:'customer',clientId:f.customer,creditDate:'2026-07-05',subtotal:100},f.f.u1.id,{actorType:'agent',actorTokenJti:f.f.u2.tokens[0]!.id}),'u1',pat);
 const row=(await f.pool.query('SELECT created_by,actor_type,actor_token_jti FROM credit_notes WHERE company_id=$1 AND id=$2',[f.f.companyA,note.id])).rows[0];
 expect(row.created_by).toBe(f.f.u1.id);expect(row.actor_token_jti).toBe(pat?f.f.u1.tokens[0]!.id:null);expect(row.actor_type).toBe(pat?'agent':'human');
});
it('OAuth drafts derive the current retained grant identity and unissued calls cannot create',async()=>{
 const input={type:'customer' as const,clientId:f.customer,creditDate:'2026-07-05',subtotal:100};
 await expect(createCreditNote(f.f.companyA,input,f.f.u1.id)).rejects.toThrow('Authenticated');
 const note=await f.actor(()=>createCreditNote(f.f.companyA,input,f.f.u1.id,{actorType:'human',actorTokenJti:f.f.u2.tokens[0]!.id}),'u1','oauth');
 expect((await f.pool.query('SELECT actor_type,actor_token_jti FROM credit_notes WHERE company_id=$1 AND id=$2',[f.f.companyA,note.id])).rows[0]).toEqual({actor_type:'agent',actor_token_jti:f.oauthGrant});
});
