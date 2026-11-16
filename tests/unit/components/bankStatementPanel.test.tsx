/**
 * BankStatementPanel (WP1 PR-C): a missing statement figure always says WHY (never a bare "—"); a closing balance
 * nothing checked (pdf_read / ai_read) carries its caveat and its Difference reads "(not checked)", never as
 * reconciled; the Difference is measured on the last statement WITH a balance, with a Reconcile link prefilling
 * bank-reconciliation/new.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BankStatementPanel } from '@/components/accounting/bank-transactions/BankStatementPanel';
import { summaryAcct } from '../helpers/bankSummaryFixture';
import type { StatementRef } from '@/modules/accounting/services/bank/bankAccountSummaryService';

vi.mock('next/link', () => ({ default: ({ children, href, ...r }: { children: React.ReactNode; href: string }) => <a href={href} {...r}>{children}</a> }));
afterEach(cleanup);

const ref = (o: Partial<StatementRef> = {}): StatementRef => ({
  batchId: 'b1', statementDate: '2026-10-31', sourceLabel: 'FNB', balanceSource: 'running_balance',
  openingCents: 100000, closingCents: 250000, lineCount: 12, importedAt: '2026-11-02T08:00:00.000Z', ...o,
});
const nb = (s: string) => s.replace(/\u00A0/g, ' ');
const text = () => screen.getByTestId('bank-statement-panel').textContent!.replace(/ /g, ' ');

describe('BankStatementPanel', () => {
  it('no batch at all: says so and offers the import', () => {
    render(<BankStatementPanel bank={summaryAcct('a1')} />);
    expect(text()).toContain('No statement imported yet');
    expect(screen.getByText('Import a statement').getAttribute('href')).toBe('/accounting/bank-reconciliation/import?account_id=a1');
  });

  it('a checked balance: opening, statement balance, ledger at the same date, the difference and a prefilled Reconcile link', () => {
    const latest = ref();
    render(<BankStatementPanel bank={summaryAcct('a1', { statement: { latest, lastWithBalance: latest, ledgerAtStatementCents: 249000, differenceCents: 1000 } })} />);
    const t = text();
    expect(t).toContain('Opening');
    expect(t).toContain('R 1 000.00');
    expect(t).toMatch(/Statement balance \(as at .*2026.*\)/);
    expect(t).toContain('R 2 500.00');
    expect(t).toMatch(/Ledger balance \(as at/);
    expect(t).toContain('R 2 490.00');
    expect(t).toMatch(/Difference \(as at/);
    expect(nb(screen.getByTestId('statement-difference-value').textContent!)).toBe('R 10.00');
    expect(screen.getByTestId('statement-reconcile-link').getAttribute('href'))
      .toBe('/accounting/bank-reconciliation/new?bankAccountId=a1&statementDate=2026-10-31&statementBalance=2500.00');
    expect(screen.queryByTestId('statement-balance-caveat')).toBeNull();
    expect(screen.getByTestId('statement-format-chip').getAttribute('title')).toBe('Statement file format: FNB');
    expect(t).toContain('12 lines on this statement');
  });

  for (const [source, caveat] of [
    ['pdf_read', "From the PDF's running balance (not checked against a printed closing)"],
    ['ai_read', 'Read from the PDF by AI (not checked against the file)'],
  ] as const) {
    it(`${source}: caveat shown, Difference "(not checked)" and not styled as reconciled even at zero`, () => {
      const latest = ref({ balanceSource: source });
      render(<BankStatementPanel bank={summaryAcct('a1', { statement: { latest, lastWithBalance: latest, ledgerAtStatementCents: 250000, differenceCents: 0 } })} />);
      expect(screen.getByTestId('statement-balance-caveat').textContent).toBe(caveat);
      expect(screen.getByTestId('statement-difference').textContent).toContain('Difference (not checked)');
      const value = screen.getByTestId('statement-difference-value');
      expect(value.className).not.toContain('text-teal');
      expect(value.className).toContain('text-amber-700');
    });
  }

  it('a checked zero difference reads as reconciled (teal)', () => {
    const latest = ref();
    render(<BankStatementPanel bank={summaryAcct('a1', { statement: { latest, lastWithBalance: latest, ledgerAtStatementCents: 250000, differenceCents: 0 } })} />);
    expect(screen.getByTestId('statement-difference-value').className).toContain('text-teal');
  });

  for (const [source, reason] of [
    ['not_in_file', 'Not provided by this file format'],
    ['unverified', 'In the file, but its running balance does not agree with its lines — not used'],
    [null, 'Not recorded for this import'],
  ] as const) {
    it(`latest without a balance (${source}): the reason, never a bare dash`, () => {
      const latest = ref({ balanceSource: source, openingCents: null, closingCents: null });
      render(<BankStatementPanel bank={summaryAcct('a1', { statement: { latest } })} />);
      expect(screen.getByTestId('statement-no-balance-reason').textContent).toBe(reason);
      expect(screen.queryByText('—')).toBeNull(); // the old widget's bare dash
      expect(screen.queryByTestId('statement-difference')).toBeNull();
    });
  }

  it('latest has no balance but an older batch does: its own date, its own difference', () => {
    const latest = ref({ batchId: 'new', statementDate: '2026-11-15', balanceSource: 'not_in_file', openingCents: null, closingCents: null });
    const older = ref({ batchId: 'old', statementDate: '2026-09-30', closingCents: 80000 });
    render(<BankStatementPanel bank={summaryAcct('a1', { statement: { latest, lastWithBalance: older, ledgerAtStatementCents: 79000, differenceCents: 1000 } })} />);
    expect(screen.getByTestId('statement-no-balance-reason')).toBeTruthy();
    expect(nb(screen.getByTestId('statement-last-with-balance').textContent!)).toMatch(/Last statement balance \(as at .*2026.*\)R 800\.00/);
    expect(screen.getByTestId('statement-difference').textContent).toMatch(/Difference \(as at .*2026/);
    expect(screen.getByTestId('statement-reconcile-link').getAttribute('href')).toContain('statementDate=2026-09-30&statementBalance=800.00');
  });

  it('opening missing but closing present (OFX): says what is missing, not a dash', () => {
    const latest = ref({ openingCents: null, balanceSource: 'printed' });
    render(<BankStatementPanel bank={summaryAcct('a1', { statement: { latest, lastWithBalance: latest, ledgerAtStatementCents: 250000, differenceCents: 0 } })} />);
    expect(screen.getByTestId('statement-opening').textContent).toContain('Not provided by this file');
  });

  it('a statement but no ledger figure at its date: the ledger row says it is as at the LEDGER date, never the statement\'s', () => {
    const latest = ref({ statementDate: '2026-10-31' });
    render(<BankStatementPanel bank={summaryAcct('a1', { ledgerCents: 777700, ledgerAsAt: '2026-11-16',
      statement: { latest, lastWithBalance: latest, ledgerAtStatementCents: null, differenceCents: null } })} />);
    const row = nb(screen.getByTestId('statement-ledger').textContent!);
    expect(row).toMatch(/Ledger balance \(as at 16 Nov 2026\)/);
    expect(row).toContain('R 7 777.00');
    expect(row).not.toContain('31 Oct 2026');
  });

  it('with the ledger at the statement date, the row carries that date and figure', () => {
    const latest = ref({ statementDate: '2026-10-31' });
    render(<BankStatementPanel bank={summaryAcct('a1', { ledgerCents: 777700,
      statement: { latest, lastWithBalance: latest, ledgerAtStatementCents: 249000, differenceCents: 1000 } })} />);
    const row = nb(screen.getByTestId('statement-ledger').textContent!);
    expect(row).toMatch(/as at 31 Oct 2026/);
    expect(row).toContain('R 2 490.00');
  });
});
