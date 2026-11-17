/**
 * Wave 6 VR: the versions drawer shows a settlement made over a ledger gap, with both figures and the reason, and
 * says nothing of a gap when there was none.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ReturnVersionsDrawer } from '@/components/accounting/sars/returns/ReturnVersionsDrawer';
import { V1 } from './helpers/returnLifecycleHarness';

afterEach(() => cleanup());

const settlement = {
  status: 'submitted', outputTax: 10740, inputTax: 5400, netVat: 5340, sarsReference: null,
  submittedAt: '2026-11-17T19:00:00Z', returnVersionNo: 1, mismatch: false,
};
const drawer = (ledgerGap: unknown) => render(<ReturnVersionsDrawer open onClose={() => undefined} form="VAT201"
  versions={[V1] as never} vatReturn={{ ...settlement, ledgerGap } as never} nameOf={() => 'Olive Owner'} />);

it('a settlement over a ledger gap: both net VAT figures and the reason', () => {
  drawer({ ledgerNetVat: 5340, reportNetVat: 5385, reason: 'A cancelled credit note is still posted' });
  const gap = screen.getByTestId('settlement-ledger-gap').textContent ?? '';
  expect(gap).toMatch(/5[\s,]?340\.00/);
  expect(gap).toMatch(/5[\s,]?385\.00/);
  expect(gap).toContain('Reason: A cancelled credit note is still posted');
});

it('no gap: no gap line', () => {
  drawer(null);
  expect(screen.queryByTestId('settlement-ledger-gap')).toBeNull();
  expect(screen.getByTestId('return-versions-drawer').textContent).toContain('VAT settlement, posted against v1');
});
