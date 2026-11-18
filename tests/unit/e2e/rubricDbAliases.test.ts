// The rubric harness's two direct reads look a QA user up by address; during the cutover (slotConfig.loginAliases, follow-up
// drop-legacy-email-grace) an account still on its legacy address must be found, and nothing else.
import { describe, expect, it } from 'vitest';
import { insertApprover, startingCompany, type Queryable } from '../../e2e/rubric/_rubricDb';

/** `userCount` users match the address aliases; the other statements answer like a healthy database. */
function recorder(userCount = 1) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/^\s*SELECT id::text AS id FROM users/.test(sql)) return { rows: Array.from({ length: userCount }, (_, i) => ({ id: `u${i}` })), rowCount: userCount };
      return { rows: [{ company_id: 'c1', role: 'admin' }], rowCount: 1 };
    },
  } as unknown as Queryable;
  return { db, calls };
}
const writes = (calls: Array<{ sql: string }>) => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/i.test(c.sql));

describe('rubric DB lookups', () => {
  it('startingCompany matches the requester under the new and the legacy address', async () => {
    const { db, calls } = recorder();
    await startingCompany(db, '0RS Rubric Sandbox x');
    expect(calls[1]!.sql).toMatch(/lower\(u\.email\) = ANY\(\$1::text\[\]\)/);
    expect(calls[1]!.params[0]).toEqual(['reporting-qa@isaflow.co.za', 'reporting-qa@isaflow.dev']);
  });

  it('insertApprover matches the approver under both addresses, in the write and in the read-back', async () => {
    const { db, calls } = recorder();
    await insertApprover(db, { id: '6a1f0000-0000-4000-8000-000000000001', name: '0RS Rubric Sandbox x' });
    const expected = ['reporting-qa-approver@isaflow.co.za', 'reporting-qa-approver@isaflow.dev'];
    expect(calls[1]!.sql).toMatch(/lower\(u\.email\) = ANY\(\$3::text\[\]\)/);
    expect(calls[1]!.params[2]).toEqual(expected);
    expect(calls[2]!.sql).toMatch(/lower\(u\.email\) = ANY\(\$2::text\[\]\)/);
    expect(calls[2]!.params[1]).toEqual(expected);
  });

  it('an address that is not a QA address is matched alone', async () => {
    const { db, calls } = recorder();
    await insertApprover(db, { id: '6a1f0000-0000-4000-8000-000000000001', name: 'n' }, 'someone@example.com');
    expect(calls[1]!.params[2]).toEqual(['someone@example.com']);
  });

  describe('exactly one user must match the aliases', () => {
    it('insertApprover refuses two matching users (a stranger on the legacy address) and writes nothing', async () => {
      const { db, calls } = recorder(2);
      await expect(insertApprover(db, { id: '6a1f0000-0000-4000-8000-000000000001', name: 'n' })).rejects.toThrow(/2 users match/);
      expect(writes(calls)).toEqual([]);
    });

    it('startingCompany refuses two matching users', async () => {
      const { db, calls } = recorder(2);
      await expect(startingCompany(db, 'n')).rejects.toThrow(/2 users match/);
      expect(calls.length).toBe(1);
    });

    it('both refuse when no user matches', async () => {
      await expect(insertApprover(recorder(0).db, { id: '6a1f0000-0000-4000-8000-000000000001', name: 'n' })).rejects.toThrow(/no user matches/);
      await expect(startingCompany(recorder(0).db, 'n')).rejects.toThrow(/no user matches/);
    });

    it('one match passes', async () => {
      await expect(startingCompany(recorder(1).db, 'n')).resolves.toBe('c1');
    });
  });
});
