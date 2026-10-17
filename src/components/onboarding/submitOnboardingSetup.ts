/**
 * The wizard's one submit: POST /api/onboarding/complete-setup, which creates
 * the company, chart, people and documents and finishes onboarding in a single
 * transaction. `requestKey` is generated once per wizard session and re-sent on
 * every retry, so a retry after a lost response returns the company the first
 * request created instead of making a second one.
 */

import { ApiEnvelopeError, apiFetch, assertOk } from '@/lib/apiFetch';
import type { WizardData } from './wizardTypes';

/**
 * A v4 UUID for the request key. crypto.randomUUID exists only on secure
 * origins (https, localhost); on plain http the wizard must still work, so it
 * falls back to getRandomValues (available everywhere), then Math.random.
 */
export function newRequestKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

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
      vatPeriod: d.vatPeriod, // vat_system_type follows it on the server (onboardingSetupWriters)
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
