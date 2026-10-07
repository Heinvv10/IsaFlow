/**
 * A company with a revenue chart to code invoice lines against (migration
 * 870): default_revenue plus two revenue lines, every account a line must be
 * refused, two projects and a cancelled one, an active and an inactive cost
 * centre — and a SECOND company holding one of each, for the tenancy arms.
 *
 * Built on l1FifoFixture (AR, VAT Output, an open FY2026). Disposable
 * databases only: the suites using it skip unless isDisposableDb().
 */
import { sql } from '@/lib/neon';
import { dropFixture, seedFixture, type Fixture } from './l1FifoFixture';

export interface LineRevenueFixture {
  fx: Fixture;
  other: Fixture;
  acct: {
    defaultRevenue: string; commercials: string; postProduction: string;
    header: string; headerChild: string; inactive: string; expense: string; foreign: string;
  };
  project: { p1: string; p2: string; cancelled: string; foreign: string };
  centre: { active: string; inactive: string; foreign: string };
}

async function account(
  fx: Fixture, code: string, name: string, type: string,
  opts: { subtype?: string; active?: boolean; system?: boolean; parent?: string } = {},
): Promise<string> {
  const rows = (await sql`
    INSERT INTO gl_accounts
      (company_id, account_code, account_name, account_type, account_subtype,
       normal_balance, is_active, is_system_account, parent_account_id)
    VALUES (${fx.companyId}::UUID, ${code}, ${`${name} ${fx.tag}`}, ${type}, ${opts.subtype ?? null},
            ${type === 'revenue' ? 'credit' : 'debit'}, ${opts.active ?? true}, ${opts.system ?? false},
            ${opts.parent ?? null}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

async function project(fx: Fixture, number: string, status = 'active'): Promise<string> {
  const rows = (await sql`
    INSERT INTO projects (company_id, project_number, name, client_id, status)
    VALUES (${fx.companyId}::UUID, ${`${number}-${fx.tag}`}, ${`Production ${number}`},
            ${fx.customerId}::UUID, ${status})
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

async function centre(fx: Fixture, code: string, active = true): Promise<string> {
  const rows = (await sql`
    INSERT INTO cost_centres (company_id, code, name, is_active)
    VALUES (${fx.companyId}::UUID, ${code}, ${`Centre ${code}`}, ${active})
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

export async function seedLineRevenue(databaseUrl: string): Promise<LineRevenueFixture> {
  const fx = await seedFixture('linerev', databaseUrl);
  const other = await seedFixture('linerev-other', databaseUrl);
  const header = await account(fx, '4300', 'Studio header', 'revenue');
  return {
    fx,
    other,
    acct: {
      defaultRevenue: await account(fx, '4000', 'Sales', 'revenue', { subtype: 'default_revenue', system: true }),
      commercials: await account(fx, '4100', 'Commercials', 'revenue', { subtype: 'revenue' }),
      postProduction: await account(fx, '4200', 'Post-production', 'revenue', { subtype: 'revenue' }),
      header,
      headerChild: await account(fx, '4310', 'Studio child', 'revenue', { parent: header }),
      inactive: await account(fx, '4400', 'Retired line', 'revenue', { active: false }),
      expense: await account(fx, '6100', 'Crew', 'expense'),
      foreign: await account(other, '4100', 'Other company sales', 'revenue'),
    },
    project: {
      p1: await project(fx, 'P1'),
      p2: await project(fx, 'P2'),
      cancelled: await project(fx, 'P3', 'cancelled'),
      foreign: await project(other, 'PX'),
    },
    centre: {
      active: await centre(fx, 'CC1'),
      inactive: await centre(fx, 'CC2', false),
      foreign: await centre(other, 'CCX'),
    },
  };
}

export async function dropLineRevenue(f: LineRevenueFixture): Promise<void> {
  for (const fx of [f.fx, f.other]) {
    const c = fx.companyId;
    await sql`DELETE FROM credit_note_allocations WHERE credit_note_id IN (
      SELECT id FROM credit_notes WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM customer_invoice_items WHERE invoice_id IN (
      SELECT id FROM customer_invoices WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM projects WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM cost_centres WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM company_document_numbers WHERE company_id = ${c}::UUID`;
    await dropFixture(fx);
  }
}
