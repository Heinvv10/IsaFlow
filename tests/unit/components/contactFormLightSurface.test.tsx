/**
 * The contact form is a white card. In the dark theme the global dark form-control rule
 * painted its inputs dark; `data-surface="light"` is the repo's escape hatch from that rule.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ContactPage from '../../../pages/contact';

afterEach(cleanup);

describe('/contact form surface', () => {
  it('marks the form as a light surface and keeps light inputs inside it', () => {
    const { container } = render(<ContactPage />);
    const form = container.querySelector('form')!;
    expect(form.getAttribute('data-surface')).toBe('light');
    for (const id of ['name', 'email', 'phone', 'company', 'message']) {
      const el = container.querySelector(`#${id}`)!;
      expect(el, id).not.toBeNull();
      expect(el.closest('[data-surface="light"]'), id).toBe(form);
      expect(el.className).toMatch(/(^|\s)bg-white(\s|$)/);
      expect(el.className).toMatch(/(^|\s)text-gray-900(\s|$)/);
    }
  });

  it('keeps the POPIA note and privacy link inside the form', () => {
    const { container } = render(<ContactPage />);
    const form = container.querySelector('form')!;
    expect(form.textContent).toContain('We use these details only to reply to your enquiry.');
    expect(form.querySelector('a[href="/privacy"]')).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/(^|[\s"'`])dark:/);
  });

  it('the dark form-control rule still exempts light surfaces', () => {
    const css = readFileSync(join(__dirname, '../../../styles/globals.css'), 'utf8');
    expect(css).toContain(':not(:where([data-surface="light"] *))');
  });
});
