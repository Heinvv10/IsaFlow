import {beforeAll,afterAll,expect,it} from 'vitest';
import {transferControlFixture} from './bankTransferControlFixture';
import {getConnectionPermissions} from '@/modules/accounting/services/controls/connectionPermissionsService';
let f:Awaited<ReturnType<typeof transferControlFixture>>;
beforeAll(async()=>{f=await transferControlFixture();},30000);afterAll(async()=>{if(f)await f.close();});
it('self-inspects two real PATs for one person without read:access',async()=>{
 const a=await f.actor(getConnectionPermissions,'u1',0),b=await f.actor(getConnectionPermissions,'u1',1);
 expect(a.personId).toBe(b.personId);expect(a.connectionId).not.toBe(b.connectionId);expect(a.permissions).toContain('read:bank-tx');expect(a.permissions).not.toContain('read:access');
});
it('cookie reflects current role ceiling and owner explicit module denial',async()=>{
 await f.pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[f.f.companyA,f.f.u1.id]);
 const viewer=await f.actor(getConnectionPermissions);expect(viewer.role).toBe('viewer');expect(viewer.permissions).not.toContain('write:bank-tx');
 await f.pool.query("UPDATE company_users SET role='owner' WHERE company_id=$1 AND user_id=$2",[f.f.companyA,f.f.u1.id]);
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write) VALUES($1,$2,'banking',false,false) ON CONFLICT(company_id,user_id,module_key) DO UPDATE SET can_read=false,can_write=false",[f.f.companyA,f.f.u1.id]);
 const owner=await f.actor(getConnectionPermissions);expect(owner.permissions).not.toContain('read:bank-tx');expect(owner.denied).toContainEqual({permission:'read:bank-tx',reason:'MODULE_DENIED',conditional:false});
});
it('current stored grant revocation refuses rather than returning cached authority',async()=>{
 await f.pool.query('UPDATE personal_access_tokens SET revoked_at=now() WHERE company_id=$1 AND id=$2',[f.f.companyA,f.f.u1.tokens[0]!.id]);
 await expect(f.actor(getConnectionPermissions,'u1',0)).rejects.toThrow();expect((await f.actor(getConnectionPermissions,'u1',1)).connectionId).toBe(f.f.u1.tokens[1]!.id);
});
