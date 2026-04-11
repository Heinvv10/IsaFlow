/**
 * Shared types for the customer duplicates feature.
 * Used by the API route and the customers list page.
 */

export interface DuplicatePair {
  id_a: string;
  name_a: string;
  email_a: string | null;
  vat_a: string | null;
  invoice_count_a: number;
  id_b: string;
  name_b: string;
  email_b: string | null;
  vat_b: string | null;
  invoice_count_b: number;
  match_reason: 'email' | 'vat' | 'name';
}
