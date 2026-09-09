import {capturedStorage} from './capturedEvidenceTestStorage';
import { afterAll, beforeAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { withControlRequest, requireControlTx } from '../../../src/modules/accounting/services/controls/context';
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
        grantedScopes: token ? ['write:beneficiaries', 'write:contacts', 'write:bank-tx', 'read:invoices'] : null }, () => fn(requireControlTx()));
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
  await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status,matched_invoice_id) VALUES($1,$2,'synthetic.pdf','pdf','matched',$3)`,[document,company,invoice]);
 await capturedStorage().seed(pool,company,document,bytes);
  const ref = { entityType: 'supplier' as const, entityId: supplier };
  const evidence: EvidenceRef[] = [{ store:'captured',evidenceId:document,entityType:'supplier_invoice',entityId:invoice,version:null,hash }];
  return { ref,evidence,document,invoice };
}

export { actor, source, bank, pool };
export const statusFixture = () => fixture;
