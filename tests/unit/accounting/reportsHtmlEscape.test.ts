import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../../pages/api/accounting/reports-html';

describe('escapeHtml', () => {
  it('escapes < and > to prevent tag injection', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('escapes & ampersand', () => {
    expect(escapeHtml('A & B')).toBe('A &amp; B');
  });

  it('escapes double-quote', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  it("escapes single-quote", () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('escapes a combined XSS payload', () => {
    const payload = `"><img src=x onerror=alert(1)>`;
    const result = escapeHtml(payload);
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).not.toContain('"');
    expect(result).toContain('&lt;');
    expect(result).toContain('&gt;');
    expect(result).toContain('&quot;');
  });

  it('escapes combined quote+amp payload', () => {
    expect(escapeHtml('"&\'')).toBe('&quot;&amp;&#39;');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeHtml('Acme Corp (Pty) Ltd')).toBe('Acme Corp (Pty) Ltd');
  });

  it('coerces non-string input via String()', () => {
    // @ts-expect-error intentional wrong type for runtime test
    expect(escapeHtml(42)).toBe('42');
  });
});
