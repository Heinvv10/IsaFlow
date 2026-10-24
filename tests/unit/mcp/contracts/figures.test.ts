import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FIGURE_DEFINITIONS,
  figureBasis,
  getFigureDefinition,
  unownedFigures,
} from '@/lib/mcp/contracts/figures';

const SERVICES = join(process.cwd(), 'src/modules/accounting/services');
const defs = Object.values(FIGURE_DEFINITIONS);

describe('figure registry', () => {
  it('keys every entry by its own id', () => {
    for (const [key, d] of Object.entries(FIGURE_DEFINITIONS)) expect(d.id).toBe(key);
  });

  it('versions every id', () => {
    for (const d of defs) expect(d.id).toMatch(/\.v\d+$/);
  });

  // The registry's whole value is that the owner is REAL. A definition naming a
  // function that does not exist is worse than no registry: it reads as settled.
  it.each(defs.filter((d) => d.owner !== null))('$id names a service that exists', (d) => {
    const [path, fn] = d.owner!.split('#');
    const file = join(SERVICES, `${path}.ts`);
    expect(existsSync(file), `${file} does not exist`).toBe(true);
    const src = readFileSync(file, 'utf8');
    expect(
      new RegExp(`export (async )?function ${fn}\\b`).test(src),
      `${path} does not export ${fn}`,
    ).toBe(true);
  });

  it('keeps the two AR figures separate — collapsing them hides a reconciliation break', () => {
    expect(FIGURE_DEFINITIONS['ar.subledger.v1']).toBeDefined();
    expect(FIGURE_DEFINITIONS['ar.control.v1']).toBeDefined();
    expect(FIGURE_DEFINITIONS['ar.subledger.v1']!.owner).not.toBe(
      FIGURE_DEFINITIONS['ar.control.v1']!.owner,
    );
  });

  it('reports both equity bases, so a balance sheet cannot prove itself by construction', () => {
    expect(FIGURE_DEFINITIONS['equity.residual.v1']).toBeDefined();
    expect(FIGURE_DEFINITIONS['equity.ledger.v1']).toBeDefined();
  });

  it('says what every figure excludes, not only what it includes', () => {
    for (const d of defs) {
      expect(d.includes.length, `${d.id} has no includes`).toBeGreaterThan(10);
      expect(d.excludes.length, `${d.id} has no excludes`).toBeGreaterThan(10);
    }
  });

  it('names the competing implementations wherever an owner is unsettled', () => {
    for (const d of unownedFigures()) {
      expect(d.owner).toBeNull();
    }
    // Cash is TWO figures, not one settled figure. Two of the four "competing"
    // implementations were answering a different question — the statement feed
    // — which is why they never agreed. Collapsing them would destroy the only
    // thing that can detect the break, exactly as for ar.subledger vs
    // ar.control. bank_statement_coverage is what measures the gap.
    expect(FIGURE_DEFINITIONS['cash.balance.v1']).toBeUndefined();
    expect(FIGURE_DEFINITIONS['cash.ledger.v1']!.owner)
      .toBe('bank/cashBalanceService#getCashBalance');
    expect(FIGURE_DEFINITIONS['cash.statement.v1']!.owner)
      .toBe('bank/bankAccountStatusService#getBankAccountsStatus');
    expect(FIGURE_DEFINITIONS['cash.ledger.v1']!.owner)
      .not.toBe(FIGURE_DEFINITIONS['cash.statement.v1']!.owner);
    // Each must say the other exists, or a reader will treat one as the answer.
    expect(FIGURE_DEFINITIONS['cash.ledger.v1']!.excludes).toMatch(/cash\.statement\.v1/);
    expect(FIGURE_DEFINITIONS['cash.statement.v1']!.excludes).toMatch(/cash\.ledger\.v1/);
  });

  it('names the financial year as a registry figure, with the remaining ad-hoc site recorded', () => {
    // The year's boundaries come from the fiscal-year registry. The one reader
    // still deriving a year from `financial_year_start` (payroll) is recorded in
    // `contested`, which is what stops a second.
    const fy = FIGURE_DEFINITIONS['fiscalyear.start.v1']!;
    expect(fy.owner).toBe('gl/fiscalYearRegistry#fiscalYearForDate');
    expect(fy.contested).toHaveLength(1);
    expect(fy.contested![0]).toMatch(/payroll\/period-context/);
    // The trap, recorded where a reader will hit it.
    expect(fy.excludes).toMatch(/fiscal_periods\.fiscal_year/);
    expect(fy.excludes).toMatch(/financial_year_start/);
  });

  it('throws on an unknown basis rather than emitting an authoritative-looking typo', () => {
    expect(() => figureBasis('ar.outstanding.v1')).toThrow(/unknown figure/);
    expect(figureBasis('ar.subledger.v1')).toBe('ar.subledger.v1');
  });

  it('returns undefined rather than throwing on a lookup', () => {
    expect(getFigureDefinition('nope')).toBeUndefined();
  });
});
