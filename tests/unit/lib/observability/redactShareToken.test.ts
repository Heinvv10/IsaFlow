import { describe, it, expect } from 'vitest';
import { redactShareToken, redactTokenParams } from '@/lib/observability/redactShareToken';

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

describe('redactTokenParams', () => {
  it('redacts every key whose NAME contains token, whatever the case', () => {
    expect(redactTokenParams({ token: 'a', share_token: 'b', csrfToken: 'c', type: 'board' }))
      .toEqual({ token: '[token]', share_token: '[token]', csrfToken: '[token]', type: 'board' });
  });

  it('returns the same object when nothing is token-named', () => {
    const q = { type: 'board', from: '2026-08-01' };
    expect(redactTokenParams(q)).toBe(q);
  });

  it('passes an absent query straight through', () => {
    expect(redactTokenParams(undefined)).toBeUndefined();
  });
});
