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
    expect(out!.request!.query_string).toBe('email=[REDACTED]&token=[REDACTED]&company_id=[REDACTED]');
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
    expect(data.safe).toBe('[REDACTED]');
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
    expect(out!.request!.query_string as string).toContain('safe=[REDACTED]');
  });

  it('redacts a share token out of request.url', () => {
    const token = 'A'.repeat(43);
    const event: Event = {
      request: { url: `https://app.isaflow.co.za/share/${token}?x=1` },
    };
    const out = scrubEvent(event);
    expect(out!.request!.url).toBe(`https://app.isaflow.co.za/share/[token]?x=[REDACTED]`);
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
  // Sentry's ui.click / ui.input breadcrumbs describe the clicked element as a selector that carries its
  // aria-label, title and alt verbatim (@sentry/core utils/browser.js _htmlElementAsString). Grid controls
  // are named after their row ("Select 01 Jun 2026 PAYMENT TO J SMITH −R 1 234.50") and a note button's
  // title is the note itself, so those values are customer data and never leave the browser. Values are written
  // unescaped and can hold any terminator (`"]`, `[type="text"]`, ` > b.`), so nothing tries to find where one
  // ends: from the first `[attr="` to the end of the message is gone.
  const SMITH = /SMITH|0123456789|1 234|Thabo/;
  const scrubMsg = (message: string, category = 'ui.click') =>
    scrubEvent({ breadcrumbs: [{ category, message }] } as Event)!.breadcrumbs![0]!.message;

  it('keeps the element path and the first attribute name; the value and all that follows is [REDACTED]', () => {
    expect(scrubMsg('td > input.accent-teal-500[aria-label="Select 01 Jun 2026 PAYMENT TO J SMITH −R 1 234.50"][type="checkbox"]'))
      .toBe('td > input.accent-teal-500[aria-label="[REDACTED]"]');
    expect(scrubMsg('td > button.text-xs[aria-label="Note, X: paid [cash] to Thabo"][title="paid [cash] to Thabo"]'))
      .toBe('td > button.text-xs[aria-label="[REDACTED]"]');
    expect(scrubMsg('div > img[alt="ID of J Smith"] > input[name="search"]')).toBe('div > img[alt="[REDACTED]"]');
  });

  it('a selector with no attributes is untouched', () => {
    expect(scrubMsg('div#root > main.content > button.btn-primary')).toBe('div#root > main.content > button.btn-primary');
    expect(scrubMsg('div.w-[calc(100%-2px)] > span')).toBe('div.w-[calc(100%-2px)] > span');
  });

  it('leaves a message that is not a selector alone, in any category', () => {
    expect(scrubMsg('checkout started', 'custom')).toBe('checkout started');
    expect(scrubMsg('clicked button')).toBe('clicked button');
  });

  it('redacts a selector in a breadcrumb of any category, not only ui.*', () => {
    expect(scrubMsg('saved via button[aria-label="Accept J SMITH"]', 'custom')).toBe('saved via button[aria-label="[REDACTED]"]');
  });

  it('a value holding `"]` leaks nothing after it', () => {
    const out = scrubMsg('div#root > button[aria-label="Accept, 01 Jun 2026 ACME"] J SMITH 0123456789 ref −R 1 234.50"][title="Accept"]')!;
    expect(out).toBe('div#root > button[aria-label="[REDACTED]"]');
    expect(out).not.toMatch(SMITH);
  });

  it('a value holding `[type="text"]` leaks nothing after it', () => {
    const out = scrubMsg('input[aria-label="Select X[type="text"] J SMITH 0123456789"][type="checkbox"]')!;
    expect(out).toBe('input[aria-label="[REDACTED]"]');
    expect(out).not.toMatch(SMITH);
  });

  it('a value holding " > b." (a fake next element) leaks nothing after it', () => {
    const out = scrubMsg('div > button[aria-label="Z > b.J SMITH 0123456789"][title="t"]')!;
    expect(out).toBe('div > button[aria-label="[REDACTED]"]');
    expect(out).not.toMatch(SMITH);
  });

  it('a value holding " > Word > " leaks nothing after it', () => {
    const out = scrubMsg('div > button[aria-label="Pay > Thabo > J SMITH 0123456789"] > span.icon')!;
    expect(out).toBe('div > button[aria-label="[REDACTED]"]');
    expect(out).not.toMatch(SMITH);
  });

  it('every attribute counts, not only aria-label, title and alt', () => {
    expect(scrubMsg('input[name="payee J SMITH"]')).toBe('input[name="[REDACTED]"]');
    expect(scrubMsg('tr[data-row-label="ACME 0123456789"]')).toBe('tr[data-row-label="[REDACTED]"]');
    expect(scrubMsg('input[type="J SMITH"]')).toBe('input[type="[REDACTED]"]');
  });

  it('scrubbing a scrubbed selector changes nothing', () => {
    const once = scrubMsg('a > button[aria-label="x"][type="button"]');
    expect(scrubMsg(once!)).toBe(once);
  });

  it('drops the text and arguments of console breadcrumbs: they hold whatever the app logged', () => {
    const event: Event = {
      breadcrumbs: [{ category: 'console', level: 'warning', message: 'Payment to J SMITH 0123456789 failed', data: { arguments: ['J SMITH', { acct: '0123456789' }], logger: 'console' } }],
    };
    const crumb = scrubEvent(event)!.breadcrumbs![0]!;
    expect(crumb.message).toBe('[REDACTED]');
    expect(crumb.data).toEqual({ logger: 'console' });
    expect(crumb.level).toBe('warning');
    expect(JSON.stringify(crumb)).not.toMatch(/SMITH|0123456789/);
  });
});
