/**
 * Payroll GL Helper
 * Resolves GL accounts for payroll journal entries.
 */

import { sql } from '@/lib/neon';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface PayrollGLAccounts {
  salariesId: string;
  bankId: string;
  payeId?: string;
  uifId?: string;
  sdlId?: string;
}

export async function resolvePayrollGLAccounts(): Promise<PayrollGLAccounts> {
  const accountRows = (await sql`
    SELECT id, account_code, account_name, account_type FROM gl_accounts
    WHERE account_code IN ('6000', '6010', '2200', '2210', '2220', '2230', '1000', '1100')
    ORDER BY account_code
  `) as Row[];

  const byCode: Record<string, string> = {};
  for (const acc of accountRows) byCode[String(acc.account_code)] = String(acc.id);

  let salariesId = byCode['6000'] || byCode['6010'];
  let payeId = byCode['2200'] || byCode['2210'];
  let uifId = byCode['2220'] || byCode['2210'];
  let sdlId = byCode['2230'] || byCode['2210'];
  let bankId = byCode['1000'] || byCode['1100'];

  if (!salariesId || !bankId) {
    const fallback = (await sql`
      SELECT id, account_name, account_type FROM gl_accounts
      WHERE account_name ILIKE '%salar%' OR account_name ILIKE '%wage%'
        OR account_name ILIKE '%paye%' OR account_name ILIKE '%uif%'
        OR account_name ILIKE '%sdl%' OR account_name ILIKE '%bank%'
        OR account_type = 'asset'
      ORDER BY account_code LIMIT 20
    `) as Row[];

    for (const acc of fallback) {
      const name = String(acc.account_name).toLowerCase();
      const id = String(acc.id);
      if (!salariesId && (name.includes('salar') || name.includes('wage'))) salariesId = id;
      if (!payeId && name.includes('paye')) payeId = id;
      if (!uifId && name.includes('uif')) uifId = id;
      if (!sdlId && name.includes('sdl')) sdlId = id;
      if (!bankId && name.includes('bank') && String(acc.account_type) === 'asset') bankId = id;
    }
  }

  if (!salariesId || !bankId) {
    throw new Error(
      'Required GL accounts not found. Please set up Salaries/Wages expense and Bank accounts in your Chart of Accounts.'
    );
  }

  return { salariesId, bankId, payeId, uifId, sdlId };
}

export interface PayrollJournalLine {
  glAccountId: string;
  debit: number;
  credit: number;
  description: string;
}

export function buildPayrollJournalLines(
  accounts: PayrollGLAccounts,
  totals: {
    totalGross: number;
    totalPaye: number;
    totalUifEmployee: number;
    totalUifEmployer: number;
    totalSdl: number;
  }
): PayrollJournalLine[] {
  const { salariesId, bankId, payeId, uifId, sdlId } = accounts;
  const { totalGross, totalPaye, totalUifEmployee, totalUifEmployer, totalSdl } = totals;
  const totalEmployerCost = totalGross + totalUifEmployer + totalSdl;
  const totalUif = totalUifEmployee + totalUifEmployer;

  const lines: PayrollJournalLine[] = [
    { glAccountId: salariesId, debit: totalEmployerCost, credit: 0, description: 'Payroll - Salaries & Wages' },
    ...(totalPaye > 0 && payeId ? [{ glAccountId: payeId, debit: 0, credit: totalPaye, description: 'Payroll - PAYE' }] : []),
    ...(totalUif > 0 && uifId ? [{ glAccountId: uifId, debit: 0, credit: totalUif, description: 'Payroll - UIF' }] : []),
    ...(totalSdl > 0 && sdlId ? [{ glAccountId: sdlId, debit: 0, credit: totalSdl, description: 'Payroll - SDL' }] : []),
  ];

  const creditsAbove = totalPaye + (uifId ? totalUif : 0) + (sdlId ? totalSdl : 0);
  const bankCredit = Math.round((totalEmployerCost - creditsAbove) * 100) / 100;
  lines.push({ glAccountId: bankId, debit: 0, credit: bankCredit, description: 'Payroll - Net Pay' });

  return lines;
}
