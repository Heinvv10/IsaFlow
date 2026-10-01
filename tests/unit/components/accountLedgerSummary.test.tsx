import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AccountLedgerSummary } from '@/components/reports/AccountLedgerSummary';

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
const text = (closed: number, years = 1) => render(
  <AccountLedgerSummary openingBalance={0} periodNet={0} closedToRetainedEarnings={closed} periodClosingBalance={0} total={0} closedYears={years} />,
).container.textContent ?? '';
const noSign = (t: string) => expect(t).not.toMatch(/-\s*R|−/);

describe('AccountLedgerSummary year-end close wording', () => {
  // closedToRetainedEarnings is the NEGATED net of the normal-side balances closed, for either account kind.
  it('an expense (debit-normal) year closed: net amount, unsigned, direction in words', () => {
    const t = text(-267109.7);
    expect(t).toContain(`net ${fmt(267109.7)} closed to retained earnings`);
    noSign(t);
  });

  it('a revenue (credit-normal) year closed: the same wording', () => {
    const t = text(-130);
    expect(t).toContain(`net ${fmt(130)} closed to retained earnings`);
    noSign(t);
  });

  it('a net the other way says so in words, still unsigned', () => {
    const t = text(45);
    expect(t).toContain(`net ${fmt(45)} returned from retained earnings`);
    noSign(t);
  });

  it('two years closed on opposite sides that net to zero still show the line, with the year count', () => {
    const t = text(0, 2);
    expect(t).toContain('2 year-end closes');
    expect(t).toContain(`net ${fmt(0)} — the closed years offset`);
    expect(t).not.toContain('closed to retained earnings');
  });

  it('mixed years: the count is stated and the net direction follows the net', () => {
    const t = text(-70, 2);
    expect(t).toContain('2 year-end closes');
    expect(t).toContain(`net ${fmt(70)} closed to retained earnings`);
  });

  it('says nothing when no year was closed', () => {
    expect(text(0, 0)).not.toContain('retained earnings');
  });
});
