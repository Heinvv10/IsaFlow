/**
 * The wizard's data as the per-entity rules see it (entityOnboardingRules), so
 * the Continue gating and POST /api/onboarding/complete-setup judge the same
 * facts; and the upload total the server caps (uploadLimits).
 */

import { DEFAULT_ENTITY_TYPE } from '@/lib/entityTypes';
import type { SetupFacts } from '@/modules/onboarding/services/entityOnboardingRules';
import { decodedBytes } from '@/modules/onboarding/uploadLimits';
import type { WizardData } from './wizardTypes';

export function factsOf(d: WizardData): SetupFacts {
  return {
    entityType: d.entityType ?? DEFAULT_ENTITY_TYPE,
    name: d.name,
    registrationNumber: d.registrationNumber,
    people: d.directors.map(p => ({
      name: p.name, hasIdDocument: Boolean(p.idDocument), idNumber: p.idNumber, idDocumentData: p.idDocument?.data ?? null,
    })),
    documentTypes: d.documents.map(doc => doc.type),
  };
}

/** Decoded bytes of every file the submit would send (documents, ID documents, logo). */
export function uploadBytesOf(d: WizardData): number {
  return d.documents.reduce((n, doc) => n + doc.size, 0)
    + d.directors.reduce((n, p) => n + (p.idDocument?.size ?? 0), 0)
    + (d.logoData ? decodedBytes(d.logoData) : 0);
}
