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
    expect(data.email).toBe('foo@bar.com');
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
    expect(out!.request!.query_string).toBe('email=a@b.com&token=%5BREDACTED%5D&company_id=uuid');
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
});
