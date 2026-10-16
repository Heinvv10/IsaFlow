/**
 * What onboarding asks of each entity type, as pure functions over
 * `@/lib/entityTypes`. The wizard gates its Continue button with these and
 * POST /api/onboarding/complete-setup refuses a request with the same
 * functions, so the browser and the server cannot disagree about what a
 * sole proprietor or a (Pty) Ltd must upload.
 *
 * One required proof per entity (Hein, 2026-10-16); tax clearance, B-BBEE
 * and the VAT certificate are always optional. Safe on the client and the server.
 */

import {
  getEntityType, isEntityTypeCode, PROOF_DOCUMENT_LABELS, type EntityTypeCode,
} from '@/lib/entityTypes';

export interface DocumentSlot { type: string; label: string; required: boolean }

/** Offered to every entity, never required. */
export const OPTIONAL_DOCUMENT_SLOTS: readonly DocumentSlot[] = [
  { type: 'tax_clearance', label: 'SARS Tax Clearance Certificate', required: false },
  { type: 'bbbee_certificate', label: 'B-BBEE Certificate', required: false },
  { type: 'vat_registration', label: 'VAT Registration Certificate', required: false },
];

/** A person as the rules see them: a name, whether their ID document is attached, and what identifies them. */
export interface PersonFacts {
  name: string;
  hasIdDocument: boolean;
  idNumber?: string | null;
  /**
   * What identifies the ID document's content (the server: sha256 of the
   * decoded bytes; the wizard: its base64): the same file twice is the same
   * person twice.
   */
  idDocumentFingerprint?: string | null;
}

export interface SetupFacts {
  entityType: EntityTypeCode;
  name: string;
  registrationNumber?: string | null;
  people: readonly PersonFacts[];
  /** `document_type` of every company document in the request. */
  documentTypes: readonly string[];
}

/** The required proof document (if the entity has one) followed by the optional slots. */
export function documentSlotsFor(code: EntityTypeCode): DocumentSlot[] {
  const proof = getEntityType(code).requiredProof;
  const required: DocumentSlot[] = proof.kind === 'document'
    ? [{ type: proof.documentType, label: PROOF_DOCUMENT_LABELS[proof.documentType] ?? proof.label, required: true }]
    : [];
  return [...required, ...OPTIONAL_DOCUMENT_SLOTS];
}

export function allowedDocumentTypes(code: EntityTypeCode): string[] {
  return documentSlotsFor(code).map(s => s.type);
}

/** True when the entity's proof is a company document and it is already uploaded. */
export function hasRequiredProofDocument(code: EntityTypeCode, documentTypes: readonly string[]): boolean {
  const proof = getEntityType(code).requiredProof;
  return proof.kind === 'document' && documentTypes.includes(proof.documentType);
}

const namedPeople = (people: readonly PersonFacts[]) => people.filter(p => p.name.trim().length > 0);

/**
 * The same person entered twice is never two partners: the same non-empty ID
 * number, the same ID document, or the same name (case and spacing aside)
 * where neither has an ID number. Two "John Smith"s with different ID numbers,
 * or one with and one without, are two people.
 */
export function duplicatePeopleIssues(people: readonly PersonFacts[]): string[] {
  const issues: string[] = [];
  const unnumbered = new Map<string, string>();
  const ids = new Set<string>();
  const docs = new Set<string>();
  let sameId = false;
  let sameDoc = false;
  for (const p of people) {
    const id = (p.idNumber ?? '').replace(/\s+/g, '').toLowerCase();
    if (id) {
      if (ids.has(id)) sameId = true;
      ids.add(id);
    } else {
      const name = p.name.trim().toLowerCase().replace(/\s+/g, ' ');
      const first = unnumbered.get(name);
      if (first !== undefined) issues.push(`${first} is listed more than once`);
      else unnumbered.set(name, p.name.trim());
    }
    const doc = p.idDocumentFingerprint ?? '';
    if (doc && docs.has(doc)) sameDoc = true;
    if (doc) docs.add(doc);
  }
  if (sameId) issues.push('Two people have the same ID number');
  if (sameDoc) issues.push('Two people have the same ID document');
  return issues;
}

/** What is still missing from the entity's one required proof; empty = satisfied. */
export function proofIssues(facts: SetupFacts): string[] {
  const def = getEntityType(facts.entityType);
  const proof = def.requiredProof;
  if (proof.kind === 'none') return [];
  if (proof.kind === 'document') {
    return facts.documentTypes.includes(proof.documentType) ? [] : [`Upload the ${proof.label}`];
  }
  const named = namedPeople(facts.people);
  if (named.length < proof.minPeople) {
    const role = def.personRole.toLowerCase();
    return [proof.minPeople === 1
      ? `Add the ${role} and upload the ${role}'s ID document`
      : `Add at least ${proof.minPeople} ${def.peopleLabel.toLowerCase()}, each with their ID document`];
  }
  return named.filter(p => !p.hasIdDocument).map(p => `Upload the ID document of ${p.name.trim()}`);
}

/** Every reason the server refuses to finish onboarding; empty = it may finish. */
export function setupIssues(facts: SetupFacts): string[] {
  if (!isEntityTypeCode(facts.entityType)) return ['Choose the type of business'];
  const def = getEntityType(facts.entityType);
  const issues: string[] = [];
  if (!facts.name.trim()) issues.push(`Enter the ${businessNameLabel(facts.entityType).toLowerCase()}`);
  const named = namedPeople(facts.people);
  if (def.maxPeople !== null && named.length > def.maxPeople) {
    issues.push(`A ${def.label.toLowerCase()} has ${def.maxPeople} ${def.personRole.toLowerCase()}`);
  }
  issues.push(...duplicatePeopleIssues(named));
  const reg = registrationNumberFor(facts.entityType, facts.registrationNumber);
  const regEntity = reg ? entityFromRegistrationNumber(reg) : null;
  if (regEntity && regEntity !== facts.entityType) {
    issues.push(`That registration number belongs to a ${getEntityType(regEntity).label}, not a ${def.label}`);
  }
  const allowed = allowedDocumentTypes(facts.entityType);
  for (const type of new Set(facts.documentTypes)) {
    if (!allowed.includes(type)) {
      const label = PROOF_DOCUMENT_LABELS[type] ?? type;
      issues.push(`${label} is not a document for a ${def.label}`);
    }
  }
  return [...issues, ...proofIssues(facts)];
}

/** The registration number to store: null for entities that have none (sole proprietor, partnership, other). */
export function registrationNumberFor(code: EntityTypeCode, raw: string | null | undefined): string | null {
  if (!getEntityType(code).registration) return null;
  const value = (raw ?? '').trim();
  return value || null;
}

/** Label of the name field. */
export function businessNameLabel(code: EntityTypeCode): string {
  if (code === 'sole_proprietor') return 'Business name';
  if (code === 'partnership') return 'Partnership name';
  if (code === 'trust') return 'Trust name';
  if (code === 'other') return 'Name';
  return 'Company name';
}

/** CIPC registration-number suffixes that name an entity type. */
const CIPC_SUFFIX: Record<string, EntityTypeCode> = { '06': 'ltd', '07': 'pty_ltd', '08': 'npc', '23': 'cc' };

/**
 * The entity a registration number implies, or null when it cannot tell.
 * Used to ASK the user when an extracted certificate disagrees with their choice.
 */
export function entityFromRegistrationNumber(reg: string): EntityTypeCode | null {
  const m = /^(CK)?\s*\d{4}\s*\/\s*\d{4,6}\s*\/\s*(\d{2})$/i.exec(reg.trim());
  if (!m) return null;
  if (m[1]) return 'cc';
  return CIPC_SUFFIX[m[2]!] ?? null;
}

/** Where Smart Setup can read details from for this entity. */
export type SmartSetupSource =
  | { kind: 'company_document'; documentType: string } // POST /api/onboarding/extract
  | { kind: 'owner_id' }                               // POST /api/onboarding/extract-id
  | { kind: 'none' };

export function smartSetupSourceFor(code: EntityTypeCode): SmartSetupSource {
  if (code === 'sole_proprietor') return { kind: 'owner_id' };
  // The extractor reads CIPC-issued documents; a CK1/CK2 is one, a trust's
  // Letters of Authority (Master of the High Court) is not.
  const proof = getEntityType(code).requiredProof;
  if (proof.kind === 'document' && (proof.documentType === 'cipc_certificate' || proof.documentType === 'ck_certificate')) {
    return { kind: 'company_document', documentType: proof.documentType };
  }
  return { kind: 'none' };
}
