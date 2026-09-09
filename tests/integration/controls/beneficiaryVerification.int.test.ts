import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { withControlRequest, requireControlTx } from '../../../src/modules/accounting/services/controls/context';
import { proposeBeneficiaryChange, verifyBeneficiaryChange, getVerifiedBeneficiary, rejectBeneficiaryChange, cancelBeneficiaryChange } from '../../../src/modules/accounting/services/controls/beneficiaryService';
import type { ControlTx, EvidenceRef } from '../../../src/modules/accounting/services/controls/contracts';

const config = fixtureConfigFromEnv(process.env), target = validateFixtureTarget(config);
process.env.DATABASE_URL = target.connectionString;
process.env.DATABASE_SSL = 'disable';
process.env.ENCRYPTION_KEY = 'synthetic-beneficiary-encryption-key-only';
process.env.CONTROL_FINGERPRINT_KEY = 'synthetic-beneficiary-fingerprint-key-only';
const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 4, statement_timeout: 7000 });
let fixture: ForensicFixture;
beforeAll(async () => { fixture = await provisionForensicFixture(config); });
afterAll(async () => { await pool.end(); });
const bank = { bankName: 'Synthetic bank', accountNumber: '00987654321', branchCode: '001234', accountType: 'cheque' };
const oldBank = '00123456789';
async function actor<T>(person: string, fn: (ctx: ControlTx) => Promise<T>, options: { company?: string; pat?: number } = {}): Promise<T> {
  const client = await pool.connect(), companyId = options.company ?? fixture.companyA;
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE app_user');
    const claims = { sub: person, company_id: companyId, role: 'authenticated' };
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)", [JSON.stringify(claims), companyId]);
    const token = options.pat === undefined ? null : fixture.u1.tokens[options.pat]!;
    const result = await withControlRequest({ client, userId: person, companyId, claims },
      { personId: person, companyId, authMethod: token ? 'pat' : 'cookie', connectionId: token?.id, grantId: token?.id,
        grantedScopes: token ? ['write:beneficiaries', 'write:contacts', 'write:bank-tx'] : null }, () => fn(requireControlTx()));
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function source(company = fixture.companyA) {
  const supplier = randomUUID(), invoice = randomUUID(), document = randomUUID();
  const bytes = Buffer.from(`Synthetic bank-confirmation document ${document}`), hash = createHash('sha256').update(bytes).digest('hex');
  await pool.query(`INSERT INTO suppliers(id,company_id,name,bank_name,bank_account_number,bank_branch_code,bank_account_type)
    VALUES($1,$2,'Synthetic beneficiary','Synthetic bank',$3,'001234','cheque')`, [supplier,company,oldBank]);
  await pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,created_by)
    VALUES($1,$2,$3,$4,CURRENT_DATE,$5)`, [invoice,company,supplier,`SYN-${invoice}`,fixture.u1.id]);
  await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status,matched_invoice_id,raw_bytes,raw_bytes_sha256)
    VALUES($1,$2,'synthetic.pdf','pdf','matched',$3,$4,$5)`, [document,company,invoice,bytes,hash]);
  const ref = { entityType: 'supplier' as const, entityId: supplier };
  const evidence: EvidenceRef[] = [{ store:'captured',evidenceId:document,entityType:'supplier_invoice',entityId:invoice,version:null,hash }];
  return { ref,evidence,document,invoice };
}
async function current(id: string) { return (await pool.query('SELECT bank_account_number FROM suppliers WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].bank_account_number; }
it('proposal holds old banking; independent cookie verification activates encrypted version and redacted events', async () => {
  const s = await source();
  await expect(actor(fixture.u1.id, ctx => getVerifiedBeneficiary(ctx,s.ref))).rejects.toThrow('LEGACY_UNVERIFIED');
  const p = await actor(fixture.u1.id,ctx => proposeBeneficiaryChange(ctx,s.ref,bank,s.evidence));
  expect(await current(s.ref.entityId)).toBe(oldBank);
  await expect(actor(fixture.u1.id,ctx => getVerifiedBeneficiary(ctx,s.ref))).rejects.toThrow('PENDING_HOLD');
  await expect(actor(fixture.u1.id,ctx => verifyBeneficiaryChange(ctx,p.proposalId,s.evidence))).rejects.toThrow('INDEPENDENT_PERSON');
  await expect(actor(fixture.u1.id,ctx => verifyBeneficiaryChange(ctx,p.proposalId,s.evidence),{pat:1})).rejects.toThrow('HUMAN_REQUIRED');
  await actor(fixture.u2.id,ctx => verifyBeneficiaryChange(ctx,p.proposalId,s.evidence));
  expect(await current(s.ref.entityId)).toBe(bank.accountNumber);
  const verified = await actor(fixture.u1.id,ctx => getVerifiedBeneficiary(ctx,s.ref));
  expect(verified.details).toEqual(bank); expect(verified.version).toBe(1);
  const proposals = await pool.query('SELECT details_envelope FROM control_beneficiary_proposals WHERE company_id=$1 AND id=$2',[fixture.companyA,p.proposalId]);
  expect(JSON.stringify(proposals.rows)).not.toContain(bank.accountNumber);
  const events = await pool.query('SELECT before_values,after_values,binding_hash FROM control_change_events WHERE company_id=$1 AND entity_id=ANY($2::text[])',[fixture.companyA,[p.proposalId,s.ref.entityId]]);
  expect(events.rows).toHaveLength(3); expect(JSON.stringify(events.rows)).not.toContain(bank.accountNumber);
  expect(JSON.stringify(events.rows)).not.toContain(verified.fingerprint);
});
it('foreign tenant and same-tenant wrong supplier document parents are refused', async () => {
  const s = await source(), wrong = await source(), foreign = await source(fixture.companyB);
  await expect(actor(fixture.u1.id,ctx => proposeBeneficiaryChange(ctx,s.ref,bank,wrong.evidence))).rejects.toThrow('EVIDENCE');
  await expect(actor(fixture.u1.id,ctx => proposeBeneficiaryChange(ctx,s.ref,bank,foreign.evidence))).rejects.toThrow('EVIDENCE');
  await expect(actor(fixture.u3.id,ctx => proposeBeneficiaryChange(ctx,s.ref,bank,s.evidence),{company:fixture.companyB})).rejects.toThrow('NOT_FOUND');
  expect(await current(s.ref.entityId)).toBe(oldBank);
});
it('changed bank material and changed evidence invalidate an outstanding proposal', async () => {
  const s = await source();
  const p = await actor(fixture.u1.id,ctx => proposeBeneficiaryChange(ctx,s.ref,bank,s.evidence));
  await pool.query("UPDATE suppliers SET bank_account_number='00111111111' WHERE company_id=$1 AND id=$2",[fixture.companyA,s.ref.entityId]);
  await expect(actor(fixture.u2.id,ctx => verifyBeneficiaryChange(ctx,p.proposalId,s.evidence))).rejects.toThrow('STALE_PROPOSAL');
  await pool.query('UPDATE suppliers SET bank_account_number=$1 WHERE company_id=$2 AND id=$3',[oldBank,fixture.companyA,s.ref.entityId]);
  await pool.query("UPDATE captured_documents SET raw_bytes=decode('6162','hex') WHERE company_id=$1 AND id=$2",[fixture.companyA,s.document]);
  await expect(actor(fixture.u2.id,ctx => verifyBeneficiaryChange(ctx,p.proposalId,s.evidence))).rejects.toThrow('EVIDENCE');
  expect(await current(s.ref.entityId)).toBe(oldBank);
});
it('revoked requester membership and persisted PAT scopes cannot be approved by another person', async () => {
  const s = await source();
  const token = fixture.u1.tokens[0]!;
  await pool.query("UPDATE personal_access_tokens SET scopes=ARRAY['write:beneficiaries','write:contacts','write:bank-tx'] WHERE company_id=$1 AND id=$2",[fixture.companyA,token.id]);
  const p = await actor(fixture.u1.id,ctx => proposeBeneficiaryChange(ctx,s.ref,bank,s.evidence),{pat:0});
  await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u1.id]);
  try { await expect(actor(fixture.u2.id,ctx => verifyBeneficiaryChange(ctx,p.proposalId,s.evidence))).rejects.toThrow('REQUESTER_REVOKED'); }
  finally { await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u1.id]); }
  await pool.query("UPDATE personal_access_tokens SET scopes=ARRAY['write:contacts'] WHERE company_id=$1 AND id=$2",[fixture.companyA,token.id]);
  await expect(actor(fixture.u2.id,ctx => verifyBeneficiaryChange(ctx,p.proposalId,s.evidence))).rejects.toThrow('REQUESTER_REVOKED');
  expect(await current(s.ref.entityId)).toBe(oldBank);
});
it('two concurrent verifications produce one bank version and one activation', async () => {
  const s = await source(), p = await actor(fixture.u1.id,ctx => proposeBeneficiaryChange(ctx,s.ref,bank,s.evidence));
  const results = await Promise.allSettled([1,2].map(() => actor(fixture.u2.id,ctx => verifyBeneficiaryChange(ctx,p.proposalId,s.evidence))));
  expect(results.filter(r => r.status==='fulfilled')).toHaveLength(1);
  const versions = await pool.query('SELECT version FROM control_beneficiary_versions WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,s.ref.entityId]);
  expect(versions.rows).toHaveLength(1); expect(await current(s.ref.entityId)).toBe(bank.accountNumber);
});
it('outer rollback removes activation, version and required events together', async () => {
  const s = await source(), p = await actor(fixture.u1.id,ctx => proposeBeneficiaryChange(ctx,s.ref,bank,s.evidence));
  await expect(actor(fixture.u2.id,async ctx => {
    await verifyBeneficiaryChange(ctx,p.proposalId,s.evidence); throw new Error('synthetic rollback');
  })).rejects.toThrow('synthetic rollback');
  expect(await current(s.ref.entityId)).toBe(oldBank);
  const versions = await pool.query('SELECT id FROM control_beneficiary_versions WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,s.ref.entityId]);
  expect(versions.rows).toHaveLength(0);
  const proposal = await pool.query('SELECT status FROM control_beneficiary_proposals WHERE company_id=$1 AND id=$2',[fixture.companyA,p.proposalId]);
  expect(proposal.rows[0].status).toBe('pending');
});

it('rejection preserves verified A, permits a new B proposal, and cancellation never activates', async () => {
  const s = await source(), a = await actor(fixture.u1.id,ctx => proposeBeneficiaryChange(ctx,s.ref,bank,s.evidence));
  await actor(fixture.u2.id,ctx => verifyBeneficiaryChange(ctx,a.proposalId,s.evidence));
  const bindingA = await actor(fixture.u1.id,ctx => getVerifiedBeneficiary(ctx,s.ref));
  const bankB = { ...bank, accountNumber:'00888888888' };
  const rejected = await actor(fixture.u1.id,ctx => proposeBeneficiaryChange(ctx,s.ref,bankB,s.evidence));
  await actor(fixture.u2.id,ctx => rejectBeneficiaryChange(ctx,rejected.proposalId,'Bank evidence rejected'));
  expect(await current(s.ref.entityId)).toBe(bank.accountNumber);
  expect((await actor(fixture.u1.id,ctx => getVerifiedBeneficiary(ctx,s.ref))).version).toBe(1);
  await expect(actor(fixture.u2.id,ctx => verifyBeneficiaryChange(ctx,rejected.proposalId,s.evidence))).rejects.toThrow('STALE_PROPOSAL');
  const retry = await actor(fixture.u1.id,ctx => proposeBeneficiaryChange(ctx,s.ref,bankB,s.evidence));
  await actor(fixture.u2.id,ctx => verifyBeneficiaryChange(ctx,retry.proposalId,s.evidence));
  const bindingB = await actor(fixture.u1.id,ctx => getVerifiedBeneficiary(ctx,s.ref));
  expect(bindingB.version).toBe(2); expect(bindingB.fingerprint).not.toBe(bindingA.fingerprint);
  const cancelled = await actor(fixture.u1.id,ctx => proposeBeneficiaryChange(ctx,s.ref,bank,s.evidence));
  await actor(fixture.u1.id,ctx => cancelBeneficiaryChange(ctx,cancelled.proposalId,'Withdraw incorrect request'));
  expect(await current(s.ref.entityId)).toBe(bankB.accountNumber);
  expect((await actor(fixture.u1.id,ctx => getVerifiedBeneficiary(ctx,s.ref))).version).toBe(2);
});
it('serializes empty policy population against a concurrent configured-policy insert', async () => {
  const s = await source(), p = await actor(fixture.u1.id,ctx => proposeBeneficiaryChange(ctx,s.ref,bank,s.evidence));
  const policy = await pool.connect(), policyId = randomUUID();
  let verification: Promise<unknown> | undefined;
  try {
    await policy.query('BEGIN');
    await policy.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`control-policy:${fixture.companyA}`]);
    verification = actor(fixture.u2.id,ctx => verifyBeneficiaryChange(ctx,p.proposalId,s.evidence));
    const settled = verification.then(() => 'activated',() => 'refused');
    const state = await Promise.race([settled,new Promise<string>(resolve => setTimeout(() => resolve('waiting'),200))]);
    expect(state).toBe('waiting');
    await policy.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_operator,approver_role)
      VALUES($1,$2,'Synthetic beneficiary policy','beneficiary','any','admin')`,[policyId,fixture.companyA]);
    await policy.query('COMMIT');
    await expect(verification).rejects.toThrow('CONFIGURED_POLICY_REQUIRES_APPROVAL_FACADE');
    expect(await current(s.ref.entityId)).toBe(oldBank);
  } finally {
    await policy.query('ROLLBACK'); policy.release();
    if (verification) await verification.catch(() => undefined);
    await pool.query('DELETE FROM approval_rules WHERE company_id=$1 AND id=$2',[fixture.companyA,policyId]);
  }
});
