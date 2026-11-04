/**
 * The company fields a document prints (the header, the FROM block, the payment details): what invoicePdfModel reads,
 * and all the shared PDF renderers take. Kept apart from pdfShared.ts, which is past its size.
 */
import type { CompanyDetails } from './pdfShared';

export type PrintedCompany = Pick<CompanyDetails, 'name' | 'address' | 'phone' | 'email' | 'vatNumber' | 'bankName'
  | 'bankAccountName' | 'bankAccountNumber' | 'bankBranchCode' | 'logoData' | 'primaryColor'>;
