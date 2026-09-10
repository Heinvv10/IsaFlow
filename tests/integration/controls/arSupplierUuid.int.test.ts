import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {arCiFixture} from './arCiFixture';
import {createCreditNote} from '@/modules/accounting/services/ar/creditNoteService';
let f:Awaited<ReturnType<typeof arCiFixture>>,supplier:string,foreignSupplier:string;
beforeAll(async()=>{
 f=await arCiFixture();supplier=randomUUID();foreignSupplier=randomUUID();
 await f.pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic credit UUID'),($3,$4,'Foreign credit UUID')",[supplier,f.f.companyA,foreignSupplier,f.f.companyB]);
},30000);
afterAll(async()=>{await f?.close();});
it('retains the exact supplier UUID in a real credit note issued by the human context',async()=>{
 const note=await f.actor(async ctx=>{
  expect(ctx.principal.authMethod).toBe('cookie');
  const [role]=await ctx.sql`SELECT current_user AS name`;
  expect(role).toEqual({name:'app_user'});
  return createCreditNote(f.f.companyA,{type:'supplier',supplierId:supplier,creditDate:'2026-07-05',subtotal:100},f.f.u1.id);
 });
 expect(note.supplierId).toBe(supplier);
 const row=(await f.pool.query('SELECT supplier_id,client_id,created_by,actor_type,actor_token_jti FROM credit_notes WHERE company_id=$1 AND id=$2',[f.f.companyA,note.id])).rows[0];
 expect(row).toEqual({supplier_id:supplier,client_id:null,created_by:f.f.u1.id,actor_type:'human',actor_token_jti:null});
});
it('persists SQL NULL supplier_id when creating a customer credit note without a supplier',async()=>{
 const note=await f.actor(()=>createCreditNote(f.f.companyA,{type:'customer',clientId:f.customer,creditDate:'2026-07-05',subtotal:100},f.f.u1.id));
 const row=(await f.pool.query('SELECT supplier_id,client_id FROM credit_notes WHERE company_id=$1 AND id=$2',[f.f.companyA,note.id])).rows[0];
 expect(row).toEqual({supplier_id:null,client_id:f.customer});
});
it('does not write a supplier note without issued authority or with a forged person',async()=>{
 const input={type:'supplier' as const,supplierId:supplier,creditDate:'2026-07-05',subtotal:100},before=await f.state();
 await expect(createCreditNote(f.f.companyA,input,f.f.u1.id)).rejects.toThrow('Authenticated');
 await expect(f.actor(()=>createCreditNote(f.f.companyA,input,f.f.u2.id))).rejects.toThrow('actor');
 expect(await f.state()).toEqual(before);
});
it('refuses a real foreign supplier UUID before creating any note',async()=>{
 const before=await f.state();
 await expect(f.actor(()=>createCreditNote(f.f.companyA,{type:'supplier',supplierId:foreignSupplier,creditDate:'2026-07-05',subtotal:100},f.f.u1.id))).rejects.toThrow();
 expect(await f.state()).toEqual(before);
});
