import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {afsSectionHttpFixture} from './afsSectionHttpFixture';
import {signingHarness} from './afsSigningHarness';

vi.mock('@/modules/accounting/services/afs/portalNotificationService',()=>({notifySigningRequested:vi.fn(async()=>undefined),notifyDocumentSignedOff:vi.fn(async()=>undefined)}));

/**
 * A management pack can be sent for signing: the route requires partner_review and nothing else, and a pack reaches
 * partner_review like any document. Its Signum title said "Annual Financial Statements" regardless. The title follows
 * the cover now; an AFS document's title is unchanged.
 */
let h:Awaited<ReturnType<typeof afsSectionHttpFixture>>;
let s:ReturnType<typeof signingHarness>;
beforeAll(async()=>{h=await afsSectionHttpFixture();s=signingHarness(h);},30000);
afterAll(async()=>{vi.restoreAllMocks();await h?.close();});
const companyName=async()=>String((await h.pool.query('SELECT name FROM companies WHERE id=$1',[h.f.companyA])).rows[0].name);

describe('the title a document is sent for signing under',()=>{
 it('an AFS document keeps "Annual Financial Statements — <company>"',async()=>{
  const {doc,contact}=await s.readyToSign();
  await s.send(doc,contact);
  expect(s.titles.at(-1)).toBe(`Annual Financial Statements — ${await companyName()}`);
 });
 it('a management pack is sent as "Management Accounts — <company>", like its cover',async()=>{
  const {doc,contact}=await s.readyToSign();
  await h.pool.query("UPDATE afs_documents SET document_type='management_pack',fiscal_year=NULL,period='2026-06' WHERE company_id=$1 AND id=$2",[h.f.companyA,doc]);
  await s.send(doc,contact);
  expect(s.titles.at(-1)).toBe(`Management Accounts — ${await companyName()}`);
  expect(s.posted.at(-1)).toContain('Management Accounts</h1>');
 });
});
