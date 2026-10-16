/**
 * The wizard's one submit: POST /api/onboarding/complete-setup, which creates
 * the company, chart, people and documents and finishes onboarding in a single
 * transaction. `requestKey` is generated once per wizard session and re-sent on
 * every retry, so a retry after a lost response returns the company the first
 * request created instead of making a second one.
 */

import { ApiEnvelopeError, apiFetch, assertOk } from '@/lib/apiFetch';
import type { WizardData } from './wizardTypes';

export function setupRequestBody(d: WizardData, requestKey: string) {
  return {
    requestKey,
    entityType: d.entityType,
    coaTemplate: d.coaTemplate,
    company: {
      name: d.name, tradingName: d.tradingName,
      registrationNumber: d.registrationNumber, vatNumber: d.vatNumber,
      taxNumber: d.taxNumber, addressLine1: d.addressLine1,
      addressLine2: d.addressLine2, city: d.city, province: d.province,
      postalCode: d.postalCode, country: d.country, phone: d.phone,
      email: d.email, website: d.website, logoData: d.logoData || undefined,
      bankName: d.bankName || undefined,
      bankAccountNumber: d.bankAccountNumber || undefined,
      bankBranchCode: d.bankBranchCode || undefined,
      bankAccountType: d.bankAccountType,
      financialYearStart: d.financialYearStart,
      vatPeriod: d.vatPeriod,
      // Keep both VAT columns in step from the first write — the AFS
      // accounting-policy notes read vat_system_type, not vat_period.
      vatSystemType: d.vatPeriod === 'none' ? 'none' : 'invoice',
      defaultCurrency: d.defaultCurrency,
    },
    people: d.directors.map(p => ({
      name: p.name, idNumber: p.idNumber,
      ...(p.idDocument ? { idDocument: { name: p.idDocument.name, data: p.idDocument.data } } : {}),
    })),
    documents: d.documents.map(doc => ({ type: doc.type, name: doc.name, data: doc.data, mimeType: doc.mimeType, size: doc.size })),
  };
}

/** Resolves with the new company's id; throws an ApiEnvelopeError with a sentence the page shows. */
export async function submitOnboardingSetup(d: WizardData, requestKey: string): Promise<string> {
  const res = await apiFetch('/api/onboarding/complete-setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(setupRequestBody(d, requestKey)),
  });
  await assertOk(res, 'Could not finish setting up your company - try again');
  const body = await res.json() as { data?: { companyId?: string } };
  const companyId = body.data?.companyId;
  if (!companyId) throw new ApiEnvelopeError('The company was not set up - try again');
  return companyId;
}
