/**
 * The wizard's data as the per-entity rules see it (entityOnboardingRules), so
 * the Continue gating and POST /api/onboarding/complete-setup judge the same facts.
 */

import { DEFAULT_ENTITY_TYPE } from '@/lib/entityTypes';
import type { SetupFacts } from '@/modules/onboarding/services/entityOnboardingRules';
import type { WizardData } from './wizardTypes';

export function factsOf(d: WizardData): SetupFacts {
  return {
    entityType: d.entityType ?? DEFAULT_ENTITY_TYPE,
    name: d.name,
    people: d.directors.map(p => ({ name: p.name, hasIdDocument: Boolean(p.idDocument) })),
    documentTypes: d.documents.map(doc => doc.type),
  };
}
