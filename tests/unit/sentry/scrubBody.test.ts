// tests/unit/sentry/scrubBody.test.ts: a request body keeps its shape and loses every value; extra/contexts lose selectors.
import { describe, it, expect } from 'vitest';
import { scrubEvent } from '@/lib/sentry/scrub';
import type { Event } from '@sentry/nextjs';

const body = (data: unknown) => scrubEvent({ request: { data } } as Event)!.request!.data;

describe('request body', () => {
  it('a string body is [REDACTED]', () => {
    expect(body('{"notes":"paid J Smith cash"}')).toBe('[REDACTED]');
  });

  it('an object body keeps its keys and loses every value, whatever the key', () => {
    expect(body({ notes: 'paid J Smith cash', amount: 1234.5, vatInclusive: true, reference: 'INV-0123456789' }))
      .toEqual({ notes: '[REDACTED]', amount: '[REDACTED]', vatInclusive: '[REDACTED]', reference: '[REDACTED]' });
  });

  it('keeps nested keys, in objects and arrays, and redacts every leaf', () => {
    const out = body({
      customer: { name: 'J Smith', contact: { phone: '0123456789', email: 'j@smith.test' } },
      lines: [{ description: 'Cash to J Smith', quantity: 3, taxable: false }, 'free text', 7],
    });
    expect(out).toEqual({
      customer: { name: '[REDACTED]', contact: { phone: '[REDACTED]', email: '[REDACTED]' } },
      lines: [{ description: '[REDACTED]', quantity: '[REDACTED]', taxable: '[REDACTED]' }, '[REDACTED]', '[REDACTED]'],
    });
    expect(JSON.stringify(out)).not.toMatch(/Smith|0123456789/);
  });

  it('an array body is redacted element by element', () => {
    expect(body([{ notes: 'x' }, 'y'])).toEqual([{ notes: '[REDACTED]' }, '[REDACTED]']);
  });

  it('a null leaf says nothing and stays null', () => {
    expect(body({ notes: null })).toEqual({ notes: null });
  });

  it('the top-level email keeps its hashed local part (the existing rule); a nested email does not', () => {
    const out = body({ email: 'hein@velocityfibre.co.za', who: { email: 'a@b.test' } }) as Record<string, unknown>;
    expect(out.email).toMatch(/^[a-f0-9]{8}@velocityfibre\.co\.za$/);
    expect(out.who).toEqual({ email: '[REDACTED]' });
  });

  it('is idempotent', () => {
    const once = body({ a: { b: 'c' }, d: [1] });
    expect(body(once)).toEqual(once);
  });
});

describe('extra and contexts', () => {
  it('lose a selector attribute as well as URL values', () => {
    const out = scrubEvent({
      extra: { click: 'div > button[aria-label="Accept, J SMITH 0123"]', page: '/bank?search=Smith', nested: ['span[title="note about Thabo"]'] },
      contexts: { custom: { target: 'input[name="payee J SMITH"]' } },
    } as Event)!;
    expect(out.extra).toEqual({ click: 'div > button[aria-label="[REDACTED]"]', page: '/bank?search=[REDACTED]', nested: ['span[title="[REDACTED]"]'] });
    expect(out.contexts).toEqual({ custom: { target: 'input[name="[REDACTED]"]' } });
  });
});

describe('selector and URL in one text', () => {
  const msg = (message: string) => scrubEvent({ message } as Event)!.message;

  it('a Tailwind "/" class before an attribute does not hide the attribute', () => {
    expect(msg('div.bg-black/50.text-[#fff] > button[aria-label="Accept, J SMITH 0123"]'))
      .toBe('div.bg-black/50.text-[#fff] > button[aria-label="[REDACTED]"]');
  });

  it('a URL directly followed by a selector loses both its query value and the attribute', () => {
    expect(msg('GET /api/x?q=Smith[aria-label="J SMITH 0123"]')).toBe('GET /api/x?q=[REDACTED][aria-label="[REDACTED]"]');
  });

  it('a URL and a selector far apart each get their own treatment', () => {
    expect(msg('GET /api/x?q=Smith then button[title="J SMITH"] clicked')).toBe('GET /api/x?q=[REDACTED] then button[title="[REDACTED]"]');
  });

  it('a masked share token in a URL does not end the URL', () => {
    expect(msg('fetch /share/[token]?x=1 failed')).toBe('fetch /share/[token]?x=[REDACTED] failed');
  });
});
