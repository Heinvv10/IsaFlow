import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {mergeAccounts} from '@/modules/accounting/services/gl/accountMergeService';
import {evidence,glFixture,journalRows,legacy,merge,mergeFixture,patMerge,pool} from './glAccountMergeCaptureFixture';
it('captures the actual merge with complete journal images and exact recovery identity',async()=>{
 const f=glFixture(),m=await mergeFixture(),before=await journalRows(m.journal);
 const result=await merge(m.source,m.target),after=await journalRows(m.journal);
 const source=await evidence('gl_account',m.source),journal=await evidence('journal_entry',m.journal);
 expect(source).toHaveLength(1);expect(journal).toHaveLength(1);
 expect(source[0].values.before).toMatchObject({id:m.source,is_active:true});expect(source[0].values.after).toMatchObject({id:m.source,is_active:false});
 const action=`accounts_merged:${result.mergeRecordId}`;expect(source[0].action).toBe(action);expect(journal[0].action).toBe(action);
 const hash=createHash('sha256').update(canonicalJson({mergeRecordId:result.mergeRecordId,sourceAccountId:m.source,targetAccountId:m.target,movedLinesDigest:result.movedLinesDigest})).digest('hex');
 expect(journal[0].binding_hash).toBe(hash);expect(journal[0].accounting_date).toBe('2026-09-10');
 expect(journal[0].values.before).toMatchObject({header:{id:m.journal},lines:before.map(line=>expect.objectContaining(line))});
 expect(journal[0].values.after).toMatchObject({header:{id:m.journal},lines:after.map(line=>expect.objectContaining(line))});
 expect((journal[0].values.before?.lines as unknown[])).toHaveLength(3);expect((journal[0].values.after?.lines as unknown[])).toHaveLength(3);
 expect(await evidence('gl_account',m.target)).toEqual([]);
 expect(after.map(({gl_account_id:ignored,...row})=>{void ignored;return row;})).toEqual(before.map(({gl_account_id:ignored,...row})=>{void ignored;return row;}));
 expect(after.filter(row=>row.gl_account_id===m.target)).toHaveLength(2);
 const record=(await pool.query('SELECT moved_line_ids,moved_line_ids_digest FROM gl_account_merges WHERE company_id=$1 AND id=$2',[f.companyA,result.mergeRecordId])).rows[0];
 expect(record.moved_line_ids).toEqual(before.filter(row=>row.gl_account_id===m.source).map(row=>row.id));expect(record.moved_line_ids_digest).toBe(result.movedLinesDigest);
});
it('captures every changed descendant and leaves the existing target tree untouched',async()=>{
 const f=glFixture(),m=await mergeFixture('draft'),targetParent=await legacy(),child=await legacy(m.source,2),grandchild=await legacy(child,3),sibling=await legacy(m.target,3);
 await pool.query('UPDATE gl_accounts SET parent_account_id=$3,level=2 WHERE company_id=$1 AND id=$2',[f.companyA,m.target,targetParent]);
 await merge(m.source,m.target);
 expect((await evidence('gl_account',child))[0]?.values.after).toMatchObject({parent_account_id:m.target,level:3});
 expect((await evidence('gl_account',grandchild))[0]?.values.after).toMatchObject({parent_account_id:child,level:4});
 expect(await evidence('gl_account',sibling)).toEqual([]);
});
it('refuses no context, foreign account and revoked shared post authority before changes',async()=>{
 const f=glFixture(),m=await mergeFixture(),foreign=await legacy(null,1,f.companyB),before=await journalRows(m.journal);
 await expect(mergeAccounts(f.companyA,m.source,m.target,f.u1.id)).rejects.toThrow();
 await expect(merge(m.source,foreign)).rejects.toThrow();
 const token=f.u1.tokens[0]!,scopes=(await pool.query('SELECT scopes FROM personal_access_tokens WHERE company_id=$1 AND id=$2',[f.companyA,token.id])).rows[0].scopes;
 await pool.query("UPDATE personal_access_tokens SET scopes=array_remove(scopes,'write:post') WHERE company_id=$1 AND id=$2",[f.companyA,token.id]);
 try{await expect(patMerge(m.source,m.target)).rejects.toThrow();}finally{await pool.query('UPDATE personal_access_tokens SET scopes=$3 WHERE company_id=$1 AND id=$2',[f.companyA,token.id,scopes]);}
 expect(await journalRows(m.journal)).toEqual(before);expect(await evidence('journal_entry',m.journal)).toEqual([]);
});
it('refuses posted closed periods without creating capture or recovery records',async()=>{
 const f=glFixture(),m=await mergeFixture();await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND id=$2",[f.companyA,m.period]);
 try{await expect(merge(m.source,m.target)).rejects.toThrow();expect(await evidence('gl_account',m.source)).toEqual([]);expect(await evidence('journal_entry',m.journal)).toEqual([]);}
 finally{await pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1 AND id=$2",[f.companyA,m.period]);}
});
