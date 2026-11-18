// The rubric harness's two direct reads look a QA user up by address; during the cutover (slotConfig.loginAliases, follow-up
// drop-legacy-email-grace) an account still on its legacy address must be found, and nothing else.
import { describe, expect, it } from 'vitest';
import { insertApprover, startingCompany, type Queryable } from '../../e2e/rubric/_rubricDb';

function recorder(rows: unknown[] = [{ company_id: 'c1', role: 'admin' }]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows, rowCount: 1 }; } } as unknown as Queryable;
  return { db, calls };
}

describe('rubric DB lookups', () => {
  it('startingCompany matches the requester under the new and the legacy address', async () => {
    const { db, calls } = recorder();
    await startingCompany(db, '0RS Rubric Sandbox x');
    expect(calls[0]!.sql).toMatch(/lower\(u\.email\) = ANY\(\$1::text\[\]\)/);
    expect(calls[0]!.params[0]).toEqual(['reporting-qa@isaflow.co.za', 'reporting-qa@isaflow.dev']);
  });

  it('insertApprover matches the approver under both addresses, in the write and in the read-back', async () => {
    const { db, calls } = recorder();
    await insertApprover(db, { id: '6a1f0000-0000-4000-8000-000000000001', name: '0RS Rubric Sandbox x' });
    const expected = ['reporting-qa-approver@isaflow.co.za', 'reporting-qa-approver@isaflow.dev'];
    expect(calls[0]!.sql).toMatch(/lower\(u\.email\) = ANY\(\$3::text\[\]\)/);
    expect(calls[0]!.params[2]).toEqual(expected);
    expect(calls[1]!.sql).toMatch(/lower\(u\.email\) = ANY\(\$2::text\[\]\)/);
    expect(calls[1]!.params[1]).toEqual(expected);
  });

  it('an address that is not a QA address is matched alone', async () => {
    const { db, calls } = recorder();
    await insertApprover(db, { id: '6a1f0000-0000-4000-8000-000000000001', name: 'n' }, 'someone@example.com');
    expect(calls[0]!.params[2]).toEqual(['someone@example.com']);
  });
});
