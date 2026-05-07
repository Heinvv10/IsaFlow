import { describe, expect, it } from 'vitest';
import { getDailyLoginQuote, LOGIN_QUOTES } from '@/lib/auth/loginQuotes';

describe('getDailyLoginQuote', () => {
  it('returns the same quote for the same local date', () => {
    const morning = new Date(2026, 4, 7, 8, 30);
    const evening = new Date(2026, 4, 7, 18, 45);

    expect(getDailyLoginQuote(morning)).toEqual(getDailyLoginQuote(evening));
  });

  it('rotates deterministically on consecutive local days', () => {
    const firstDay = new Date(2026, 0, 1);
    const secondDay = new Date(2026, 0, 2);

    const firstQuote = getDailyLoginQuote(firstDay);
    const secondQuote = getDailyLoginQuote(secondDay);

    expect(LOGIN_QUOTES.indexOf(secondQuote)).toBe((LOGIN_QUOTES.indexOf(firstQuote) + 1) % LOGIN_QUOTES.length);
  });

  it('wraps after the quote list length', () => {
    const firstDay = new Date(2026, 0, 1);
    const wrappedDay = new Date(2026, 0, 1 + LOGIN_QUOTES.length);

    expect(getDailyLoginQuote(wrappedDay)).toEqual(getDailyLoginQuote(firstDay));
  });
});
