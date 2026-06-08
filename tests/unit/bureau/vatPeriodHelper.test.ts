import { describe, it, expect } from 'vitest';
import { expectedVatPeriodAsOf } from '@/modules/bureau/services/vatPeriodHelper';

describe('expectedVatPeriodAsOf', () => {
  it('odd alignment in June returns the May-ending period', () => {
    const p = expectedVatPeriodAsOf('odd', new Date('2026-06-08T00:00:00Z'));
    expect(p).toEqual({ periodStart: '2026-04-01', periodEnd: '2026-05-31', dueDate: '2026-06-25' });
  });

  it('even alignment in June returns the April-ending period', () => {
    const p = expectedVatPeriodAsOf('even', new Date('2026-06-08T00:00:00Z'));
    expect(p).toEqual({ periodStart: '2026-03-01', periodEnd: '2026-04-30', dueDate: '2026-05-25' });
  });

  it('skips a parity month that has not fully ended yet', () => {
    const p = expectedVatPeriodAsOf('odd', new Date('2026-05-15T00:00:00Z'));
    expect(p).toEqual({ periodStart: '2026-02-01', periodEnd: '2026-03-31', dueDate: '2026-04-25' });
  });

  it('wraps across the year boundary', () => {
    const p = expectedVatPeriodAsOf('odd', new Date('2026-01-10T00:00:00Z'));
    expect(p).toEqual({ periodStart: '2025-10-01', periodEnd: '2025-11-30', dueDate: '2025-12-25' });
  });
});
