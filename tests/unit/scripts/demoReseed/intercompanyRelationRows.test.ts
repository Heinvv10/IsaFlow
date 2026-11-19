/**
 * intercompanyRelationRows turns a missing privilege (42501) or a missing table (42P01) into a Refusal that names the table, and
 * lets every OTHER database error through unchanged: a timeout or a dropped connection is not "this role cannot read it".
 */
import { describe, expect, it } from 'vitest';
import { Refusal } from '../../../../scripts/lib/demoReseed/cli';
import type { Tx } from '../../../../scripts/lib/demoReseed/db';
import { intercompanyRelationRows } from '../../../../scripts/lib/demoReseed/wipe';

const DEMO = '00000000-0000-0000-0000-000000000001';
const failing = (code: string | undefined): Tx => ({
  query: async () => { throw Object.assign(new Error(`driver ${code}`), { code }); },
} as unknown as Tx);

describe('intercompanyRelationRows errors', () => {
  it.each([['42501', /this role cannot read it/], ['42P01', /migration 1000 is not applied/]])('%s becomes a Refusal naming the first table', async (code, why) => {
    const err = await intercompanyRelationRows(failing(code), DEMO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Refusal);
    expect((err as Error).message).toMatch(/cannot check intercompany_connections for the Demo company/);
    expect((err as Error).message).toMatch(why);
  });

  it.each(['57014', '40001', '08006', undefined])('%s is re-thrown as it came (not a Refusal)', async (code) => {
    const err = await intercompanyRelationRows(failing(code), DEMO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(Refusal);
    expect((err as Error).message).toBe(`driver ${code}`);
  });

  it('counts per table and lists only those with rows', async () => {
    const counts: Record<string, number> = { intercompany_connections: 0, intercompany_messages: 3, intercompany_document_links: 0 };
    const tx = {
      query: async (text: string) => {
        const table = Object.keys(counts).find((t) => text.includes(t));
        if (!table) throw new Error(`the guard queried a table this test does not know: ${text}`);
        return [{ n: counts[table] }];
      },
    } as unknown as Tx;
    expect(await intercompanyRelationRows(tx, DEMO)).toEqual([{ table: 'intercompany_messages', n: 3 }]);
  });
});
