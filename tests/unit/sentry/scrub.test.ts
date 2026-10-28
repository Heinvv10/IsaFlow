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
  // Sentry's ui.click / ui.input breadcrumbs describe the clicked element as a selector that carries its
  // aria-label, title and alt verbatim (@sentry/core utils/browser.js _htmlElementAsString). Grid controls
  // are named after their row ("Select 01 Jun 2026 PAYMENT TO J SMITH −R 1 234.50") and a note button's
  // title is the note itself, so those values are customer data and never leave the browser.
  it('redacts aria-label, title and alt out of ui.* breadcrumb messages, keeping the selector', () => {
    const event: Event = {
      breadcrumbs: [
        { category: 'ui.click', message: 'td > input.accent-teal-500[aria-label="Select 01 Jun 2026 PAYMENT TO J SMITH −R 1 234.50"][type="checkbox"]' },
        { category: 'ui.click', message: 'td > button.text-xs[aria-label="Note, 01 Jun 2026 X R 1.00: paid [cash] to Thabo"][title="paid [cash] to Thabo"]' },
        { category: 'ui.input', message: 'div > img[alt="ID of J Smith"] > input[name="search"]' },
      ],
    };
    const [a, b, c] = scrubEvent(event)!.breadcrumbs!;
    expect(a!.message).toBe('td > input.accent-teal-500[aria-label="[REDACTED]"][type="checkbox"]');
    // an unterminated-looking value cannot be told from one that holds `"]`, so the run swallows what follows it
    expect(b!.message).toBe('td > button.text-xs[aria-label="[REDACTED]"]');
    expect(c!.message).toBe('div > img[alt="[REDACTED]"] > input[name="[REDACTED]"]');
    expect(JSON.stringify(scrubEvent(event))).not.toMatch(/SMITH|Thabo/);
  });

  it('leaves a message that is not a selector alone, in any category', () => {
    const event: Event = { breadcrumbs: [{ category: 'custom', message: 'checkout started' }, { category: 'ui.click', message: 'clicked button' }] };
    expect(scrubEvent(event)!.breadcrumbs!.map(c => c.message)).toEqual(['checkout started', 'clicked button']);
  });

  it('redacts a selector in a breadcrumb of any category, not only ui.*', () => {
    const event: Event = { breadcrumbs: [{ category: 'custom', message: 'saved via button[aria-label="Accept J SMITH"]' }] };
    expect(scrubEvent(event)!.breadcrumbs![0]!.message).toBe('saved via button[aria-label="[REDACTED]"]');
  });

  // Sentry writes attribute values unescaped, so a value can hold `"]`. The first `"]` is not the end of it.
  it('a value holding `"]` leaks nothing after it', () => {
    const event: Event = {
      breadcrumbs: [{ category: 'ui.click', message: 'div#root > button[aria-label="Accept, 01 Jun 2026 ACME"] J SMITH 0123456789 ref −R 1 234.50"][title="Accept"]' }],
    };
    const out = scrubEvent(event)!.breadcrumbs![0]!.message!;
    expect(out).toBe('div#root > button[aria-label="[REDACTED]"]');
    expect(out).not.toMatch(/SMITH|0123456789|1 234/);
  });

  it('a value holding " > " does not end the run early; the next element still shows', () => {
    const event: Event = { breadcrumbs: [{ category: 'ui.click', message: 'div > button[aria-label="Pay > J SMITH 99"] > span.icon' }] };
    expect(scrubEvent(event)!.breadcrumbs![0]!.message).toBe('div > button[aria-label="[REDACTED]"] > span.icon');
  });

  it('redacts every attribute value (name, serializeAttribute ones), keeping only a known input type', () => {
    const event: Event = {
      breadcrumbs: [
        { category: 'ui.input', message: 'input[name="payee J SMITH"][type="text"]' },
        { category: 'ui.click', message: 'tr[data-row-label="ACME 0123456789"]' },
        { category: 'ui.click', message: 'input[type="J SMITH"]' },
        { category: 'ui.click', message: 'input[aria-label="Select ACME"][type="checkbox"]' },
      ],
    };
    expect(scrubEvent(event)!.breadcrumbs!.map(c => c.message)).toEqual([
      'input[name="[REDACTED]"][type="text"]',
      'tr[data-row-label="[REDACTED]"]',
      'input[type="[REDACTED]"]',
      'input[aria-label="[REDACTED]"][type="checkbox"]',
    ]);
  });

  it('scrubbing a scrubbed selector changes nothing', () => {
    const once = scrubEvent({ breadcrumbs: [{ category: 'ui.click', message: 'a > button[aria-label="x"][type="button"]' }] })!;
    const twice = scrubEvent(JSON.parse(JSON.stringify(once)) as Event)!;
    expect(twice.breadcrumbs![0]!.message).toBe(once.breadcrumbs![0]!.message);
  });

  // The bank transactions page puts search text and amounts in the query of its fetch calls.
  it('redacts query VALUES in fetch/xhr breadcrumb urls, keeping the keys and the path', () => {
    const event: Event = {
      breadcrumbs: [
        { category: 'fetch', data: { url: '/api/accounting/bank-transactions?bank_account_id=b1&search=J%20Smith&from_amount=1234.50&offset=0#top', method: 'GET' } },
        { category: 'xhr', data: { url: 'https://app.isaflow.co.za/api/x?q=Thabo' } },
      ],
    };
    const [f, x] = scrubEvent(event)!.breadcrumbs!;
    expect(f!.data!.url).toBe('/api/accounting/bank-transactions?bank_account_id=[REDACTED]&search=[REDACTED]&from_amount=[REDACTED]&offset=[REDACTED]#top');
    expect(f!.data!.method).toBe('GET');
    expect(x!.data!.url).toBe('https://app.isaflow.co.za/api/x?q=[REDACTED]');
  });

  it('redacts query values in navigation breadcrumb from/to, and a share token in them still shows as [token]', () => {
    const token = 'A'.repeat(43);
    const event: Event = {
      breadcrumbs: [{ category: 'navigation', data: { from: '/accounting/bank-transactions?search=Smith', to: `/share/${token}?share_token=${token}&x=1` } }],
    };
    const d = scrubEvent(event)!.breadcrumbs![0]!.data!;
    expect(d.from).toBe('/accounting/bank-transactions?search=[REDACTED]');
    expect(d.to).toBe('/share/[token]?share_token=[token]&x=[REDACTED]');
    expect(JSON.stringify(d)).not.toContain(token);
  });

  it('leaves a url without a query alone', () => {
    const event: Event = { breadcrumbs: [{ category: 'navigation', data: { from: '/a', to: '/b#c' } }] };
    expect(scrubEvent(event)!.breadcrumbs![0]!.data).toEqual({ from: '/a', to: '/b#c' });
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
