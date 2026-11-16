/**
 * Expected cash items of the 13-week forecast (cash_forecast_items, migration 999i): receipts and
 * payments a user types. Forecasts, so they are edited and deleted freely; every write runs in the
 * request transaction, refuses a Login-as session first, and writes one audit row
 * (entity_type 'cash_forecast_item'). The table's trigger stamps who and when.
 */
import { sql } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { toIsoTimestamp } from '@/lib/dateUtils';
import type { DbRow } from '@/types/db';
import { logAuditOrThrow, type AuditFieldChange } from '../core/auditTrailService';
import { CashForecastInputError, CashForecastNotFoundError } from './storeErrors';
import type { ItemInput } from './storeSchemas';
import { CASH_CATEGORIES, type ManualCashItem } from './storeTypes';

export interface StoredCashItem extends ManualCashItem { updatedAt: string }

function toItem(r: DbRow): StoredCashItem {
  const item: StoredCashItem = {
    id: String(r.id),
    direction: r.direction === 'payment' ? 'payment' : 'receipt',
    amount: Number(r.amount),
    date: String(r.expected_date),
    repeat: r.repeat === 'weekly' || r.repeat === 'monthly' ? r.repeat : 'none',
    repeatUntil: r.repeat_until == null ? null : String(r.repeat_until),
    description: String(r.description),
    category: CASH_CATEGORIES.find((c) => c === r.category) ?? 'other',
    updatedAt: toIsoTimestamp(r.updated_at as Date | string) ?? '',
  };
  if (r.gl_account_id != null) item.accountId = String(r.gl_account_id);
  return item;
}

const COLUMNS = sql`id, direction, amount, expected_date::text AS expected_date, repeat, repeat_until::text AS repeat_until,
  description, category, gl_account_id, updated_at`;

export async function listItems(companyId: string): Promise<StoredCashItem[]> {
  const rows = (await sql`
    SELECT ${COLUMNS} FROM cash_forecast_items WHERE company_id = ${companyId}::UUID ORDER BY expected_date, created_at, id
  `) as DbRow[];
  return rows.map(toItem);
}

/** The account must be one of the company's (the table's trigger refuses it too, as a 23514). */
async function assertAccount(companyId: string, accountId: string | null): Promise<void> {
  if (accountId === null) return;
  const rows = (await sql`SELECT 1 FROM gl_accounts WHERE id = ${accountId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  if (rows.length === 0) throw new CashForecastInputError('The account is not one of this company\'s accounts');
}

const LABELS: Record<string, string> = {
  direction: 'Direction', amount: 'Amount', date: 'Expected date', repeat: 'Repeat',
  repeatUntil: 'Repeat until', description: 'Description', category: 'Category', accountId: 'Account',
};
const fieldsOf = (i: Partial<ManualCashItem>) => ({
  direction: i.direction, amount: i.amount, date: i.date, repeat: i.repeat,
  repeatUntil: i.repeatUntil ?? null, description: i.description, category: i.category, accountId: i.accountId ?? null,
});

function changes(before: Partial<ManualCashItem>, after: Partial<ManualCashItem>): AuditFieldChange[] {
  const a = fieldsOf(before), b = fieldsOf(after);
  return (Object.keys(LABELS) as Array<keyof typeof a>)
    .filter((k) => a[k] !== b[k])
    .map((k) => ({ field: k, label: LABELS[k]!, old: a[k] == null ? null : String(a[k]), new: b[k] == null ? null : String(b[k]) }));
}

export async function createItem(companyId: string, userId: string, input: ItemInput): Promise<StoredCashItem> {
  await assertNotImpersonating();
  await assertAccount(companyId, input.accountId);
  const rows = (await sql`
    INSERT INTO cash_forecast_items (company_id, direction, amount, expected_date, repeat, repeat_until, description, category, gl_account_id)
    VALUES (${companyId}::UUID, ${input.direction}, ${input.amount}, ${input.date}::DATE, ${input.repeat},
            ${input.repeatUntil}::DATE, ${input.description}, ${input.category}, ${input.accountId}::UUID)
    RETURNING ${COLUMNS}
  `) as DbRow[];
  const item = toItem(rows[0]!);
  await logAuditOrThrow({
    companyId, userId, action: 'create', entityType: 'cash_forecast_item', entityId: item.id, entityRef: item.description,
    changes: { fields: changes({}, item), metadata: { area: 'cash_forecast_13' } },
  });
  return item;
}

async function lockItem(companyId: string, id: string): Promise<StoredCashItem> {
  const rows = (await sql`
    SELECT ${COLUMNS} FROM cash_forecast_items WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID FOR UPDATE
  `) as DbRow[];
  if (rows.length === 0) throw new CashForecastNotFoundError('No such cash forecast item');
  return toItem(rows[0]!);
}

export async function updateItem(companyId: string, userId: string, id: string, input: ItemInput): Promise<StoredCashItem> {
  await assertNotImpersonating();
  const before = await lockItem(companyId, id);
  await assertAccount(companyId, input.accountId);
  const rows = (await sql`
    UPDATE cash_forecast_items
       SET direction = ${input.direction}, amount = ${input.amount}, expected_date = ${input.date}::DATE, repeat = ${input.repeat},
           repeat_until = ${input.repeatUntil}::DATE, description = ${input.description}, category = ${input.category},
           gl_account_id = ${input.accountId}::UUID
     WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING ${COLUMNS}
  `) as DbRow[];
  const item = toItem(rows[0]!);
  await logAuditOrThrow({
    companyId, userId, action: 'update', entityType: 'cash_forecast_item', entityId: id, entityRef: item.description,
    changes: { fields: changes(before, item), metadata: { area: 'cash_forecast_13' } },
  });
  return item;
}

export async function deleteItem(companyId: string, userId: string, id: string): Promise<void> {
  await assertNotImpersonating();
  const before = await lockItem(companyId, id);
  await sql`DELETE FROM cash_forecast_items WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;
  await logAuditOrThrow({
    companyId, userId, action: 'delete', entityType: 'cash_forecast_item', entityId: id, entityRef: before.description,
    changes: { fields: changes(before, {}), metadata: { area: 'cash_forecast_13' } },
  });
}
