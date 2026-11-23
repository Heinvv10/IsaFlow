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
const one = async (s: ToolSession, id = '9', name: string | null = 'Acme', refs: ReadonlyMap<string, string> = new Map()) =>
  (await resolveSuppliers(s, [po(id, name)], refs)).get(id)!;

describe('resolveSuppliers', () => {
  it('a supplier carrying the Sage reference wins, whatever its name, and no name search is made', async () => {
    const { s, calls } = session({ ref: () => ({ found: true, record: { id: 'uuid-1' } }) });
    expect(await one(s)).toEqual({ id: 'uuid-1' });
    expect(calls).toEqual(['find_by_external_ref']);
  });
  it('B6-D (round 6): two live suppliers carrying the Sage reference is supplier_ambiguous, not the first of them', async () => {
    const { s, calls } = session({ ref: () => ({ found: true, record: { id: 'uuid-1' }, other_live: [{ id: 'uuid-2' }] }) });
    expect(await one(s)).toMatchObject({ code: 'supplier_ambiguous', reason: expect.stringMatching(/2 live IsaFlow suppliers carry Sage reference 9.*uuid-1.*uuid-2/) });
    expect(calls).toEqual(['find_by_external_ref']); // no name search is made to break the tie
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
    const r = await resolveSuppliers(s, [po('1', 'A'), po('1', 'A'), po('2', 'B')], new Map());
    expect(r.size).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('F3: a supplier of that name that already carries ANOTHER Sage reference is not matched by name', async () => {
    const { s } = session({ suppliers: () => ({ suppliers: [{ id: 'a', name: 'Acme' }, { id: 'b', name: 'ACME' }], next_offset: null }) });
    // 'a' is Sage supplier 77, not 9: it is a different Sage supplier that happens to share the name. 'b' has no reference.
    expect(await one(s, '9', 'Acme', new Map([['a', '77']]))).toEqual({ id: 'b' });
  });
  it('F3: when every candidate carries another Sage reference, supplier_ref_conflict naming them', async () => {
    const { s } = session({ suppliers: () => ({ suppliers: [{ id: 'a', name: 'Acme' }], next_offset: null }) });
    const r = await one(s, '9', 'Acme', new Map([['a', '77']]));
    expect(r).toMatchObject({ code: 'supplier_ref_conflict' });
    expect((r as { reason: string }).reason).toMatch(/Sage supplier 77/);
  });
  it('F3: a supplier carrying THIS Sage reference found by name is fine; a reference of another system is no conflict', async () => {
    const { s } = session({ suppliers: () => ({ suppliers: [{ id: 'a', name: 'Acme' }], next_offset: null }) });
    expect(await one(s, '9', 'Acme', new Map([['a', '9']]))).toEqual({ id: 'a' });
    expect(await one(s, '9', 'Acme', new Map())).toEqual({ id: 'a' });
  });

  it('L1: two different Sage suppliers that resolve by name to one IsaFlow supplier are BOTH refused supplier_collapsed, naming both ids', async () => {
    const { s } = session({ suppliers: () => ({ suppliers: [{ id: 'u1', name: 'Acme' }], next_offset: null }) });
    const r = await resolveSuppliers(s, [po('77', 'Acme'), po('88', 'ACME'), po('99', 'Other')], new Map());
    for (const id of ['77', '88']) {
      expect(r.get(id)).toMatchObject({ code: 'supplier_collapsed' });
      expect((r.get(id) as { reason: string }).reason).toMatch(/Sage suppliers 77 and 88 .*"Acme".* one IsaFlow supplier u1/);
    }
  });
  it('L1: two Sage ids to one supplier by reference or by one id twice are not a collapse; three ids are all named', async () => {
    const one = session({ suppliers: () => ({ suppliers: [{ id: 'u1', name: 'Acme' }], next_offset: null }) });
    const same = await resolveSuppliers(one.s, [po('77', 'Acme'), po('77', 'Acme')], new Map());
    expect(same.get('77')).toEqual({ id: 'u1' });
    const three = await resolveSuppliers(one.s, [po('1', 'Acme'), po('2', 'Acme'), po('3', 'Acme')], new Map());
    expect((three.get('2') as { reason: string }).reason).toMatch(/Sage suppliers 1, 2 and 3/);
  });
});
