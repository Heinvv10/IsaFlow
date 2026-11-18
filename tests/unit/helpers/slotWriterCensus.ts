/**
 * Writers of tracked tables (entityChangeCensus.test.ts) under scripts/ci/golden/, kept here so that file does not grow.
 * All of them run on isaflow_dev only: provision-slots.ts refuses any other database before it writes.
 */
export const SLOT_WRITERS: Record<string, string[]> = {
  // The slot's golden owner membership, and the retire of a poisoned slot company.
  company_users: ['scripts/ci/golden/slotProvision.ts'],
  // The slot company row (copied from Demo), its rename on retire, and the contact-email move off @isaflow.dev (slotEmailApply.ts).
  companies: ['scripts/ci/golden/cloneCompany.ts', 'scripts/ci/golden/slotEmailApply.ts', 'scripts/ci/golden/slotProvision.ts'],
};
