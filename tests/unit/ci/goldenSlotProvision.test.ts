// Resetting a slot retires its company by renaming it, never by deleting, and picks the first free generation.
import { describe, expect, it } from 'vitest';
import type { ClientBase } from 'pg';
import { ensureCompany, ensureUser, resolveSlotCompanyId, retireSlotCompany } from '../../../scripts/ci/golden/slotProvision';
import { MAX_SLOT_GENERATION, SOURCE_COMPANY_ID, slotCompanyId } from '../../../scripts/ci/golden/slotConfig';

function fakeDb(existing: string[]): { db: ClientBase; statements: Array<{ text: string; params: unknown[] }> } {
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const db = {
    query: async (text: string, params: unknown[] = []) => {
      statements.push({ text, params });
      if (text.startsWith('SELECT 1 FROM companies')) return { rowCount: existing.includes(String(params[0])) ? 1 : 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  };
  return { db: db as unknown as ClientBase, statements };
}

describe('retireSlotCompany', () => {
  it('renames the current company, deletes nothing, and returns the first unused generation', async () => {
    const { db, statements } = fakeDb([slotCompanyId(2, 0), slotCompanyId(2, 1)]);
    const next = await retireSlotCompany(db, 2, slotCompanyId(2, 0));
    expect(next).toEqual({ generation: 2, id: slotCompanyId(2, 2) });
    const update = statements.find((s) => s.text.startsWith('UPDATE companies'))!;
    expect(update.params[0]).toBe(slotCompanyId(2, 0));
    expect(String(update.params[1])).toMatch(/^RETIRED \d{4}-\d{2}-\d{2} slot 2 .*generation 2/);
    expect(statements.some((s) => /DELETE/i.test(s.text))).toBe(false);
  });

  it('stops the retired company being a demo company, so a spec that looks one up never lands on it', async () => {
    const { db, statements } = fakeDb([slotCompanyId(1, 0)]);
    await retireSlotCompany(db, 1, slotCompanyId(1, 0));
    const update = statements.find((s) => s.text.startsWith('UPDATE companies'))!;
    expect(update.text).toMatch(/is_demo\s*=\s*false/);
    expect(update.params[0]).toBe(slotCompanyId(1, 0));
  });

  it('refuses when every generation is used, before renaming anything', async () => {
    const all = Array.from({ length: MAX_SLOT_GENERATION }, (_, i) => slotCompanyId(1, i + 1));
    const { db, statements } = fakeDb(all);
    await expect(retireSlotCompany(db, 1, slotCompanyId(1, 9))).rejects.toThrow(/all 9 generations/);
    expect(statements.some((s) => s.text.startsWith('UPDATE'))).toBe(false);
  });
});

describe('ensureCompany', () => {
  it('refuses a company that was retired, and writes nothing: the rename must not bring it back', async () => {
    const statements: string[] = [];
    const db = {
      query: async (text: string) => {
        statements.push(text);
        if (text.startsWith('SELECT name FROM companies')) return { rowCount: 1, rows: [{ name: 'RETIRED 2026-10-29 slot 2 (poisoned, replaced by generation 1)' }] };
        return { rowCount: 1, rows: [] };
      },
    } as unknown as ClientBase;
    await expect(ensureCompany(db, 2, slotCompanyId(2, 0), 0)).rejects.toThrow(/company 601d0000-0000-4000-8000-000000000002 is retired.*GOLDEN_SLOT_2_COMPANY_ID/);
    expect(statements).toHaveLength(1);
  });
});

describe('resolveSlotCompanyId', () => {
  it('recovers the live generation when the env company key is missing or malformed', async () => {
    const active = slotCompanyId(2, 3);
    const db = {
      query: async () => ({
        rowCount: 2,
        rows: [
          { id: slotCompanyId(2, 0), name: 'RETIRED 2026-10-29 slot 2 (poisoned, replaced by generation 3)' },
          { id: active, name: 'Golden Slot 2 g3' },
        ],
      }),
    } as unknown as ClientBase;
    await expect(resolveSlotCompanyId(db, 2, 'damaged-env-value')).resolves.toBe(active);
  });

  it('uses generation zero only when no slot company exists yet', async () => {
    const db = { query: async () => ({ rowCount: 0, rows: [] }) } as unknown as ClientBase;
    await expect(resolveSlotCompanyId(db, 1, undefined)).resolves.toBe(slotCompanyId(1, 0));
  });

  it('fails closed when more than one generation is live', async () => {
    const db = {
      query: async () => ({
        rowCount: 2,
        rows: [
          { id: slotCompanyId(3, 1), name: 'Golden Slot 3 g1' },
          { id: slotCompanyId(3, 2), name: 'Golden Slot 3 g2' },
        ],
      }),
    } as unknown as ClientBase;
    await expect(resolveSlotCompanyId(db, 3, undefined)).rejects.toThrow(/multiple live generations/);
  });

  it('still refuses a well-formed company id belonging to another slot', async () => {
    const db = { query: async () => { throw new Error('must not query'); } } as unknown as ClientBase;
    await expect(resolveSlotCompanyId(db, 2, slotCompanyId(3, 1))).rejects.toThrow(/refusing company id/);
  });
});

describe('a company that is not the slot\'s own is never touched', () => {
  const stray = [SOURCE_COMPANY_ID, 'd27bac33-1111-4222-8333-444455556666', slotCompanyId(3, 0)];

  it.each(stray)('retireSlotCompany refuses %s without a statement', async (id) => {
    const { db, statements } = fakeDb([id]);
    await expect(retireSlotCompany(db, 2, id)).rejects.toThrow(/refusing company id/);
    expect(statements).toEqual([]);
  });

  it.each(stray)('ensureCompany refuses %s without a statement', async (id) => {
    const { db, statements } = fakeDb([id]);
    await expect(ensureCompany(db, 2, id, 0)).rejects.toThrow(/refusing company id/);
    expect(statements).toEqual([]);
  });

  it.each(stray)('ensureUser refuses %s without a statement', async (id) => {
    const { db, statements } = fakeDb([id]);
    await expect(ensureUser(db, 2, id, 'user-1')).rejects.toThrow(/refusing company id/);
    expect(statements).toEqual([]);
  });
});

describe('retireSlotCompany on a company that is already retired', () => {
  it('refuses, and burns no generation: nothing is renamed and no generation is probed', async () => {
    const statements: string[] = [];
    const db = {
      query: async (text: string) => {
        statements.push(text);
        if (text.startsWith('SELECT name FROM companies')) return { rowCount: 1, rows: [{ name: 'RETIRED 2026-10-29 slot 2 (poisoned, replaced by generation 1)' }] };
        return { rowCount: 0, rows: [] };
      },
    } as unknown as ClientBase;
    await expect(retireSlotCompany(db, 2, slotCompanyId(2, 0))).rejects.toThrow(/already retired.*GOLDEN_SLOT_2_COMPANY_ID/);
    expect(statements).toEqual(['SELECT name FROM companies WHERE id = $1::uuid']);
  });
});
