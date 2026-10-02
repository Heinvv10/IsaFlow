/**
 * `hour12: false` with `hour: '2-digit'` selects the h24 cycle in some ICU
 * builds (en-US on this host's Node 20 does: "24:15"), so the midnight hour
 * prints as 24. en-ZA is not affected by THIS host's ICU data, which is why
 * the quirk is reproduced here: `Intl.DateTimeFormat` is wrapped so that a
 * caller who asks for `hour12: false` WITHOUT pinning `hourCycle` gets h24,
 * exactly as those builds do. The basis page is an audit anchor; 00:15 is
 * what the clock said.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatPackTimestamp } from '@/modules/accounting/services/packs/pages/packPeriodLabel';

const RealDateTimeFormat = Intl.DateTimeFormat;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatPackTimestamp at midnight', () => {
  it('prints 00:15, not 24:15, on an ICU whose hour12:false means h24', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
      locale?: string | string[], options?: Intl.DateTimeFormatOptions,
    ) {
      const quirky = options && options.hour12 === false && options.hourCycle === undefined
        ? { ...options, hour12: undefined, hourCycle: 'h24' as const }
        : options;
      return new RealDateTimeFormat(locale, quirky);
    } as unknown as typeof Intl.DateTimeFormat);
    // 22:15 UTC on 7 September is 00:15 on 8 September in Johannesburg.
    const printed = formatPackTimestamp('2026-09-07T22:15:00.000Z');
    expect(printed).toBe('8 September 2026 at 00:15 SAST');
  });

  it('prints 00:15 on this host too', () => {
    expect(formatPackTimestamp('2026-09-07T22:15:00.000Z')).toBe('8 September 2026 at 00:15 SAST');
  });
});
