import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AccountLedgerSummary } from '@/components/reports/AccountLedgerSummary';

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
const text = (closed: number) => render(
  <AccountLedgerSummary openingBalance={0} periodNet={0} closedToRetainedEarnings={closed} periodClosingBalance={0} total={0} />,
).container.textContent ?? '';

describe('AccountLedgerSummary year-end close wording', () => {
  // closedToRetainedEarnings is the NEGATED normal-side balance that was closed, for either account kind.
  it('an expense (debit-normal) year closed: the amount is unsigned', () => {
    const t = text(-267109.7);
    expect(t).toContain(`${fmt(267109.7)} closed to retained earnings`);
    expect(t).not.toMatch(/-\s*R|−/);
  });

  it('a revenue (credit-normal) year closed: the amount is unsigned', () => {
    const t = text(-130);
    expect(t).toContain(`${fmt(130)} closed to retained earnings`);
    expect(t).not.toMatch(/-\s*R|−/);
  });

  it('a balance on the abnormal side says so in words, still unsigned', () => {
    const t = text(45);
    expect(t).toContain(`${fmt(45)} (abnormal-side balance) closed to retained earnings`);
    expect(t).not.toMatch(/-\s*R|−/);
  });

  it('says nothing when nothing was closed', () => {
    expect(text(0)).not.toContain('retained earnings');
  });
});
