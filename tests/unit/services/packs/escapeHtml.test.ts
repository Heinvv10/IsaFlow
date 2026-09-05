import { describe, it, expect } from 'vitest';
import { escapeHtml } from '@/modules/accounting/services/packs/escapeHtml';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('& < > " \'')).toBe('&amp; &lt; &gt; &quot; &#39;');
  });

  it('neutralises an injected tag', () => {
    expect(escapeHtml('<img src=x onerror=1>')).toBe('&lt;img src=x onerror=1&gt;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('Cost of Sales')).toBe('Cost of Sales');
  });
});
