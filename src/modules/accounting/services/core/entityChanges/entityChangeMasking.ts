/**
 * Which recorded values are masked (Hein's decision 2, 2026-10-10): bank
 * account numbers and ID / tax numbers are stored in full and shown as their
 * last four characters to everyone; owner / admin may reveal one change in
 * full (entityChangeReveal.ts, audited). A changed value stays visibly
 * changed: …1234 → …9876.
 */
import type { EntityChangeField, EntityType } from './entityChangeTypes';

export const SENSITIVE_FIELDS: Readonly<Record<EntityType, readonly string[]>> = {
  supplier: ['bank_account_number'],
  customer: [],
  gl_account: ['bank_account_number'],
  payroll_employee: ['id_number', 'passport_number', 'tax_number', 'tax_directive_number', 'uif_number'],
  company_user: [],
  company_invitation: [],
  company_user_permission: [],
  company: ['bank_account_number', 'tax_number', 'paye_reference_number', 'sdl_reference_number', 'uif_reference_number'],
  approval_rule: [],
  approval_enforcement: [],
};

export const isSensitive = (type: EntityType, key: string): boolean => SENSITIVE_FIELDS[type].includes(key);

/** The last four characters behind an ellipsis; four or fewer are hidden entirely. */
export function maskValue(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return value;
  const text = String(value).trim();
  if (text.length <= 4) return '••••';
  return `…${text.slice(-4)}`;
}

/** The changed fields of one change, masked unless `reveal`. Keys sorted as recorded. */
export function changeFields(
  type: EntityType,
  changed: readonly string[],
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  reveal = false,
): EntityChangeField[] {
  return changed.map((key) => {
    const masked = !reveal && isSensitive(type, key);
    const b = before ? (before[key] ?? null) : null;
    const a = after ? (after[key] ?? null) : null;
    return { key, before: masked ? maskValue(b) : b, after: masked ? maskValue(a) : a, masked };
  });
}
