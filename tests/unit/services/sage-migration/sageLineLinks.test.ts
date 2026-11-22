/** M1 (round 3): how many PO lines are linked is MEASURED in the books for the POs this run wrote; POs already there are listed, not counted. */
import { describe, expect, it } from 'vitest';
import { buildLineLinks } from '@/modules/accounting/services/sage-migration/sageLineLinks';
import type { MigrationPlan } from '@/modules/accounting/services/sage-migration/sageMigrationPlan';

const po = (sageId: string, n: number, linked: number, notLinked: number) => ({
  sageId, documentNumber: `PO${n}`, totalCents: 1, element: {}, pdfFile: null,
  lineLinks: { linked, notLinked: Array.from({ length: notLinked }, (_, i) => ({ poNumber: `PO${n}`, line: i + 1, itemCode: 'A', reason: 'inactive' as const })) },
});
const plan = (...p: ReturnType<typeof po>[]): MigrationPlan => ({ categories: [], items: [], purchaseOrders: p, refusals: [], lineLinks: { linked: 0, notLinked: [] } });
const before = (refs: string[]) => ({ poTotals: new Map(refs.map((r) => [r, 1] as [string, number])) });

describe('buildLineLinks', () => {
  it('a live run counts the linked lines found in the books for the POs it wrote, not what the plan hoped', () => {
    const r = buildLineLinks(plan(po('1', 1, 2, 0), po('2', 2, 3, 0)), before([]), { poLinkedLines: new Map([['1', 2], ['2', 0]]) });
    expect(r).toMatchObject({ linked: 2, basis: 'booked', alreadyThere: [] });
  });
  it('POs already in the books are listed as already there and add nothing to linked or not linked', () => {
    const r = buildLineLinks(plan(po('1', 1, 2, 1), po('2', 2, 3, 2)), before(['2']), { poLinkedLines: new Map([['1', 2], ['2', 3]]) });
    expect(r.alreadyThere).toEqual(['PO2']);
    expect(r.linked).toBe(2);
    expect(r.notLinked.map((x) => x.poNumber)).toEqual(['PO1']);
  });
  it('a dry run reports what the plan would link for the POs it would create, labelled planned', () => {
    const r = buildLineLinks(plan(po('1', 1, 2, 0), po('2', 2, 3, 0)), before(['2']), null);
    expect(r).toMatchObject({ linked: 2, basis: 'planned', alreadyThere: ['PO2'] });
  });
  it('a PO the run was to write but is not in the books after counts 0', () => {
    expect(buildLineLinks(plan(po('1', 1, 4, 0)), before([]), { poLinkedLines: new Map() }).linked).toBe(0);
  });
});
