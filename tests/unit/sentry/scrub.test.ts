// tests/unit/sentry/scrub.test.ts
import { describe, it, expect } from 'vitest';
import { scrubEvent } from '@/lib/sentry/scrub';
import type { Event } from '@sentry/nextjs';

describe('scrubEvent', () => {
  it('redacts password/token/secret keys in request data', () => {
    const event: Event = {
      request: {
        data: { email: 'foo@bar.com', password: 'hunter2', csrf_token: 'abc', otp: '123456' },
      },
    };
    const out = scrubEvent(event);
    const data = out!.request!.data as Record<string, unknown>;
    expect(data.password).toBe('[REDACTED]');
    expect(data.csrf_token).toBe('[REDACTED]');
    expect(data.otp).toBe('[REDACTED]');
    expect(data.email).toMatch(/^[a-f0-9]{8}@bar\.com$/);
  });

  it('redacts bank/iban/account_number keys', () => {
    const event: Event = {
      request: {
        data: { bank_account_number: '1234567890', iban: 'GB82WEST', account_number: '9999' },
      },
    };
    const out = scrubEvent(event);
    const data = out!.request!.data as Record<string, unknown>;
    expect(data.bank_account_number).toBe('[REDACTED]');
    expect(data.iban).toBe('[REDACTED]');
    expect(data.account_number).toBe('[REDACTED]');
  });

  it('drops cookie, authorization, x-csrf-token headers', () => {
    const event: Event = {
      request: {
        headers: {
          cookie: 'session=xxx',
          authorization: 'Bearer zzz',
          'x-csrf-token': 'yyy',
          'user-agent': 'Mozilla/5.0',
        },
      },
    };
    const out = scrubEvent(event);
    const headers = out!.request!.headers as Record<string, string>;
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-csrf-token']).toBeUndefined();
    expect(headers['user-agent']).toBe('Mozilla/5.0');
  });

  it('redacts sensitive keys inside query strings', () => {
    const event: Event = {
      request: {
        query_string: 'email=a@b.com&token=secret123&company_id=uuid',
      },
    };
    const out = scrubEvent(event);
    expect(out!.request!.query_string).toBe('email=a@b.com&token=[REDACTED]&company_id=uuid');
  });

  it('hashes local-part of request.data.email', () => {
    const event: Event = {
      request: { data: { email: 'hein@velocityfibre.co.za' } },
    };
    const out = scrubEvent(event);
    const email = (out!.request!.data as Record<string, string>).email;
    expect(email).toMatch(/^[a-f0-9]{8}@velocityfibre\.co\.za$/);
  });

  it('returns null when given null (drops the event)', () => {
    expect(scrubEvent(null as unknown as Event)).toBeNull();
  });

  it('is idempotent on already-scrubbed events', () => {
    const event: Event = { request: { data: { password: 'hunter2' } } };
    const once = scrubEvent(event);
    const twice = scrubEvent(once!);
    expect((twice!.request!.data as Record<string, string>).password).toBe('[REDACTED]');
  });

  it('handles circular references in request.data without throwing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a: any = { safe: 'ok' };
    a.self = a;
    const event: Event = { request: { data: a } };
    let out: Event | null;
    expect(() => { out = scrubEvent(event); }).not.toThrow();
    const data = out!.request!.data as Record<string, unknown>;
    expect(data.safe).toBe('ok');
    expect(data.self).toBe('[CIRCULAR]');
  });

  it('redacts URL-encoded sensitive keys in query strings', () => {
    const event: Event = {
      request: {
        query_string: 'bank%5Faccount%5Fnumber=12345&safe=ok',
      },
    };
    const out = scrubEvent(event);
    expect(out!.request!.query_string as string).toContain('[REDACTED]');
    expect(out!.request!.query_string as string).toContain('safe=ok');
  });

  it('redacts a share token out of request.url', () => {
    const token = 'A'.repeat(43);
    const event: Event = {
      request: { url: `https://app.isaflow.co.za/share/${token}?x=1` },
    };
    const out = scrubEvent(event);
    expect(out!.request!.url).toBe(`https://app.isaflow.co.za/share/[token]?x=1`);
    expect(out!.request!.url).not.toContain(token);
  });

  it('redacts a share token out of event.transaction', () => {
    const token = 'A'.repeat(43);
    const event: Event = { transaction: `/share/${token}` };
    const out = scrubEvent(event);
    expect(out!.transaction).toBe('/share/[token]');
    expect(out!.transaction).not.toContain(token);
  });

  it('redacts a share token out of breadcrumb data.url', () => {
    const token = 'A'.repeat(43);
    const event: Event = {
      breadcrumbs: [
        { category: 'fetch', data: { url: `/share/${token}`, method: 'GET' } },
        { category: 'ui.click', message: 'clicked button' },
      ],
    };
    const out = scrubEvent(event);
    const [fetchCrumb, uiCrumb] = out!.breadcrumbs!;
    expect(fetchCrumb.data!.url).toBe('/share/[token]');
    expect(fetchCrumb.data!.method).toBe('GET');
    expect(JSON.stringify(fetchCrumb)).not.toContain(token);
    expect(uiCrumb.message).toBe('clicked button');
  });
});
