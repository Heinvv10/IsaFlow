import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import clients from '../../pages/api/bureau/clients';
import clientHome from '../../pages/api/bureau/client/[companyId]';
import { createBureauForOwner, linkCompanyToBureau } from '@/modules/bureau/services/bureauService';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ownerId = crypto.randomUUID();
const foreignOwnerId = crypto.randomUUID();
const viewerId = crypto.randomUUID();
const ownCompanyId = crypto.randomUUID();
const foreignCompanyId = crypto.randomUUID();
const customerId = crypto.randomUUID();
let bureauId: string;
let token: string;
let viewerToken: string;
let otherBureauId: string;

beforeAll(async () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Disposable JWT_SECRET required');
  await pool.query(`INSERT INTO users(id,email,role,is_active) VALUES
    ($1,$2,'viewer',true),($3,$4,'viewer',true)`,
    [ownerId, `${ownerId}@test.local`, foreignOwnerId, `${foreignOwnerId}@test.local`]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)",[viewerId,`${viewerId}@test.local`]);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [ownCompanyId,'Owned bureau fixture',foreignCompanyId,'Foreign confidential fixture']);
  await pool.query(`INSERT INTO company_users(company_id,user_id,role) VALUES
    ($1,$2,'admin'),($3,$4,'admin')`,[ownCompanyId,ownerId,foreignCompanyId,foreignOwnerId]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)',[customerId,foreignCompanyId,'Synthetic debtor']);
  await pool.query(`INSERT INTO customer_invoices(company_id,customer_id,invoice_number,subtotal,total_amount,status,created_by)
    VALUES($1,$2,'BUREAU-SECRET',1234,1234,'sent',$3)`,[foreignCompanyId,customerId,foreignOwnerId]);
  bureauId = (await createBureauForOwner({ name: `Bureau ${ownerId}`, ownerUserId: ownerId })).id;
  otherBureauId = (await createBureauForOwner({ name: `Other ${foreignOwnerId}`, ownerUserId: foreignOwnerId })).id;
  await pool.query("INSERT INTO bureau_users(bureau_id,user_id,role) VALUES($1,$2,'viewer')",[bureauId,viewerId]);
  viewerToken = await new SignJWT({ sub:viewerId, aal:'aal2' }).setProtectedHeader({ alg:'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  token = await new SignJWT({ sub: ownerId, aal: 'aal2' }).setProtectedHeader({ alg:'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(secret));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bureau_companies WHERE bureau_id=$1 AND company_id=ANY($2::uuid[])',[bureauId,[ownCompanyId,foreignCompanyId]]);
    await pool.query('DELETE FROM bureau_users WHERE bureau_id=ANY($1::uuid[])',[[bureauId,otherBureauId]]);
    await pool.query('DELETE FROM bureaus WHERE id=$1 AND owner_user_id=$2',[otherBureauId,foreignOwnerId]);
    await pool.query('DELETE FROM bureaus WHERE id=$1 AND owner_user_id=$2',[bureauId,ownerId]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1 AND customer_id=$2',[foreignCompanyId,customerId]);
    await pool.query('DELETE FROM customers WHERE company_id=$1 AND id=$2',[foreignCompanyId,customerId]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[]) AND user_id=ANY($2::text[])',[[ownCompanyId,foreignCompanyId],[ownerId,foreignOwnerId]]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[ownCompanyId,foreignCompanyId]]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])',[[ownerId,foreignOwnerId,viewerId]]);
  } finally { await pool.end(); }
});

async function link(companyId: string) {
  const req = request({ 'sb-access-token': token }, 'POST');
  req.url='/api/bureau/clients';
  req.body={ bureauId,companyId };
  const result=response();
  await clients(req,result.res);
  return result;
}

it('bureau owner cannot link an unrelated company then read its actual financial metrics', async () => {
  const own=await link(ownCompanyId);
  expect(own.state.statusCode).toBe(200);
  const linked=await link(foreignCompanyId);
  const req=request({ 'sb-access-token': token },'GET');
  req.url=`/api/bureau/client/${foreignCompanyId}`;
  req.query={ companyId:foreignCompanyId };
  const read=response();
  await clientHome(req,read.res);
  const body=read.state.body as { data?: { metrics?: { ar?:number } } };
  expect({ linkStatus:linked.state.statusCode, readStatus:read.state.statusCode, leakedAr:body.data?.metrics?.ar })
    .toEqual({ linkStatus:403,readStatus:404,leakedAr:undefined });
  expect((await pool.query('SELECT 1 FROM bureau_companies WHERE bureau_id=$1 AND company_id=$2',[bureauId,foreignCompanyId])).rows).toHaveLength(0);
});

for (const role of ['viewer', 'accountant']) {
  it(`company ${role} cannot authorize a bureau-wide grant`, async () => {
    await pool.query('UPDATE company_users SET role=$1 WHERE company_id=$2 AND user_id=$3',[role,ownCompanyId,ownerId]);
    try {
      expect((await link(ownCompanyId)).state.statusCode).toBe(403);
      expect(await linkCompanyToBureau({ bureauId,companyId:ownCompanyId,addedBy:ownerId })).toBe(false);
    } finally {
      await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[ownCompanyId,ownerId]);
    }
  });
}

it('service requires bureau ownership even when the actor administers the company', async () => {
  expect(await linkCompanyToBureau({ bureauId:otherBureauId,companyId:ownCompanyId,addedBy:ownerId })).toBe(false);
  expect((await pool.query('SELECT 1 FROM bureau_companies WHERE bureau_id=$1 AND company_id=$2',[otherBureauId,ownCompanyId])).rows).toHaveLength(0);
});

it('missing and suspended companies cannot be newly delegated', async () => {
  expect(await linkCompanyToBureau({ bureauId,companyId:crypto.randomUUID(),addedBy:ownerId })).toBe(false);
  await pool.query("UPDATE companies SET status='suspended' WHERE id=$1",[ownCompanyId]);
  try { expect((await link(ownCompanyId)).state.statusCode).toBe(403); }
  finally { await pool.query("UPDATE companies SET status='active' WHERE id=$1",[ownCompanyId]); }
});

it('authorized concurrent link, list, delegated viewer metrics and unlink preserve the full workflow', async () => {
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[foreignCompanyId,ownerId]);
  const results=await Promise.all([link(foreignCompanyId),link(foreignCompanyId)]);
  expect(results.map(r=>r.state.statusCode)).toEqual([200,200]);
  expect((await pool.query('SELECT 1 FROM bureau_companies WHERE bureau_id=$1 AND company_id=$2',[bureauId,foreignCompanyId])).rows).toHaveLength(1);
  const listed=response();
  const listReq=request({ 'sb-access-token':viewerToken },'GET');
  listReq.query={ bureauId };
  await clients(listReq,listed.res);
  const listBody=listed.state.body as { data:{ companies:Array<{companyId:string}> } };
  expect(listBody.data.companies.map(c=>c.companyId)).toContain(foreignCompanyId);
  const readReq=()=>{
    const req=request({ 'sb-access-token':viewerToken },'GET');
    req.query={ companyId:foreignCompanyId };
    return req;
  };
  const read=response();
  await clientHome(readReq(),read.res);
  expect(read.state.statusCode).toBe(200);
  expect((read.state.body as {data:{metrics:{ar:number}}}).data.metrics.ar).toBe(1234);
  const forbidden=request({ 'sb-access-token':viewerToken },'POST');
  forbidden.body={bureauId,companyId:ownCompanyId};
  const denied=response();
  await clients(forbidden,denied.res);
  expect(denied.state.statusCode).toBe(403);
  const unlink=request({ 'sb-access-token':token },'DELETE');
  unlink.body={bureauId,companyId:foreignCompanyId};
  const removed=response();
  await clients(unlink,removed.res);
  expect(removed.state.statusCode).toBe(200);
  const after=response();
  await clientHome(readReq(),after.res);
  expect(after.state.statusCode).toBe(404);
});

it('historical consent review query is read-only and constrained to the supplied company set', async () => {
  await pool.query('DELETE FROM bureau_companies WHERE bureau_id=$1 AND company_id=$2',[bureauId,ownCompanyId]);
  await pool.query('INSERT INTO bureau_companies(bureau_id,company_id,added_by) VALUES($1,$2,$3)',[bureauId,ownCompanyId,viewerId]);
  const query=readFileSync('docs/audits/remediation/K-003/historical-impact.sql','utf8');
  expect((await pool.query(query,[[foreignCompanyId]])).rows).toEqual([]);
  const rows=(await pool.query(query,[[ownCompanyId]])).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].company_id).toBe(ownCompanyId);
  expect(rows[0].added_by).toBe(viewerId);
  expect((await pool.query('SELECT 1 FROM bureau_companies WHERE bureau_id=$1 AND company_id=$2',[bureauId,ownCompanyId])).rows).toHaveLength(1);
});
