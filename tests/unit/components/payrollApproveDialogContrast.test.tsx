/**
 * The approval dialog's coloured text, measured: every text colour on the white (light) and
 * #1f2937 (dark) dialog reaches WCAG AA 4.5:1. Colours are read off each element's classes and
 * looked up in the Tailwind palette; a class with no dark: variant must pass on both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import colors from 'tailwindcss/colors';
import { contrastRatio } from '@/lib/brand/contrast';
import { PayrollApproveDialog } from '@/components/payroll/PayrollApproveDialog';
import { PLAN_URL, RUN_ID, planBody, ok, fail } from './payroll/payrollRunFixtures';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = async (answer: Response, warningCount = 0) => {
  fetchMock.mockImplementation(async (url: string) => (url === PLAN_URL ? answer : fail(404, 'no')));
  render(<PayrollApproveDialog runId={RUN_ID} period="Sep 2026" warningCount={warningCount} open onClose={() => undefined} onApproved={() => undefined} onUncertain={() => undefined} />);
  return screen.findByRole('dialog');
};

const palette = colors as unknown as Record<string, Record<string, string>>;
function textHex(el: Element, dark: boolean): string {
  const cls = el.getAttribute('class') ?? '';
  const pick = (prefix: string) => new RegExp(`(?:^|\\s)${prefix}text-([a-z]+)-(\\d{3})(?:\\s|$)`).exec(cls);
  const m = (dark ? pick('dark:') : null) ?? pick('');
  if (!m) throw new Error(`no text colour on ${cls}`);
  return palette[m[1]!]![m[2]!]!;
}
const readable = (el: Element) => {
  expect(contrastRatio(textHex(el, false), '#ffffff'), `light: ${el.getAttribute('class')}`).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(textHex(el, true), palette.gray!['800']!), `dark: ${el.getAttribute('class')}`).toBeGreaterThanOrEqual(4.5);
};

describe('approval dialog contrast, measured', () => {
  it('the journal table headings', async () => {
    const dialog = await open(ok(planBody()));
    readable((await within(dialog).findByText('Debit')).closest('tr')!);
  });

  it('an advisory and the warnings line', async () => {
    const dialog = await open(ok(planBody(null, { plan: { advisories: [{ code: 'eti_beyond_paye', detail: 'ETI beyond PAYE.' }] } })), 3);
    readable(await within(dialog).findByText('ETI beyond PAYE.'));
    readable((await within(dialog).findByText(/3 warnings on this run/)).closest('p')!);
  });

  it('a blocker', async () => {
    const dialog = await open(ok(planBody({ code: 'closed_period', detail: 'The period is closed.' })));
    readable(await within(dialog).findByText('The period is closed.'));
  });

  it('a preview that will not load', async () => {
    const dialog = await open(fail(400, 'Could not read the plan'));
    readable(await within(dialog).findByText(/Could not read the plan/));
  });
});
