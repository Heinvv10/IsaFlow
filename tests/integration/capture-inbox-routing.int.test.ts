import { SignJWT } from 'jose';
import inboxAddressRoute from '../../pages/api/accounting/capture/inbox-address';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { getOrCreateEmailInbox, generateInboxAddress } from '@/modules/accounting/services/capture/captureInboxService';
import { ingestPostmarkPayload } from '@/modules/accounting/services/capture/inboundEmailService';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

// Storage is a local capture sink; all routing/event/document SQL remains real.
vi.mock('@/lib/supabaseStorage', () => ({
  CAPTURED_DOCS_BUCKET: 'disposable-captured-documents',
  uploadCapturedDocument: async (companyId:string,documentId:string) => ({ bucket:'disposable-captured-documents',path:`${companyId}/${documentId}` }),
}));
assertDisposable();
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const first=crypto.randomUUID();
const second=crypto.randomUUID();
const companies=[first,second];
const userId=crypto.randomUUID();
let token:string;
const migration=readFileSync('scripts/migrations/sql/616_capture_email_address_identity.sql','utf8');
beforeAll(async()=>{
  // Explicit disposable guard above: exercise the pre-upgrade schema, then restore the index.
  await pool.query('DROP INDEX IF EXISTS ux_capture_inboxes_email_address');
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',[first,'Inbox first fixture',second,'Inbox second fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)",[userId,`${userId}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[first,userId]);
  const secret=process.env.JWT_SECRET;
  if(!secret) throw new Error('Disposable JWT_SECRET required');
  token=await new SignJWT({sub:userId,aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(secret));
});
afterAll(async()=>{
  vi.restoreAllMocks();
  try {
    await pool.query('DELETE FROM capture_events WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM captured_documents WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM capture_inboxes WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[]) AND user_id=$2',[companies,userId]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM users WHERE id=$1',[userId]);
  } finally {
    try {await pool.query(migration);} finally {await pool.end();}
  }
});

it('new email address carries128 random bits rather than24',()=>{
  expect(generateInboxAddress(first)).toMatch(/^cap-[a-f0-9]{32}@inbox\.isaflow\.co\.za$/);
});

it('ambiguous legacy destination fails closed before storing an invoice in either company',async()=>{
  const address=`legacy-${crypto.randomUUID()}@inbox.isaflow.co.za`;
  await pool.query(`INSERT INTO capture_inboxes(company_id,channel,address) VALUES($1,'email',$3),($2,'email',$3)`,[first,second,address]);
  const result=await ingestPostmarkPayload({To:address,From:'fixture@example.test',Attachments:[{
    Name:'synthetic.pdf',ContentType:'application/pdf',Content:Buffer.from('%PDF synthetic fixture').toString('base64'),ContentLength:22,
  }]});
  expect(result).toEqual({rejected:'ambiguous inbox'});
  const reviewQuery=readFileSync('docs/audits/remediation/K-004/historical-impact.sql','utf8');
  const review=(await pool.query(reviewQuery,[[first]])).rows;
  expect(review).toHaveLength(1);
  expect(review[0].company_id).toBe(first);
  expect(review[0].normalized_address_collision).toBe(true);
  expect((await pool.query('SELECT 1 FROM captured_documents WHERE company_id=ANY($1::uuid[])',[companies])).rows).toHaveLength(0);
});

it('migration refuses collisions without changing rows, then clean upgrade is idempotent',async()=>{
  const before=(await pool.query('SELECT id FROM capture_inboxes WHERE company_id=ANY($1::uuid[]) ORDER BY id',[companies])).rows;
  await expect(pool.query(migration)).rejects.toThrow('collisions require reviewed remediation');
  expect((await pool.query('SELECT id FROM capture_inboxes WHERE company_id=ANY($1::uuid[]) ORDER BY id',[companies])).rows).toEqual(before);
  await pool.query('DELETE FROM capture_inboxes WHERE company_id=ANY($1::uuid[])',[companies]);
  await pool.query(migration);
  await pool.query(migration);
});

it('retired and case-varied email addresses cannot be reassigned across tenants',async()=>{
  const address=`retired-${crypto.randomUUID()}@inbox.isaflow.co.za`;
  await pool.query("INSERT INTO capture_inboxes(company_id,channel,address,is_active) VALUES($1,'email',$2,false)",[first,address.toUpperCase()]);
  await expect(pool.query("INSERT INTO capture_inboxes(company_id,channel,address) VALUES($1,'email',$2)",[second,address])).rejects.toMatchObject({code:'23505'});
});

it('different companies cannot retain the same generated email address',async()=>{
  const random=vi.spyOn(crypto,'randomBytes');
  // First tenant mint and second tenant first candidate collide; retry differs.
  random.mockImplementationOnce((size:number)=>Buffer.alloc(size,0x11) as never)
    .mockImplementationOnce((size:number)=>Buffer.alloc(size,0x11) as never)
    .mockImplementation((size:number)=>Buffer.alloc(size,0x22) as never);
  try {
    const a=await getOrCreateEmailInbox(first);
    const b=await getOrCreateEmailInbox(second);
    expect(b.address).not.toBe(a.address);
  } finally {random.mockRestore();}
});


it('real authenticated mint retries within its transaction; rotate failure rolls back; ingest stays in the right tenant',async()=>{
  await pool.query('UPDATE capture_inboxes SET is_active=false WHERE company_id=$1',[first]);
  const req=(method:string)=>request({'sb-access-token':token,active_company_id:first},method);
  const random=vi.spyOn(crypto,'randomBytes');
  random.mockImplementationOnce((size:number)=>Buffer.alloc(size,0x22) as never)
    .mockImplementation((size:number)=>Buffer.alloc(size,0x33) as never);
  const minted=response();
  try {await inboxAddressRoute(req('GET'),minted.res);} finally {random.mockRestore();}
  expect(minted.state.statusCode).toBe(200);
  const old=(minted.state.body as {data:{inbox:{address:string}}}).data.inbox.address;
  expect(old).toBe(`cap-${'33'.repeat(16)}@inbox.isaflow.co.za`);
  const stuck=vi.spyOn(crypto,'randomBytes').mockImplementation((size:number)=>Buffer.alloc(size,0x33) as never);
  const failed=response();
  try {await inboxAddressRoute(req('POST'),failed.res);} finally {stuck.mockRestore();}
  expect(failed.state.statusCode).toBe(500);
  expect((await pool.query('SELECT address FROM capture_inboxes WHERE company_id=$1 AND is_active',[first])).rows).toEqual([{address:old}]);
  const rotated=response();
  await inboxAddressRoute(req('POST'),rotated.res);
  expect(rotated.state.statusCode).toBe(200);
  const current=(rotated.state.body as {data:{inbox:{address:string}}}).data.inbox.address;
  expect(current).not.toBe(old);
  const payload={From:'fixture@example.test',Attachments:[{
    Name:'routed.pdf',ContentType:'application/pdf',Content:Buffer.from('%PDF local invoice').toString('base64'),ContentLength:18,
  }]};
  expect(await ingestPostmarkPayload({...payload,To:old})).toEqual({rejected:'no matching inbox'});
  const ingested=await ingestPostmarkPayload({...payload,To:current.toUpperCase()});
  expect('companyId' in ingested && ingested.companyId).toBe(first);
  const rows=(await pool.query('SELECT company_id FROM capture_events WHERE company_id=ANY($1::uuid[])',[companies])).rows;
  expect(rows).toEqual([{company_id:first}]);
});
