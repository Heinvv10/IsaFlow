/**
 * The e@syFile employer record's input from the company row (moved out of easyFileInput.ts, unchanged, for the 300-line cap).
 */
import type { DbRow } from '@/lib/neon';
import type { EmployerInput } from './easyFileTypes';
import { reconciliationPeriodCode, type Emp501Period } from './emp501Period';

export function employerInputOf(company: DbRow, payeRef: string, taxYear: number, period: Emp501Period): EmployerInput {
  return {
    tradingName: String(company.trading_name),
    payeReferenceNumber: payeRef,
    sdlReferenceNumber: company.sdl_reference_number ? String(company.sdl_reference_number) : null,
    uifReferenceNumber: company.uif_reference_number ? String(company.uif_reference_number) : null,
    contactFirstName: String(company.sars_contact_first_name),
    contactSurname: String(company.sars_contact_last_name),
    contactBusinessPhone: company.sars_contact_telephone ? String(company.sars_contact_telephone) : null,
    contactCellPhone: company.sars_contact_number ? String(company.sars_contact_number) : null,
    contactEmail: company.email ? String(company.email) : null,
    transactionYear: taxYear,
    reconciliationPeriod: reconciliationPeriodCode(period),
    sic7Code: company.sic7_code ? String(company.sic7_code) : null,
    physicalStreet: String(company.physical_address_line1),
    // 2065 is the suburb / district (BRS V25.3.0 p. 14); the company holds no suburb, and a province is neither.
    physicalSuburb: null,
    physicalCity: company.physical_city ? String(company.physical_city) : null,
    physicalPostalCode: String(company.physical_postal_code),
  };
}
