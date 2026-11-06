/** A contact GET's row, with the company's default terms as the two plain fields the pages read. */
import { companyTermsFromSetting } from '../shared/paymentTerms';

export function withCompanyDefaultTerms<R extends Record<string, unknown>>(row: R, companyId: string): Omit<R, 'company_default_terms'> & {
  company_default_payment_terms: number; company_default_payment_terms_type: string;
} {
  const { company_default_terms: stored, ...rest } = row;
  const t = companyTermsFromSetting(stored, companyId);
  return { ...rest, company_default_payment_terms: t.days, company_default_payment_terms_type: t.type };
}
