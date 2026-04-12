/**
 * Chart of Accounts Import/Template Service
 * COA template seeding and import/export utilities.
 * Extracted from chartOfAccountsService.ts for file-size compliance.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { cache } from '@/lib/cache';
import type { GLAccountType } from '../types/gl.types';

export type CoaTemplate = 'isaflow_standard' | 'xero_compatible' | 'sage_compatible' | 'blank';

interface TemplateLine {
  code: string;
  name: string;
  type: GLAccountType;
  subtype?: string;
  normalBalance: 'debit' | 'credit';
  level: number;
  displayOrder: number;
  parentCode?: string;
  isSystem?: boolean;
}

/* ── ISAFlow Standard (SA standard 1-5xxx layout) ── */
const ISAFLOW_TEMPLATE: TemplateLine[] = [
  { code:'1000', name:'Assets',                  type:'asset',     normalBalance:'debit',  level:1, displayOrder:100, isSystem:true },
  { code:'2000', name:'Liabilities',             type:'liability', normalBalance:'credit', level:1, displayOrder:200, isSystem:true },
  { code:'3000', name:'Equity',                  type:'equity',    normalBalance:'credit', level:1, displayOrder:300, isSystem:true },
  { code:'4000', name:'Revenue',                 type:'revenue',   normalBalance:'credit', level:1, displayOrder:400, isSystem:true },
  { code:'5000', name:'Expenses',                type:'expense',   normalBalance:'debit',  level:1, displayOrder:500, isSystem:true },
  { code:'1100', name:'Current Assets',          type:'asset',     normalBalance:'debit',  level:2, displayOrder:110, parentCode:'1000', isSystem:true },
  { code:'1200', name:'Non-Current Assets',      type:'asset',     normalBalance:'debit',  level:2, displayOrder:120, parentCode:'1000', isSystem:true },
  { code:'2100', name:'Current Liabilities',     type:'liability', normalBalance:'credit', level:2, displayOrder:210, parentCode:'2000', isSystem:true },
  { code:'2200', name:'Non-Current Liabilities', type:'liability', normalBalance:'credit', level:2, displayOrder:220, parentCode:'2000', isSystem:true },
  { code:'1110', name:'Bank - Primary',          type:'asset',     normalBalance:'debit',  level:3, displayOrder:111, parentCode:'1100', subtype:'bank',                    isSystem:true },
  { code:'1120', name:'Accounts Receivable',     type:'asset',     normalBalance:'debit',  level:3, displayOrder:112, parentCode:'1100', subtype:'receivable',               isSystem:true },
  { code:'1130', name:'Petty Cash',              type:'asset',     normalBalance:'debit',  level:3, displayOrder:113, parentCode:'1100' },
  { code:'1140', name:'VAT Input',               type:'asset',     normalBalance:'debit',  level:3, displayOrder:114, parentCode:'1100', subtype:'vat_input',                isSystem:true },
  { code:'1210', name:'Equipment',               type:'asset',     normalBalance:'debit',  level:3, displayOrder:121, parentCode:'1200', subtype:'fixed_asset' },
  { code:'1220', name:'Vehicles',                type:'asset',     normalBalance:'debit',  level:3, displayOrder:122, parentCode:'1200', subtype:'fixed_asset' },
  { code:'1230', name:'Accumulated Depreciation',type:'asset',     normalBalance:'credit', level:3, displayOrder:123, parentCode:'1200', subtype:'accumulated_depreciation', isSystem:true },
  { code:'2110', name:'Accounts Payable',        type:'liability', normalBalance:'credit', level:3, displayOrder:211, parentCode:'2100', subtype:'payable',                  isSystem:true },
  { code:'2120', name:'VAT Output',              type:'liability', normalBalance:'credit', level:3, displayOrder:212, parentCode:'2100', subtype:'vat_output',               isSystem:true },
  { code:'2130', name:'Accrued Expenses',        type:'liability', normalBalance:'credit', level:3, displayOrder:213, parentCode:'2100' },
  { code:'2210', name:'Long-term Loans',         type:'liability', normalBalance:'credit', level:3, displayOrder:221, parentCode:'2200' },
  { code:'3100', name:'Share Capital',           type:'equity',    normalBalance:'credit', level:2, displayOrder:310, parentCode:'3000', subtype:'equity',           isSystem:true },
  { code:'3200', name:'Retained Earnings',       type:'equity',    normalBalance:'credit', level:2, displayOrder:320, parentCode:'3000', subtype:'retained_earnings', isSystem:true },
  { code:'4100', name:'Sales Revenue',           type:'revenue',   normalBalance:'credit', level:2, displayOrder:410, parentCode:'4000', subtype:'default_revenue',   isSystem:true },
  { code:'4200', name:'Other Income',            type:'revenue',   normalBalance:'credit', level:2, displayOrder:430, parentCode:'4000', subtype:'other_income' },
  { code:'5100', name:'Cost of Sales',           type:'expense',   normalBalance:'debit',  level:2, displayOrder:510, parentCode:'5000', subtype:'default_expense',   isSystem:true },
  { code:'5200', name:'Salaries & Wages',        type:'expense',   normalBalance:'debit',  level:2, displayOrder:520, parentCode:'5000', subtype:'operating_expense' },
  { code:'5300', name:'Rent & Premises',         type:'expense',   normalBalance:'debit',  level:2, displayOrder:530, parentCode:'5000', subtype:'operating_expense' },
  { code:'5400', name:'Transport & Fuel',        type:'expense',   normalBalance:'debit',  level:2, displayOrder:540, parentCode:'5000', subtype:'operating_expense' },
  { code:'5500', name:'Administrative Expenses', type:'expense',   normalBalance:'debit',  level:2, displayOrder:560, parentCode:'5000', subtype:'admin_expense',     isSystem:true },
  { code:'5600', name:'Bank Charges',            type:'expense',   normalBalance:'debit',  level:2, displayOrder:570, parentCode:'5000', subtype:'operating_expense' },
  { code:'5700', name:'Depreciation Expense',    type:'expense',   normalBalance:'debit',  level:2, displayOrder:580, parentCode:'5000', subtype:'depreciation_expense', isSystem:true },
];

/* ── Xero-compatible (3-digit codes used by Xero SA) ── */
const XERO_TEMPLATE: TemplateLine[] = [
  { code:'001', name:'Cash & Bank',             type:'asset',     normalBalance:'debit',  level:1, displayOrder:10 },
  { code:'010', name:'Current Assets',          type:'asset',     normalBalance:'debit',  level:1, displayOrder:20 },
  { code:'100', name:'Fixed Assets',            type:'asset',     normalBalance:'debit',  level:1, displayOrder:30 },
  { code:'200', name:'Current Liabilities',     type:'liability', normalBalance:'credit', level:1, displayOrder:40, isSystem:true },
  { code:'300', name:'Long-term Liabilities',   type:'liability', normalBalance:'credit', level:1, displayOrder:50 },
  { code:'400', name:'Equity',                  type:'equity',    normalBalance:'credit', level:1, displayOrder:60, isSystem:true },
  { code:'500', name:'Revenue',                 type:'revenue',   normalBalance:'credit', level:1, displayOrder:70, isSystem:true },
  { code:'600', name:'Cost of Sales',           type:'expense',   normalBalance:'debit',  level:1, displayOrder:80, isSystem:true },
  { code:'700', name:'Operating Expenses',      type:'expense',   normalBalance:'debit',  level:1, displayOrder:90 },
  { code:'800', name:'Other Income',            type:'revenue',   normalBalance:'credit', level:1, displayOrder:100 },
  { code:'002', name:'Current Account',         type:'asset',     normalBalance:'debit',  level:2, displayOrder:11, parentCode:'001', subtype:'bank',                    isSystem:true },
  { code:'003', name:'Petty Cash',              type:'asset',     normalBalance:'debit',  level:2, displayOrder:12, parentCode:'001' },
  { code:'011', name:'Trade Debtors',           type:'asset',     normalBalance:'debit',  level:2, displayOrder:21, parentCode:'010', subtype:'receivable',               isSystem:true },
  { code:'012', name:'VAT Input',               type:'asset',     normalBalance:'debit',  level:2, displayOrder:22, parentCode:'010', subtype:'vat_input',                isSystem:true },
  { code:'013', name:'Prepayments',             type:'asset',     normalBalance:'debit',  level:2, displayOrder:23, parentCode:'010' },
  { code:'101', name:'Office Equipment',        type:'asset',     normalBalance:'debit',  level:2, displayOrder:31, parentCode:'100', subtype:'fixed_asset' },
  { code:'102', name:'Vehicles',                type:'asset',     normalBalance:'debit',  level:2, displayOrder:32, parentCode:'100', subtype:'fixed_asset' },
  { code:'103', name:'Accumulated Depreciation',type:'asset',     normalBalance:'credit', level:2, displayOrder:33, parentCode:'100', subtype:'accumulated_depreciation', isSystem:true },
  { code:'201', name:'Trade Creditors',         type:'liability', normalBalance:'credit', level:2, displayOrder:41, parentCode:'200', subtype:'payable',                  isSystem:true },
  { code:'202', name:'VAT Output',              type:'liability', normalBalance:'credit', level:2, displayOrder:42, parentCode:'200', subtype:'vat_output',               isSystem:true },
  { code:'203', name:'Payroll Liabilities',     type:'liability', normalBalance:'credit', level:2, displayOrder:43, parentCode:'200' },
  { code:'301', name:'Bank Loans',              type:'liability', normalBalance:'credit', level:2, displayOrder:51, parentCode:'300' },
  { code:'401', name:'Share Capital',           type:'equity',    normalBalance:'credit', level:2, displayOrder:61, parentCode:'400', subtype:'equity',            isSystem:true },
  { code:'410', name:'Retained Earnings',       type:'equity',    normalBalance:'credit', level:2, displayOrder:62, parentCode:'400', subtype:'retained_earnings',  isSystem:true },
  { code:'501', name:'Sales',                   type:'revenue',   normalBalance:'credit', level:2, displayOrder:71, parentCode:'500', subtype:'default_revenue',    isSystem:true },
  { code:'510', name:'Interest Income',         type:'revenue',   normalBalance:'credit', level:2, displayOrder:72, parentCode:'500', subtype:'other_income' },
  { code:'601', name:'Cost of Goods Sold',      type:'expense',   normalBalance:'debit',  level:2, displayOrder:81, parentCode:'600', subtype:'default_expense',    isSystem:true },
  { code:'701', name:'Advertising & Marketing', type:'expense',   normalBalance:'debit',  level:2, displayOrder:91, parentCode:'700' },
  { code:'710', name:'Bank Charges',            type:'expense',   normalBalance:'debit',  level:2, displayOrder:92, parentCode:'700', subtype:'operating_expense' },
  { code:'720', name:'Depreciation',            type:'expense',   normalBalance:'debit',  level:2, displayOrder:93, parentCode:'700', subtype:'depreciation_expense', isSystem:true },
  { code:'730', name:'Insurance',               type:'expense',   normalBalance:'debit',  level:2, displayOrder:94, parentCode:'700' },
  { code:'740', name:'Office Expenses',         type:'expense',   normalBalance:'debit',  level:2, displayOrder:95, parentCode:'700', subtype:'admin_expense',      isSystem:true },
  { code:'750', name:'Rent',                    type:'expense',   normalBalance:'debit',  level:2, displayOrder:96, parentCode:'700', subtype:'operating_expense' },
  { code:'760', name:'Salaries & Wages',        type:'expense',   normalBalance:'debit',  level:2, displayOrder:97, parentCode:'700', subtype:'operating_expense' },
  { code:'770', name:'Telephone & Internet',    type:'expense',   normalBalance:'debit',  level:2, displayOrder:98, parentCode:'700' },
  { code:'801', name:'Other Income',            type:'revenue',   normalBalance:'credit', level:2, displayOrder:101, parentCode:'800' },
];

/* ── Sage One SA layout ── */
const SAGE_TEMPLATE: TemplateLine[] = [
  { code:'1000', name:'Bank & Cash',            type:'asset',     normalBalance:'debit',  level:1, displayOrder:100, isSystem:true },
  { code:'1100', name:'Trade Debtors',          type:'asset',     normalBalance:'debit',  level:1, displayOrder:110, isSystem:true },
  { code:'1200', name:'Other Current Assets',   type:'asset',     normalBalance:'debit',  level:1, displayOrder:120 },
  { code:'1500', name:'Fixed Assets',           type:'asset',     normalBalance:'debit',  level:1, displayOrder:150 },
  { code:'2000', name:'Trade Creditors',        type:'liability', normalBalance:'credit', level:1, displayOrder:200, isSystem:true },
  { code:'2100', name:'VAT & Tax',              type:'liability', normalBalance:'credit', level:1, displayOrder:210, isSystem:true },
  { code:'2300', name:'Short-term Liabilities', type:'liability', normalBalance:'credit', level:1, displayOrder:230 },
  { code:'2500', name:'Long-term Liabilities',  type:'liability', normalBalance:'credit', level:1, displayOrder:250 },
  { code:'3000', name:'Equity',                 type:'equity',    normalBalance:'credit', level:1, displayOrder:300, isSystem:true },
  { code:'4000', name:'Sales Income',           type:'revenue',   normalBalance:'credit', level:1, displayOrder:400, isSystem:true },
  { code:'4100', name:'Other Income',           type:'revenue',   normalBalance:'credit', level:1, displayOrder:410 },
  { code:'5000', name:'Cost of Sales',          type:'expense',   normalBalance:'debit',  level:1, displayOrder:500, isSystem:true },
  { code:'6000', name:'Operating Expenses',     type:'expense',   normalBalance:'debit',  level:1, displayOrder:600 },
  { code:'1001', name:'Current Account',        type:'asset',     normalBalance:'debit',  level:2, displayOrder:101, parentCode:'1000', subtype:'bank',                    isSystem:true },
  { code:'1002', name:'Petty Cash',             type:'asset',     normalBalance:'debit',  level:2, displayOrder:102, parentCode:'1000' },
  { code:'1101', name:'Trade Debtors Control',  type:'asset',     normalBalance:'debit',  level:2, displayOrder:111, parentCode:'1100', subtype:'receivable',               isSystem:true },
  { code:'1201', name:'VAT Input',              type:'asset',     normalBalance:'debit',  level:2, displayOrder:121, parentCode:'1200', subtype:'vat_input',                isSystem:true },
  { code:'1202', name:'Prepayments',            type:'asset',     normalBalance:'debit',  level:2, displayOrder:122, parentCode:'1200' },
  { code:'1501', name:'Equipment',              type:'asset',     normalBalance:'debit',  level:2, displayOrder:151, parentCode:'1500', subtype:'fixed_asset' },
  { code:'1502', name:'Vehicles',               type:'asset',     normalBalance:'debit',  level:2, displayOrder:152, parentCode:'1500', subtype:'fixed_asset' },
  { code:'1600', name:'Accumulated Depreciation',type:'asset',    normalBalance:'credit', level:2, displayOrder:160, parentCode:'1500', subtype:'accumulated_depreciation', isSystem:true },
  { code:'2001', name:'Trade Creditors Control',type:'liability', normalBalance:'credit', level:2, displayOrder:201, parentCode:'2000', subtype:'payable',                  isSystem:true },
  { code:'2101', name:'VAT Output',             type:'liability', normalBalance:'credit', level:2, displayOrder:211, parentCode:'2100', subtype:'vat_output',               isSystem:true },
  { code:'2102', name:'PAYE Liability',         type:'liability', normalBalance:'credit', level:2, displayOrder:212, parentCode:'2100' },
  { code:'2301', name:'Short-term Loans',       type:'liability', normalBalance:'credit', level:2, displayOrder:231, parentCode:'2300' },
  { code:'2501', name:'Long-term Loans',        type:'liability', normalBalance:'credit', level:2, displayOrder:251, parentCode:'2500' },
  { code:'3100', name:'Share Capital',          type:'equity',    normalBalance:'credit', level:2, displayOrder:310, parentCode:'3000', subtype:'equity',            isSystem:true },
  { code:'3200', name:'Retained Earnings',      type:'equity',    normalBalance:'credit', level:2, displayOrder:320, parentCode:'3000', subtype:'retained_earnings',  isSystem:true },
  { code:'4001', name:'Product Sales',          type:'revenue',   normalBalance:'credit', level:2, displayOrder:401, parentCode:'4000', subtype:'default_revenue',    isSystem:true },
  { code:'4101', name:'Interest Received',      type:'revenue',   normalBalance:'credit', level:2, displayOrder:411, parentCode:'4100', subtype:'other_income' },
  { code:'5001', name:'Cost of Goods Sold',     type:'expense',   normalBalance:'debit',  level:2, displayOrder:501, parentCode:'5000', subtype:'default_expense',    isSystem:true },
  { code:'6001', name:'Salaries & Wages',       type:'expense',   normalBalance:'debit',  level:2, displayOrder:601, parentCode:'6000', subtype:'operating_expense' },
  { code:'6002', name:'Rent & Premises',        type:'expense',   normalBalance:'debit',  level:2, displayOrder:602, parentCode:'6000', subtype:'operating_expense' },
  { code:'6003', name:'Bank Charges',           type:'expense',   normalBalance:'debit',  level:2, displayOrder:603, parentCode:'6000', subtype:'operating_expense' },
  { code:'6004', name:'Depreciation',           type:'expense',   normalBalance:'debit',  level:2, displayOrder:604, parentCode:'6000', subtype:'depreciation_expense', isSystem:true },
  { code:'6005', name:'Administrative Expenses',type:'expense',   normalBalance:'debit',  level:2, displayOrder:605, parentCode:'6000', subtype:'admin_expense',       isSystem:true },
  { code:'6006', name:'Marketing & Advertising',type:'expense',   normalBalance:'debit',  level:2, displayOrder:606, parentCode:'6000' },
];

function getTemplateLines(template: CoaTemplate): TemplateLine[] {
  if (template === 'isaflow_standard') return ISAFLOW_TEMPLATE;
  if (template === 'xero_compatible')  return XERO_TEMPLATE;
  if (template === 'sage_compatible')  return SAGE_TEMPLATE;
  return [];
}

/**
 * Seed a Chart of Accounts for a newly-created company from the chosen template.
 * Two-pass insert: first without parent_account_id, then wire up parents.
 */
export async function seedChartOfAccountsFromTemplate(
  companyId: string,
  template: CoaTemplate,
): Promise<void> {
  const lines = getTemplateLines(template);
  if (lines.length === 0) return; // 'blank' — no seeding

  // Pass 1: insert all accounts (no parent yet)
  for (const acc of lines) {
    await sql`
      INSERT INTO gl_accounts (
        company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, level, display_order, is_system_account
      ) VALUES (
        ${companyId}, ${acc.code}, ${acc.name}, ${acc.type},
        ${acc.subtype ?? null}, ${acc.normalBalance}, ${acc.level},
        ${acc.displayOrder}, ${acc.isSystem ?? false}
      )
      ON CONFLICT (company_id, account_code) DO NOTHING
    `;
  }

  // Pass 2: wire up parent_account_id
  const withParent = lines.filter(a => a.parentCode);
  for (const acc of withParent) {
    await sql`
      UPDATE gl_accounts
      SET parent_account_id = (
        SELECT id FROM gl_accounts
        WHERE company_id = ${companyId} AND account_code = ${acc.parentCode!}
      )
      WHERE company_id = ${companyId} AND account_code = ${acc.code}
    `;
  }

  cache.invalidatePrefix(`${companyId}:gl-accounts`);
  log.info('COA seeded from template', { companyId, template, count: lines.length }, 'accounting');
}

// ── Account Balance ───────────────────────────────────────────────────────────

export async function getAccountBalance(
  accountId: string,
  fiscalPeriodId?: string,
): Promise<{ debitTotal: number; creditTotal: number; balance: number }> {
  try {
    let rows: { debit_total: string; credit_total: string; balance: string }[];
    if (fiscalPeriodId) {
      rows = await sql`
        SELECT debit_total, credit_total, balance
        FROM gl_account_balances
        WHERE gl_account_id = ${accountId} AND fiscal_period_id = ${fiscalPeriodId}
      ` as typeof rows;
    } else {
      rows = await sql`
        SELECT
          COALESCE(SUM(debit_total), 0) AS debit_total,
          COALESCE(SUM(credit_total), 0) AS credit_total,
          COALESCE(SUM(balance), 0) AS balance
        FROM gl_account_balances
        WHERE gl_account_id = ${accountId}
      ` as typeof rows;
    }

    if (rows.length === 0) return { debitTotal: 0, creditTotal: 0, balance: 0 };

    return {
      debitTotal: Number(rows[0]!.debit_total),
      creditTotal: Number(rows[0]!.credit_total),
      balance: Number(rows[0]!.balance),
    };
  } catch (err) {
    log.error('Failed to get account balance', { accountId, error: err }, 'accounting');
    throw err;
  }
}
