import { describe, expect, it } from 'vitest';
import { capWarningsForHeader } from '@/modules/accounting/services/payroll/easyFileWarnings';

const encoded = (w: string[]) => encodeURIComponent(JSON.stringify(w)).length;

describe('capWarningsForHeader', () => {
  it('leaves warnings that fit untouched', () => {
    expect(capWarningsForHeader(['a', 'b'])).toEqual(['a', 'b']);
    expect(capWarningsForHeader([])).toEqual([]);
  });

  it('cuts to the encoded budget, keeping the first warnings and counting what was cut', () => {
    const many = Array.from({ length: 60 }, (_, i) => `SARS directive ${i} is linked to no employee, so it is on no certificate.`);
    const capped = capWarningsForHeader(many);
    expect(encoded(capped)).toBeLessThanOrEqual(2_000);
    expect(capped[0]).toBe(many[0]);
    const kept = capped.length - 1;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(60);
    expect(capped[kept]).toBe(`… and ${60 - kept} more like these.`);
    expect(capped.slice(0, kept)).toEqual(many.slice(0, kept));
  });

  it('one warning too long to fit alone is replaced by the count', () => {
    expect(capWarningsForHeader(['x'.repeat(5_000)])).toEqual(['… and 1 more like these.']);
  });
});
