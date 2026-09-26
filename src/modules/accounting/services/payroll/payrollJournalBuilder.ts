/**
 * The payroll journal PLAN — one description of what a pay run would post,
 * shared by the poster and by `post_payroll_journal`'s dry run.
 *
 * WHY THIS IS A SEPARATE FILE. A dry run that re-derived the journal would be
 * free to disagree with what actually posts, which is the one thing a preview
 * must never do (docs/mcp/CONTRACTS.md §5 — one figure, one query). So the
 * arithmetic lives here once and `postPayrollRunJournal` consumes it.
 *
 * WHAT THE PLAN SAYS ABOUT DEACTIVATED ACCOUNTS. The line is built either way —
 * filtering it out would understate the journal — and the account is named in
 * an `inactive_target_account` BLOCKER. It was an advisory on the premise that
 * the money lands there, but `postJournalEntry` refuses a deactivated account
 * (`assertNoInactiveAccountLines`), so a preview that passed it greenlit a post
 * the live path refused (K-079 review). Brightsphere carries all five payroll
 * accounts deactivated and Velocity Fibre 1110: they must reactivate or remap.
 *
 * Balance formula:
 *   DR 5200 Labour = gross + employer UIF + SDL − ETI used, split by cost centre
 *   CR 2140 PAYE = PAYE − ETI used   CR 2150 UIF (both halves)   CR 2160 SDL
 *   CR 2175 Other employee deductions (residual)   CR 1110 Bank (net pay)
 *
 * ETI (K-079, Hein 2026-09-26). ETI is an offset against the PAYE remitted, so
 * it reduces the 2140 credit, and it is presented net of labour cost. Only the
 * ETI this run's PAYE can absorb is booked — `etiUsed = min(eti, paye)` — which
 * makes CR 2140 equal EMP201's PAYE payable (`emp201Service` floors it at zero;
 * one run per company per period). ETI beyond PAYE is not booked; the plan
 * says so in an advisory.
 *
 * A zero line is dropped: the GL rejects a line with neither debit nor credit,
 * and an SDL-exempt run, or one whose PAYE the ETI absorbs, has one.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  REQUIRED_PAYROLL_ACCOUNT_CODES,
  buildLabourLines,
  lastDayOfMonthIso,
  resolveAccounts,
} from './payrollJournalParts';

type Row = DbRow;

export {
  REQUIRED_PAYROLL_ACCOUNT_CODES,
  OPTIONAL_PAYROLL_ACCOUNT_CODES,
  lastDayOfMonthIso,
} from './payrollJournalParts';

export interface PayrollJournalPlanLine {
  /** Null only when the account does not exist — the plan then carries a blocker. */
  glAccountId: string | null;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  description: string;
  /** True when the target account is deactivated. Reported, never filtered. */
  inactiveAccount: boolean;
}

/** Machine-stable code plus prose. Blockers stop the post; advisories do not. */
export interface PayrollJournalNote {
  code: string;
  detail: string;
}

export interface PayrollJournalPlan {
  runId: string;
  status: string;
  periodMonth: number;
  periodYear: number;
  employeeCount: number;
  /** Set when the run has already posted — the poster returns this id unchanged. */
  alreadyPostedJournalId: string | null;
  /** YYYY-MM-DD, last day of the period month. */
  entryDate: string;
  description: string;
  reference: string;
  lines: PayrollJournalPlanLine[];
  totalDebit: number;
  totalCredit: number;
  /** The run header totals the plan was derived from, so a reader can check it. */
  totals: {
    gross: number;
    paye: number;
    uif: number;
    sdl: number;
    eti: number;
    /** The ETI booked: min(eti, paye). The rest is reported in `eti_beyond_paye`. */
    etiUsed: number;
    net: number;
    employerUif: number;
    otherDeductions: number;
  };
  blockers: PayrollJournalNote[];
  advisories: PayrollJournalNote[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Returns the plan for one pay run, or null when the run is not in this
 * company. Never throws on a business condition — everything that would stop
 * the post is a blocker, so a dry run can report it without the caller having
 * to trigger it.
 */
export async function buildPayrollJournalPlan(
  companyId: string,
  runId: string,
): Promise<PayrollJournalPlan | null> {
  const headerRows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  const hdr = headerRows[0];
  if (!hdr) return null;

  const status = String(hdr.status);
  const periodYear = Number(hdr.period_year);
  const periodMonth = Number(hdr.period_month);
  const gross = Number(hdr.total_gross) || 0;
  const paye = Number(hdr.total_paye) || 0;
  const uif = Number(hdr.total_uif) || 0; // combined employee + employer
  const sdl = Number(hdr.total_sdl) || 0;
  const eti = Number(hdr.total_eti) || 0;
  const net = Number(hdr.total_net) || 0;

  const employeeUif = round2(uif / 2);
  // The two halves sum to uif exactly, so an odd cent cannot unbalance the journal.
  const employerUif = round2(uif - employeeUif);
  const etiUsed = round2(Math.min(eti, paye));
  const labourDebit = round2(gross + employerUif + sdl - etiUsed);
  const otherDeductions = round2(gross - paye - employeeUif - net);

  const accounts = await resolveAccounts(companyId);
  const blockers: PayrollJournalNote[] = [];
  const advisories: PayrollJournalNote[] = [];

  const missing = REQUIRED_PAYROLL_ACCOUNT_CODES.filter((c) => !accounts.has(c));
  if (missing.length > 0) {
    blockers.push({
      code: 'missing_gl_accounts',
      detail: `The company has no GL account for ${missing.join(', ')}. The payroll journal cannot be built without them.`,
    });
  }
  if (otherDeductions > 0.005 && !accounts.has('2175')) {
    blockers.push({
      code: 'missing_other_deductions_account',
      detail: `The run carries R${otherDeductions.toFixed(2)} of voluntary deductions but the company has no GL account 2175 (Other Employee Deductions Payable).`,
    });
  }
  if (status !== 'approved') {
    blockers.push({
      code: 'run_not_approved',
      detail: `A payroll run must be 'approved' before its journal can post. This run is '${status}'.`,
    });
  }
  if (hdr.journal_entry_id != null) {
    blockers.push({
      code: 'already_posted',
      detail: `This run already posted journal ${String(hdr.journal_entry_id)}. Reverse it before posting again.`,
    });
  }

  const line = (
    code: string,
    debit: number,
    credit: number,
    description: string,
    accountId?: string,
  ): PayrollJournalPlanLine => {
    const acc = accounts.get(code);
    return {
      glAccountId: accountId ?? acc?.id ?? null,
      accountCode: code,
      accountName: acc?.name ?? '',
      debit: round2(debit),
      credit: round2(credit),
      description,
      inactiveAccount: acc ? !acc.isActive : false,
    };
  };

  const built: PayrollJournalPlanLine[] = [];
  const labourAccountId = accounts.get('5200')?.id;
  if (labourAccountId) {
    const labour = await buildLabourLines(companyId, runId, labourDebit, gross, labourAccountId, etiUsed);
    // The split can route a share to a cost-centre account other than 5200;
    // report each under 5200's flags only when it IS 5200.
    for (const l of labour) {
      const isDefault = l.glAccountId === labourAccountId;
      built.push({
        glAccountId: l.glAccountId,
        accountCode: isDefault ? '5200' : '',
        accountName: isDefault ? (accounts.get('5200')?.name ?? '') : '',
        debit: round2(l.debit),
        credit: 0,
        description: l.description,
        inactiveAccount: isDefault ? !(accounts.get('5200')?.isActive ?? true) : false,
      });
    }
  } else {
    built.push(line('5200', labourDebit, 0, 'Labour costs — gross pay + statutory employer contributions − ETI'));
  }

  built.push(line('2140', 0, paye - etiUsed, 'PAYE payable, net of ETI'));
  built.push(line('2150', 0, uif, 'UIF payable (employee + employer)'));
  built.push(line('2160', 0, sdl, 'SDL payable'));
  built.push(line('1110', 0, net, 'Net pay — bank disbursement'));
  if (otherDeductions > 0.005) {
    built.push(line('2175', 0, otherDeductions, 'Other employee deductions (medical aid, pension, RA, etc.)'));
  }

  const lines = built.filter((l) => l.debit !== 0 || l.credit !== 0);

  if (eti - etiUsed > 0.005) {
    advisories.push({
      code: 'eti_beyond_paye',
      detail: `The run claims R${eti.toFixed(2)} of ETI but its PAYE is R${paye.toFixed(2)}, so only R${etiUsed.toFixed(2)} is booked. The remaining R${(eti - etiUsed).toFixed(2)} is not booked: EMP201 floors PAYE payable at zero and carries no ETI forward.`,
    });
  }

  const inactive = [...new Set(lines.filter((l) => l.inactiveAccount).map((l) => l.accountCode))];
  if (inactive.length > 0) {
    blockers.push({
      code: 'inactive_target_account',
      detail: `This journal posts into deactivated accounts: ${inactive.join(', ')}. The ledger refuses a posting to a deactivated account; reactivate them before posting.`,
    });
  }

  // The GL poster refuses both of these; saying so here lets the dry run and
  // approval refuse BEFORE anything is written, with the reason (K-079).
  if (lines.length < 2) {
    blockers.push({
      code: 'nothing_to_post',
      detail: 'The run has no amounts to post — every journal line is zero. Calculate the run first.',
    });
  }
  const negative = lines.filter((l) => l.debit < 0 || l.credit < 0);
  if (negative.length > 0) {
    blockers.push({
      code: 'negative_amount',
      detail: `The run totals give a negative amount on ${negative.map((l) => l.accountCode || l.glAccountId).join(', ')}, which a journal line cannot carry. Check the run's totals.`,
    });
  }
  const entryDate = lastDayOfMonthIso(periodYear, periodMonth);
  const periodRows = (await sql`
    SELECT status FROM fiscal_periods
    WHERE company_id = ${companyId}::uuid
      AND start_date <= ${entryDate}::date AND end_date >= ${entryDate}::date
  `) as Row[];
  const closed = periodRows.find((p) => String(p.status) !== 'open');
  if (closed) {
    blockers.push({
      code: 'closed_period',
      detail: `The fiscal period covering ${entryDate} is '${String(closed.status)}', so the payroll journal cannot post into it.`,
    });
  }

  const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0));
  const totalCredit = round2(lines.reduce((s, l) => s + l.credit, 0));
  // Exact to the cent, as the GL's validateJournalEntry is: a 1-cent tolerance
  // here let a plan pass that the live post then refused.
  if (Math.round((totalDebit - totalCredit) * 100) !== 0) {
    blockers.push({
      code: 'unbalanced',
      detail: `Payroll journal unbalanced by ${(totalDebit - totalCredit).toFixed(2)} (DR ${totalDebit.toFixed(2)} vs CR ${totalCredit.toFixed(2)}).`,
    });
  }

  const mm = String(periodMonth).padStart(2, '0');
  return {
    runId,
    status,
    periodMonth,
    periodYear,
    employeeCount: Number(hdr.employee_count) || 0,
    alreadyPostedJournalId: hdr.journal_entry_id == null ? null : String(hdr.journal_entry_id),
    entryDate,
    description: `Payroll run ${periodYear}-${mm}`,
    reference: `PAY-${periodYear}-${mm}`,
    lines,
    totalDebit,
    totalCredit,
    totals: { gross, paye, uif, sdl, eti, etiUsed, net, employerUif, otherDeductions },
    blockers,
    advisories,
  };
}
