import { describe, it, expect } from 'vitest';
import { redactShareToken } from '@/lib/observability/redactShareToken';

const TOKEN = 'A'.repeat(43);

describe('redactShareToken', () => {
  it('redacts a token in a /share/ path segment', () => {
    expect(redactShareToken(`/share/${TOKEN}`)).toBe('/share/[token]');
  });

  it('redacts a token passed as a query parameter', () => {
    expect(redactShareToken(`/api/share?token=${TOKEN}`)).toBe('/api/share?token=[token]');
  });

  it('redacts a full URL with a token and trailing query string', () => {
    expect(redactShareToken(`https://app.isaflow.co.za/share/${TOKEN}?x=1`)).toBe(
      'https://app.isaflow.co.za/share/[token]?x=1'
    );
  });

  it('leaves non-token URLs untouched', () => {
    expect(redactShareToken('/api/accounting/reports/pack?type=board')).toBe(
      '/api/accounting/reports/pack?type=board'
    );
  });

  it('handles empty and undefined-ish input', () => {
    expect(redactShareToken('')).toBe('');
  });
});
