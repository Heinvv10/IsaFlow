/**
 * Wave 6 EF (QS L2): the EMP501 export names a run left out as not final in X-IsaFlow-Warnings, capped as the
 * e@syFile export caps its header (capWarningsForHeader: a byte budget and a final "… and N more like these." line).
 */
import { describe, expect, it } from 'vitest';
import { emp501WarningsHeader } from '@/../pages/api/payroll/emp501/export';

const warning = (i: number) => `The approved pay run for 2025-${String(i).padStart(2, '0')} (run ${i}) has no approval time `
  + '(approved_at or grandfathered), so it is not final and is not on this EMP501. Reopen it and approve it again.';

describe('emp501WarningsHeader', () => {
  it('no header when there is nothing to say', () => {
    expect(emp501WarningsHeader([])).toBeNull();
  });
  it('a few warnings pass whole', () => {
    const ws = [warning(1), warning(2)];
    expect(JSON.parse(decodeURIComponent(emp501WarningsHeader(ws)!))).toEqual(ws);
  });
  it('forty are cut to the budget with an "… and N more" line counting the rest', () => {
    const ws = Array.from({ length: 40 }, (_, i) => warning(i + 1));
    const header = emp501WarningsHeader(ws)!;
    expect(header.length).toBeLessThanOrEqual(2_000);
    const shown = JSON.parse(decodeURIComponent(header)) as string[];
    const kept = shown.length - 1;
    expect(kept).toBeGreaterThan(0);
    expect(shown.slice(0, kept)).toEqual(ws.slice(0, kept));
    expect(shown[kept]).toBe(`… and ${40 - kept} more like these.`);
  });
});
