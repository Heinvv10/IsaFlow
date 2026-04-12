/**
 * Shared types for the supplier duplicates feature.
 * Used by the API route and the suppliers dedup page.
 */

export interface SupplierDuplicatePair {
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
