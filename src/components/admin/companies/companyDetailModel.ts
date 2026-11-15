/**
 * Company detail (pages/admin/companies/[id].tsx): the API shapes it reads and the edit form's fields.
 */
import type { CompanyEffectiveFeature } from '@/modules/admin/types/admin-billing.types';

export interface CompanyDetail {
  id: string;
  name: string;
  trading_name: string | null;
  registration_number: string | null;
  vat_number: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  billing_email: string | null;
  billing_contact: string | null;
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  plan_name: string;
  billing_cycle: string;
  status: string;
  created_at: string;
  last_active: string | null;
}

export type EditableKey =
  | 'name' | 'trading_name' | 'email' | 'phone' | 'website'
  | 'billing_email' | 'billing_contact'
  | 'address_line1' | 'city' | 'province' | 'postal_code';

export type EditForm = Record<EditableKey, string>;

export const EDITABLE_KEYS: EditableKey[] = [
  'name', 'trading_name', 'email', 'phone', 'website',
  'billing_email', 'billing_contact',
  'address_line1', 'city', 'province', 'postal_code',
];

export function toEditForm(c: CompanyDetail): EditForm {
  return {
    name:            c.name ?? '',
    trading_name:    c.trading_name ?? '',
    email:           c.email ?? '',
    phone:           c.phone ?? '',
    website:         c.website ?? '',
    billing_email:   c.billing_email ?? '',
    billing_contact: c.billing_contact ?? '',
    address_line1:   c.address_line1 ?? '',
    city:            c.city ?? '',
    province:        c.province ?? '',
    postal_code:     c.postal_code ?? '',
  };
}

// The API's shape (getCompanyUsers): one `name`, the full name or the email (audit 4.6: the page read
// first_name/last_name, which the API never sends, so every Name cell was blank).
export interface CompanyUser {
  id: string;
  name: string;
  email: string;
  role: string;
  last_login: string | null;
}

// Deliberately the server's own type, not a local copy. A local duplicate that
// claimed an `id` the API never sent is what made every feature toggle post
// `feature_id: undefined` and silently 400.
export type CompanyFeature = CompanyEffectiveFeature;

export const STATUS_BADGE: Record<string, string> = {
  active:    'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  trial:     'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  suspended: 'bg-red-500/10 text-red-500',
  cancelled: 'bg-gray-500/10 text-gray-500',
  deleted:   'bg-orange-500/10 text-orange-600 dark:text-orange-400',
};
