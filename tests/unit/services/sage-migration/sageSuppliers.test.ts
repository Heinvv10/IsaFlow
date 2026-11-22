/** Supplier resolution through the read tools (a fake session answers them): by Sage reference, else exact name; never a guess. */
import { describe, expect, it } from 'vitest';
import { resolveSuppliers } from '@/modules/accounting/services/sage-migration/sageSuppliers';
import type { SagePurchaseOrder } from '@/modules/accounting/services/sage-migration/sageExportTypes';
import type { ToolOutcome, ToolSession } from '@/modules/accounting/services/sage-migration/sageToolSession';

type Row = Record<string, unknown>;
const okOutcome = (body: Row): ToolOutcome => ({ isError: false, text: JSON.stringify(body), body });
const po = (supplierId: string, supplierName: string | null): SagePurchaseOrder => ({ supplierId, supplierName } as SagePurchaseOrder);

function session(handlers: { ref?: (id: string) => Row; suppliers?: (search: string, offset: number) => Row }): { s: ToolSession; calls: string[] } {
  const calls: string[] = [];
  const s: ToolSession = {
    companyId: 'c',
    call: async (name, args) => {
      calls.push(name);
      if (name === 'find_by_external_ref') return okOutcome(handlers.ref?.(String(args.id)) ?? { found: false, record: null });
      return okOutcome(handlers.suppliers?.(String(args.search), Number(args.offset)) ?? { suppliers: [], next_offset: null });
    },
  };
  return { s, calls };
}
const one = async (s: ToolSession, id = '9', name: string | null = 'Acme') => (await resolveSuppliers(s, [po(id, name)])).get(id)!;

describe('resolveSuppliers', () => {
  it('a supplier carrying the Sage reference wins, whatever its name, and no name search is made', async () => {
    const { s, calls } = session({ ref: () => ({ found: true, record: { id: 'uuid-1' } }) });
    expect(await one(s)).toEqual({ id: 'uuid-1' });
    expect(calls).toEqual(['find_by_external_ref']);
  });
  it('otherwise the exact name, case-insensitive and trimmed, among what the search returns', async () => {
    const { s } = session({ suppliers: () => ({ suppliers: [{ id: 'a', name: 'Acme Holdings' }, { id: 'b', name: '  ACME ' }], next_offset: null }) });
    expect(await one(s)).toEqual({ id: 'b' });
  });
  it('no match is supplier_unresolved, two matches supplier_ambiguous, no name given is unresolved', async () => {
    expect(await one(session({}).s)).toMatchObject({ code: 'supplier_unresolved' });
    const two = session({ suppliers: () => ({ suppliers: [{ id: 'a', name: 'Acme' }, { id: 'b', name: 'acme' }], next_offset: null }) });
    expect(await one(two.s)).toMatchObject({ code: 'supplier_ambiguous', reason: expect.stringMatching(/2 IsaFlow suppliers are named "Acme"/) });
    const noName = await one(session({}).s, '9', null);
    expect(noName).toMatchObject({ code: 'supplier_unresolved', reason: expect.stringMatching(/gives no name/) });
  });
  it('follows next_offset across pages and finds the one match on a later page', async () => {
    const pages = [{ suppliers: [{ id: 'a', name: 'Acme Two' }], next_offset: 200 }, { suppliers: [{ id: 'b', name: 'Acme' }], next_offset: null }];
    const { s, calls } = session({ suppliers: (_q, off) => pages[off === 0 ? 0 : 1]! });
    expect(await one(s)).toEqual({ id: 'b' });
    expect(calls.filter((c) => c === 'list_suppliers')).toHaveLength(2);
  });
  it('a search that hits the 1000-row cap is supplier_ambiguous, not a unique match (the rest was never read)', async () => {
    // One exact match on the first page, but the search goes on past the cap: a second match could be beyond it.
    const { s, calls } = session({ suppliers: (_q, off) => ({ suppliers: off === 0 ? [{ id: 'a', name: 'Acme' }] : [], next_offset: off + 200 }) });
    const r = await one(s);
    expect(r).toMatchObject({ code: 'supplier_ambiguous', reason: expect.stringMatching(/more than 1000 suppliers match/) });
    expect(calls.filter((c) => c === 'list_suppliers')).toHaveLength(5);
  });
  it('a cap hit with NO exact match is ambiguous too (it may be beyond the cap), and a failed read is unresolved', async () => {
    const { s } = session({ suppliers: (_q, off) => ({ suppliers: [], next_offset: off + 200 }) });
    expect(await one(s)).toMatchObject({ code: 'supplier_ambiguous' });
    const bad: ToolSession = { companyId: 'c', call: async () => ({ isError: true, text: 'boom', body: null }) };
    expect(await one(bad)).toMatchObject({ code: 'supplier_unresolved', reason: expect.stringMatching(/boom/) });
  });
  it('looks each distinct Sage supplier up once', async () => {
    const { s, calls } = session({ ref: () => ({ found: true, record: { id: 'u' } }) });
    const r = await resolveSuppliers(s, [po('1', 'A'), po('1', 'A'), po('2', 'B')]);
    expect(r.size).toBe(2);
    expect(calls).toHaveLength(2);
  });
});
