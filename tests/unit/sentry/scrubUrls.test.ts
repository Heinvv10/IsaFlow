// tests/unit/sentry/scrubUrls.test.ts: URLs and free text in a Sentry event never carry query or fragment values.
import { describe, it, expect } from 'vitest';
import { scrubEvent } from '@/lib/sentry/scrub';
import type { Event } from '@sentry/nextjs';

const crumbData = (category: string, data: Record<string, unknown>) =>
  scrubEvent({ breadcrumbs: [{ category, data }] } as Event)!.breadcrumbs![0]!.data!;

describe('breadcrumb urls', () => {
  // The bank transactions page puts search text and amounts in the query of its fetch calls.
  it('redacts query VALUES in fetch/xhr urls, keeping the keys, the path and the method', () => {
    const f = crumbData('fetch', { url: '/api/accounting/bank-transactions?bank_account_id=b1&search=J%20Smith&from_amount=1234.50&offset=0', method: 'GET' });
    expect(f.url).toBe('/api/accounting/bank-transactions?bank_account_id=[REDACTED]&search=[REDACTED]&from_amount=[REDACTED]&offset=[REDACTED]');
    expect(f.method).toBe('GET');
    expect(crumbData('xhr', { url: 'https://app.isaflow.co.za/api/x?q=Thabo' }).url).toBe('https://app.isaflow.co.za/api/x?q=[REDACTED]');
  });

  it('a query pair with no "=" is a value too', () => {
    expect(crumbData('fetch', { url: '/api/x?J%20Smith&a=1&&b' }).url).toBe('/api/x?[REDACTED]&a=[REDACTED]&&[REDACTED]');
  });

  it('redacts navigation from/to, and a share token in them still shows as [token]', () => {
    const token = 'A'.repeat(43);
    const d = crumbData('navigation', { from: '/accounting/bank-transactions?search=Smith', to: `/share/${token}?share_token=${token}&x=1` });
    expect(d.from).toBe('/accounting/bank-transactions?search=[REDACTED]');
    expect(d.to).toBe('/share/[token]?share_token=[token]&x=[REDACTED]');
    expect(JSON.stringify(d)).not.toContain(token);
  });

  it('redacts a fragment, with or without a query: it can carry a reset token', () => {
    const d = crumbData('navigation', { from: '/reset-password#token=abc123SECRET', to: '/login?next=/a#access_token=abc123SECRET&type=recovery' });
    expect(d.from).toBe('/reset-password#[REDACTED]');
    expect(d.to).toBe('/login?next=[REDACTED]#[REDACTED]');
    expect(JSON.stringify(d)).not.toContain('abc123SECRET');
  });

  it('leaves a url without a query or fragment alone, and an empty "?" or "#"', () => {
    expect(crumbData('navigation', { from: '/a', to: '/b' })).toEqual({ from: '/a', to: '/b' });
    expect(crumbData('navigation', { from: '/a?', to: '/b#' })).toEqual({ from: '/a?', to: '/b#' });
  });

  it('is idempotent', () => {
    const once = crumbData('fetch', { url: '/a?x=1&y#frag' });
    expect(crumbData('fetch', { url: once.url })).toEqual(once);
  });

  it('redacts a url held in any other string field of the crumb data', () => {
    expect(crumbData('http', { referrer: 'https://app.isaflow.co.za/bank?search=Smith', status_code: 200 }))
      .toEqual({ referrer: 'https://app.isaflow.co.za/bank?search=[REDACTED]', status_code: 200 });
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

describe('request', () => {
  it('request.url loses query values and its fragment', () => {
    const out = scrubEvent({ request: { url: 'https://app.isaflow.co.za/accounting/bank-transactions?search=Smith&fromAmount=1000#x' } } as Event)!;
    expect(out.request!.url).toBe('https://app.isaflow.co.za/accounting/bank-transactions?search=[REDACTED]&fromAmount=[REDACTED]#[REDACTED]');
  });

  it('query_string loses every value, in string, object and pair-list form', () => {
    expect(scrubEvent({ request: { query_string: 'search=Smith&toAmount=5&flag' } } as Event)!.request!.query_string)
      .toBe('search=[REDACTED]&toAmount=[REDACTED]&[REDACTED]');
    expect(scrubEvent({ request: { query_string: { search: 'Smith', toAmount: '5' } } } as Event)!.request!.query_string)
      .toEqual({ search: '[REDACTED]', toAmount: '[REDACTED]' });
    expect(scrubEvent({ request: { query_string: [['search', 'Smith'], ['fromAmount', '9']] } } as Event)!.request!.query_string)
      .toEqual([['search', '[REDACTED]'], ['fromAmount', '[REDACTED]']]);
  });

  it('a referer header loses its query values', () => {
    const out = scrubEvent({ request: { headers: { Referer: 'https://app.isaflow.co.za/b?search=Smith', Accept: 'x' } } } as Event)!;
    expect(out.request!.headers).toEqual({ Referer: 'https://app.isaflow.co.za/b?search=[REDACTED]', Accept: 'x' });
  });
});

describe('free text', () => {
  const SEARCH = 'GET /api/accounting/bank-transactions?search=J%20Smith&fromAmount=1234 failed';
  const SCRUBBED = 'GET /api/accounting/bank-transactions?search=[REDACTED]&fromAmount=[REDACTED] failed';

  it('event.message, logentry and exception values lose URL query values but keep their text', () => {
    const out = scrubEvent({
      message: SEARCH,
      logentry: { message: SEARCH, params: [SEARCH, 7] },
      exception: { values: [{ type: 'Error', value: SEARCH }, { type: 'TypeError', value: 'x is not a function' }] },
    } as Event)!;
    expect(out.message).toBe(SCRUBBED);
    expect(out.logentry).toEqual({ message: SCRUBBED, params: [SCRUBBED, 7] });
    expect(out.exception!.values!.map(v => v.value)).toEqual([SCRUBBED, 'x is not a function']);
  });

  it('an absolute url inside an exception value is redacted', () => {
    const out = scrubEvent({ exception: { values: [{ value: 'Failed to fetch https://app.isaflow.co.za/api/x?q=Thabo#frag' }] } } as Event)!;
    expect(out.exception!.values![0]!.value).toBe('Failed to fetch https://app.isaflow.co.za/api/x?q=[REDACTED]#[REDACTED]');
  });

  it('a selector inside an exception value is cut at its first attribute', () => {
    const out = scrubEvent({ exception: { values: [{ value: "Failed to execute querySelector: 'button[aria-label=\"J SMITH\"]'" }] } } as Event)!;
    expect(out.exception!.values![0]!.value).toBe("Failed to execute querySelector: 'button[aria-label=\"[REDACTED]\"]");
  });

  it('a sentry.event breadcrumb message gets the same treatment', () => {
    const out = scrubEvent({ breadcrumbs: [{ category: 'sentry.event', message: SEARCH }] } as Event)!;
    expect(out.breadcrumbs![0]!.message).toBe(SCRUBBED);
  });

  it('extra and contexts lose query values in any nested string, and keep the rest', () => {
    const out = scrubEvent({
      extra: { page: '/bank?search=Smith', nested: { list: ['https://x.test/a?b=c', 'plain', 3] }, n: 1 },
      contexts: { trace: { data: { 'http.url': '/api/y?z=1' }, op: 'http.server' } },
    } as Event)!;
    expect(out.extra).toEqual({ page: '/bank?search=[REDACTED]', nested: { list: ['https://x.test/a?b=[REDACTED]', 'plain', 3] }, n: 1 });
    expect(out.contexts).toEqual({ trace: { data: { 'http.url': '/api/y?z=[REDACTED]' }, op: 'http.server' } });
  });

  it('a circular extra does not throw', () => {
    const extra: Record<string, unknown> = { a: '/x?y=1' };
    extra.self = extra;
    expect(() => scrubEvent({ extra } as Event)).not.toThrow();
  });

  it('a path without a leading slash is a url too', () => {
    expect(scrubEvent({ message: 'fetch api/x?search=Smith failed' } as Event)!.message).toBe('fetch api/x?search=[REDACTED] failed');
  });

  it('text without a url is untouched', () => {
    const out = scrubEvent({ message: 'Unexpected token < in JSON at position 0 (a/b 1/2)' } as Event)!;
    expect(out.message).toBe('Unexpected token < in JSON at position 0 (a/b 1/2)');
  });
});
