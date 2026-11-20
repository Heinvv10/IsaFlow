/**
 * #1655: suppliers that exist in Sage were missing in IsaFlow after the Sage
 * import. The commit matched an existing party on LOWER(name) alone, over every
 * row, deleted or not, so:
 *   - a soft-deleted IsaFlow supplier of the same name swallowed the Sage one
 *     (counted "skipped", still invisible);
 *   - two Sage suppliers whose names differ only in case collapsed into one;
 *   - a Sage name with a trailing space was re-created on every re-sync.
 * Through the real commit (commitSageMigration) on a throwaway cluster, in a
 * request transaction as withAuth runs it; the stored rows are read back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { inRequest } from './r035-pr5.helpers';
import { commitSageMigration } from '../../src/modules/admin/services/sageMigrationOrchestrator';
import type { CommitPayload } from '../../src/modules/admin/services/sageMigrationTypes';
import { findSageSupplier } from '../../src/modules/admin/services/sagePartyMatch';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';

beforeAll(async () => { [admin] = await members(pool, tokens, 1); });
afterAll(async () => {
  await pool.query('DELETE FROM customers WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM suppliers WHERE company_id = ANY($1)', [companies]);
  await cleanupEntityChanges(pool, companies, [admin]);
});

const party = (sageId: number, name: string) => ({ name, sageId, email: '', phone: '', vatNumber: '', contactPerson: '' });
const commit = (c: string, pulled: CommitPayload['pulled']) =>
  inRequest(pool, admin, c, () => commitSageMigration({ companyId: c, userId: admin, pulled }));
const live = async (table: 'suppliers' | 'customers', c: string) => (await pool.query(
  `SELECT name, external_system, external_ref FROM ${table} WHERE company_id = $1 AND deleted_at IS NULL ORDER BY external_ref, name`, [c],
)).rows;

describe('the Sage commit brings every Sage supplier across (#1655)', () => {
  it('a soft-deleted IsaFlow supplier of the same name does not swallow the Sage supplier', async () => {
    const c = await newCompany(pool, [[admin, 'admin']], companies);
    await pool.query("INSERT INTO suppliers(company_id, name, deleted_at) VALUES($1, 'Acme Plumbing', now())", [c]);
    const s = await commit(c, { suppliers: { records: [party(101, 'Acme Plumbing')] } });
    expect(s.suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    expect(await live('suppliers', c)).toEqual([{ name: 'Acme Plumbing', external_system: 'sage', external_ref: '101' }]);
  });

  it('two Sage suppliers whose names differ only in case both arrive, and a re-sync adds nothing', async () => {
    const c = await newCompany(pool, [[admin, 'admin']], companies);
    const pulled = { suppliers: { records: [party(201, 'Bolt Hardware'), party(202, 'BOLT HARDWARE')] } };
    expect((await commit(c, pulled)).suppliers).toEqual({ created: 2, skipped: 0, failed: [] });
    expect((await commit(c, pulled)).suppliers).toEqual({ created: 0, skipped: 2, failed: [] });
    expect(await live('suppliers', c)).toEqual([
      { name: 'Bolt Hardware', external_system: 'sage', external_ref: '201' },
      { name: 'BOLT HARDWARE', external_system: 'sage', external_ref: '202' },
    ]);
    // A bill carries Sage's SupplierId, so it lands on its own supplier, not the first of the name.
    const idOf = async (ref: string) => (await pool.query(
      "SELECT id FROM suppliers WHERE company_id = $1 AND external_system = 'sage' AND external_ref = $2", [c, ref])).rows[0].id;
    const found = await inRequest(pool, admin, c, () => findSageSupplier(c, { name: 'Bolt Hardware', sageId: 202 }));
    expect(found).toBe(await idOf('202'));
  });

  it('a name with surrounding spaces matches its trimmed row, so a re-sync does not duplicate it', async () => {
    const c = await newCompany(pool, [[admin, 'admin']], companies);
    await pool.query("INSERT INTO suppliers(company_id, name) VALUES($1, 'Cape Steel')", [c]);
    const s = await commit(c, { suppliers: { records: [{ ...party(301, ' Cape Steel  '), sageId: undefined }] } });
    expect(s.suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect(await live('suppliers', c)).toEqual([{ name: 'Cape Steel', external_system: null, external_ref: null }]);
  });

  it('a supplier keyed in by hand is still matched by name, not duplicated', async () => {
    const c = await newCompany(pool, [[admin, 'admin']], companies);
    await pool.query("INSERT INTO suppliers(company_id, name) VALUES($1, 'Delta Fuel')", [c]);
    expect((await commit(c, { suppliers: { records: [party(401, 'delta fuel')] } })).suppliers)
      .toEqual({ created: 0, skipped: 1, failed: [] });
    // ...and claimed: it now carries the Sage id, so the next sync finds it by id.
    expect(await live('suppliers', c)).toEqual([{ name: 'Delta Fuel', external_system: 'sage', external_ref: '401' }]);
  });

  it('a hand-keyed row is claimed by the first Sage party of its name; a case twin gets its own row', async () => {
    const c = await newCompany(pool, [[admin, 'admin']], companies);
    await pool.query("INSERT INTO suppliers(company_id, name) VALUES($1, 'Fern Logistics')", [c]);
    const pulled = { suppliers: { records: [party(451, 'Fern Logistics'), party(452, 'FERN LOGISTICS')] } };
    expect((await commit(c, pulled)).suppliers).toEqual({ created: 1, skipped: 1, failed: [] });
    expect((await commit(c, pulled)).suppliers).toEqual({ created: 0, skipped: 2, failed: [] });
    expect(await live('suppliers', c)).toEqual([
      { name: 'Fern Logistics', external_system: 'sage', external_ref: '451' },
      { name: 'FERN LOGISTICS', external_system: 'sage', external_ref: '452' },
    ]);
  });

  it('a row already carrying another reference is matched by name but not re-stamped', async () => {
    const c = await newCompany(pool, [[admin, 'admin']], companies);
    await pool.query("INSERT INTO suppliers(company_id, name, external_system, external_ref) VALUES($1, 'Glen Paper', 'xero', 'X-9')", [c]);
    expect((await commit(c, { suppliers: { records: [party(461, 'Glen Paper')] } })).suppliers)
      .toEqual({ created: 0, skipped: 1, failed: [] });
    expect(await live('suppliers', c)).toEqual([{ name: 'Glen Paper', external_system: 'xero', external_ref: 'X-9' }]);
  });

  it('customers take the same rule: a deleted twin and a case twin do not swallow a Sage customer', async () => {
    const c = await newCompany(pool, [[admin, 'admin']], companies);
    await pool.query("INSERT INTO customers(company_id, name, deleted_at) VALUES($1, 'Echo Retail', now())", [c]);
    const s = await commit(c, { customers: { records: [party(501, 'Echo Retail'), party(502, 'ECHO RETAIL')] } });
    expect(s.customers).toEqual({ created: 2, skipped: 0, failed: [] });
    expect(await live('customers', c)).toEqual([
      { name: 'Echo Retail', external_system: 'sage', external_ref: '501' },
      { name: 'ECHO RETAIL', external_system: 'sage', external_ref: '502' },
    ]);
  });
});
