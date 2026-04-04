/**
 * Invoice PDF Service — re-export facade for backward compatibility.
 *
 * Domain logic lives in:
 *   pdfShared.ts            — formatting helpers, company details, branding
 *   invoicePdfBuilder.ts    — customer invoice PDF generation
 *   creditNotePdfBuilder.ts — credit note PDF generation
 */

export { generateInvoicePdf } from './invoicePdfBuilder';
export { generateCreditNotePdf } from './creditNotePdfBuilder';

// Re-export shared types for any consumers that import from this file
export type { CompanyDetails } from './pdfShared';
