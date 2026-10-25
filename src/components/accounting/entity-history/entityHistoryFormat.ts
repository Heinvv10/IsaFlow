/**
 * Display helpers for the entity change history (forensic-controls step 3):
 * field labels, values, the op and channel badges, and SAST times.
 */
import type { Channel } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import { formatDisplayDateTime } from '@/utils/dateFormat';

/** Names that read badly when merely humanised. */
const LABELS: Record<string, string> = {
  vat_number: 'VAT number',
  bank_account_number: 'Bank account number',
  bank_branch_code: 'Branch code',
  id_number: 'ID number',
  uif_number: 'UIF number',
  uif_excluded: 'UIF excluded',
  paye_reference_number: 'PAYE reference',
  sdl_reference_number: 'SDL reference',
  uif_reference_number: 'UIF reference',
  default_vat_code: 'Default VAT code',
  default_vat_type: 'Default VAT type',
  subject_to_drc_vat: 'Subject to DRC VAT',
  vat_input_denied: 'VAT input denied',
  default_cc1_id: 'Default cost centre',
  default_cc2_id: 'Default cost centre 2',
  default_bu_id: 'Default business unit',
  fx_documents_enabled: 'Foreign-currency documents',
  netcash_service_key: 'Netcash service key',
  netcash_payouts_key: 'Netcash payouts key',
  company_id: 'Company',
  user_id: 'User',
};

export function fieldLabel(key: string): string {
  if (LABELS[key]) return LABELS[key];
  const words = key.replace(/_id$/, '').split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export const OP_LABELS = { create: 'Created', update: 'Changed', delete: 'Deleted' } as const;
export const OP_CLASSES = {
  create: 'bg-teal-500/15 text-teal-400',
  update: 'bg-blue-500/15 text-blue-400',
  delete: 'bg-red-500/15 text-red-400',
} as const;

/** Channels that deserve a second look stand out. */
export const CHANNEL_CLASSES: Record<Channel, string> = {
  session: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)]',
  impersonation: 'bg-amber-500/15 text-amber-500',
  token: 'bg-purple-500/15 text-purple-400',
  platform_admin: 'bg-amber-500/15 text-amber-500',
  system: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]',
};

/** The change's date and time in South Africa, not UTC. */
export const sastDateTime = (iso: string): string =>
  formatDisplayDateTime(iso);
