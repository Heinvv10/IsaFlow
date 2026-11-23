// AR dunning templates: header link, auto-send toggle, template Edit/Deactivate, the edit form and the Body summary are phone-sized; rows and the form's field grid reflow.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
const tpl = (id: string, name: string) => ({ id, name, tone: 'polite', escalation_order: 1, days_overdue_min: 7, days_overdue_max: 30, subject_template: 'Reminder {{invoice}}', body_template: 'Dear {{name}}', send_weekdays_only: true, active: true });
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => new Response(JSON.stringify({ success: true, data: String(url).includes('/settings') ? { settings: { auto_send_enabled: true, min_outstanding_zar: 500 } } : { templates: [tpl('t1', 'First reminder'), tpl('t2', 'Final notice')] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/ar/dunning/index';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';
const FLEX = ['max-lg:inline-flex', 'max-lg:items-center', MIN];

describe('Dunning templates on touch', () => {
  it('header link, auto-send toggle, and the template Edit and Deactivate buttons are 44px; their rows wrap', async () => {
    render(<Page />);
    await screen.findByText('First reminder');
    expect(cls(screen.getByRole('link', { name: /View send history/ }))).toContain(MIN);
    const toggle = screen.getByRole('button', { name: 'Disable' });
    expect(cls(toggle)).toContain(MIN);
    expect(cls(toggle.parentElement!)).toContain('max-lg:flex-wrap'); // the settings section
    for (const name of ['Edit First reminder', 'Deactivate First reminder']) expect(cls(screen.getByRole('button', { name })), name).toEqual(expect.arrayContaining(FLEX));
    const heading = screen.getByRole('heading', { level: 1 });
    expect(cls(heading.parentElement!.parentElement!)).toContain('max-lg:flex-wrap');
    const card = screen.getByText('First reminder').parentElement!.parentElement!.parentElement!;
    expect(cls(card)).toContain('max-lg:flex-wrap'); // the card's title row with the buttons
    expect(cls(screen.getByText('First reminder').parentElement!)).toContain('max-lg:flex-wrap'); // the name, tone and escalation chips
  });

  it('the Body template summary is a 44px tap target', async () => {
    render(<Page />);
    await screen.findByText('First reminder');
    const summary = screen.getAllByText('Body template')[0];
    expect(cls(summary)).toContain(MIN);
    expect(cls(summary)).not.toContain('max-lg:flex'); // display:flex would drop the disclosure marker; min-height works on list-item
  });

  it('edit form: fields, the weekdays checkbox row and Cancel/Save are 44px; the three-column grid stacks', async () => {
    const { container } = render(<Page />);
    await screen.findByText('First reminder');
    fireEvent.click(screen.getByRole('button', { name: 'Edit First reminder' }));
    const inputs = [...container.querySelectorAll('input:not([type="checkbox"])')];
    expect(inputs).toHaveLength(4); // name, days min, days max, subject
    for (const i of inputs) expect(cls(i), i.getAttribute('type') ?? 'text').toContain(MIN);
    const grid = container.querySelector('input[type="number"]')!.closest('.grid')!;
    expect(cls(grid)).toEqual(expect.arrayContaining(['grid-cols-3', 'max-lg:grid-cols-1']));
    expect(cls(screen.getByText('Weekdays only').closest('label')!)).toContain(MIN);
    for (const name of [/Cancel/, /Save/]) expect(cls(screen.getByRole('button', { name })), String(name)).toContain(MIN); // already inline-flex items-center
  });
});
