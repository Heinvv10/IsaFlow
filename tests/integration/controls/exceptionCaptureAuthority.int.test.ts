import {beforeAll,afterAll,expect,it} from 'vitest';
import {transferControlFixture} from './bankTransferControlFixture';
import {seedExceptionMismatch} from '../mcp-http/exceptionSourceFixture';
import {captureControlExceptions} from '@/modules/accounting/services/controls/controlExceptionService';
let f:Awaited<ReturnType<typeof transferControlFixture>>;
beforeAll(async()=>{f=await transferControlFixture();await seedExceptionMismatch(f.pool,f.f);},30000);afterAll(async()=>{if(f)await f.close();});
it('read-only current member cannot capture exceptions or occurrence/decision effects',async()=>{
 await f.pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[f.f.companyA,f.f.u1.id]);
 let failure:unknown;try{await f.actor(ctx=>captureControlExceptions(ctx,{checkId:'three_way_match_exceptions'}));}catch(error){failure=error;}
 const counts=(await f.pool.query('SELECT (SELECT count(*)::int FROM control_exceptions WHERE company_id=$1) exceptions,(SELECT count(*)::int FROM control_exception_occurrences WHERE company_id=$1) occurrences,(SELECT count(*)::int FROM control_exception_decisions WHERE company_id=$1) decisions',[f.f.companyA])).rows[0];
 expect(failure,JSON.stringify(counts)).toBeDefined();expect(counts).toEqual({exceptions:0,occurrences:0,decisions:0});
});
