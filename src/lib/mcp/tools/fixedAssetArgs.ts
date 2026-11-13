/**
 * Argument parsing for `create_fixed_asset`: everything that can be refused WITHOUT a query.
 *
 * It ends in the SAME `validateAsset` the REST route runs, so the tool can never accept what the route refuses; the
 * checks before it are the ones the route lacks and a Postgres column would otherwise answer with a raw error
 * (NUMERIC(15,2) cost, NUMERIC(5,2) life, NUL in text) or silently round (a third decimal on the cost).
 */
import { parseGlAssetAccountId, validateAsset, type AssetInput } from '@/modules/accounting/services/items/assetService';
import { hasNul, isRealCalendarDate } from '@/lib/validation';
import { hasWholeCents } from './toolHelpers';

export const DEPRECIATION_METHODS = ['straight_line', 'reducing_balance', 'sum_of_years'] as const;
/** assets.useful_life_years is NUMERIC(5,2). */
const MAX_LIFE_YEARS = 999.99;
const MIN_PURCHASE_YEAR = 1900;
const TEXT_LIMITS = { name: 200, description: 1000, serial_number: 100, location: 200 } as const;

export type FixedAssetParse = { ok: true; input: AssetInput } | { ok: false; error: string };

function text(args: Record<string, unknown>, key: keyof typeof TEXT_LIMITS): string | undefined | { error: string } {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return { error: `${key} must be a string` };
  const t = v.trim();
  if (t === '') return undefined;
  if (hasNul(t)) return { error: `${key} contains a NUL byte, which cannot be stored` };
  if (t.length > TEXT_LIMITS[key]) return { error: `${key} is longer than ${TEXT_LIMITS[key]} characters` };
  return t;
}

function num(args: Record<string, unknown>, key: string): number | undefined | { error: string } {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${key} must be a number` };
  return v;
}

function isError(v: unknown): v is { error: string } {
  return typeof v === 'object' && v !== null && 'error' in v;
}

/** Pre-query validation. The category is checked against the register's categories by the caller, which needs a read. */
export function parseFixedAssetArgs(args: Record<string, unknown>): FixedAssetParse {
  const fail = (error: string): FixedAssetParse => ({ ok: false, error });

  const name = text(args, 'name');
  const description = text(args, 'description');
  const serial = text(args, 'serial_number');
  const location = text(args, 'location');
  for (const t of [name, description, serial, location]) if (isError(t)) return fail(t.error);

  const category = typeof args.category === 'string' ? args.category.trim() : '';
  if (!category) return fail('category is required: a code from the fixed asset categories (e.g. computers)');
  if (hasNul(category)) return fail('category contains a NUL byte, which cannot be stored');

  const cost = num(args, 'cost');
  const salvage = num(args, 'salvage_value');
  const life = num(args, 'useful_life_years');
  for (const n of [cost, salvage, life]) if (isError(n)) return fail(n.error);
  if (typeof cost !== 'number' || cost <= 0) return fail('cost must be greater than zero');
  if (!hasWholeCents(cost)) return fail('cost must be a whole number of cents, at most 9999999999999.99');
  if (salvage !== undefined && (typeof salvage !== 'number' || salvage < 0 || !hasWholeCents(salvage))) {
    return fail('salvage_value must be zero or more, in whole cents');
  }
  if (typeof life !== 'number' || life <= 0) return fail('useful_life_years must be greater than zero');
  if (life > MAX_LIFE_YEARS || Math.round(life * 100) / 100 !== life || life < 0.01) {
    return fail(`useful_life_years must be between 0.01 and ${MAX_LIFE_YEARS}, with at most 2 decimals`);
  }

  const date = typeof args.purchase_date === 'string' ? args.purchase_date.trim() : '';
  if (!date) return fail('purchase_date is required (YYYY-MM-DD)');
  if (!isRealCalendarDate(date)) return fail('invalid purchase_date');
  if (Number(date.slice(0, 4)) < MIN_PURCHASE_YEAR) return fail(`purchase_date cannot be before ${MIN_PURCHASE_YEAR}`);

  const method = args.depreciation_method;
  if (method !== undefined && method !== null
    && !(DEPRECIATION_METHODS as readonly unknown[]).includes(method)) {
    return fail(`depreciation_method must be one of ${DEPRECIATION_METHODS.join(', ')}`);
  }

  const account = parseGlAssetAccountId(args.gl_asset_account_id);
  if (!account.ok) return fail(account.error);

  const input: AssetInput = {
    name: typeof name === 'string' ? name : '',
    category,
    sarsCategory: category,
    purchaseDate: date,
    cost,
    salvageValue: typeof salvage === 'number' ? salvage : 0,
    usefulLifeYears: life,
    depreciationMethod: typeof method === 'string' ? method : 'straight_line',
    ...(typeof description === 'string' ? { description } : {}),
    ...(typeof serial === 'string' ? { serialNumber: serial } : {}),
    ...(typeof location === 'string' ? { location } : {}),
    ...(account.id ? { glAssetAccountId: account.id } : {}),
  };
  const valid = validateAsset(input);
  if (!valid.success) return fail((valid.errors ?? []).map((e) => e.message).join('; '));
  return { ok: true, input };
}
