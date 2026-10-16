/**
 * The one list of South African legal entity types (`companies.entity_type`).
 *
 * Every screen, API and report that names an entity type reads it from here:
 * onboarding (fields, people, required proof), Company Settings, and the AFS
 * template choice. Migration 894 holds the database to the same eight codes
 * with a CHECK constraint; change both together.
 *
 * Pure data + helpers: safe on the client and the server.
 */

export const ENTITY_TYPE_CODES = [
  'sole_proprietor', 'partnership', 'pty_ltd', 'ltd', 'cc', 'npc', 'trust', 'other',
] as const;

export type EntityTypeCode = typeof ENTITY_TYPE_CODES[number];

/** The value a company gets when nobody chose one (the column default too). */
export const DEFAULT_ENTITY_TYPE: EntityTypeCode = 'pty_ltd';

/**
 * What a company must upload before onboarding can finish.
 *  - `document`: one company document of `documentType`;
 *  - `person_ids`: at least `minPeople` people, each with their ID document;
 *  - `none`: nothing required.
 */
export type RequiredProof =
  | { kind: 'document'; documentType: string; label: string }
  | { kind: 'person_ids'; minPeople: number; label: string }
  | { kind: 'none' };

/** The registration number this entity carries, if any (stored in `registration_number`). */
export interface RegistrationField {
  label: string;
  placeholder: string;
}

/** AFS template keys (`afsHtmlRendererService`, `reportTemplates`, `entityTerminology`). */
export type AfsTemplateKey = 'pty' | 'cc' | 'trust';
export const AFS_TEMPLATE_KEYS: readonly AfsTemplateKey[] = ['pty', 'cc', 'trust'];

export interface EntityTypeDef {
  code: EntityTypeCode;
  label: string;
  /** null = this entity has no registration number (sole proprietor, partnership, other). */
  registration: RegistrationField | null;
  /** Heading for the people step, e.g. "Directors". */
  peopleLabel: string;
  /** Stored in `company_directors.role` for each person captured. */
  personRole: string;
  /** Upper bound on people (a sole proprietor has exactly one owner). */
  maxPeople: number | null;
  requiredProof: RequiredProof;
  /**
   * The AFS template. null = IsaFlow has no statutory AFS template for this
   * entity: a sole proprietor or partnership is not a Companies Act entity
   * and the pty/cc/trust templates would print directors and dividends for
   * it. AFS callers keep their existing `pty` fallback for these.
   */
  afsTemplate: AfsTemplateKey | null;
}

const CIPC_PROOF: RequiredProof = {
  kind: 'document', documentType: 'cipc_certificate', label: 'CIPC registration certificate (COR14.3)',
};
const CIPC_REG: RegistrationField = { label: 'CIPC registration number', placeholder: '2020/123456/07' };

export const ENTITY_TYPES: readonly EntityTypeDef[] = [
  {
    code: 'sole_proprietor', label: 'Sole proprietor', registration: null,
    peopleLabel: 'Owner', personRole: 'Owner', maxPeople: 1,
    requiredProof: { kind: 'person_ids', minPeople: 1, label: "Owner's ID document" },
    afsTemplate: null,
  },
  {
    code: 'partnership', label: 'Partnership', registration: null,
    peopleLabel: 'Partners', personRole: 'Partner', maxPeople: null,
    requiredProof: { kind: 'person_ids', minPeople: 2, label: 'ID document of every partner' },
    afsTemplate: null,
  },
  {
    code: 'pty_ltd', label: 'Private company (Pty) Ltd', registration: CIPC_REG,
    peopleLabel: 'Directors', personRole: 'Director', maxPeople: null,
    requiredProof: CIPC_PROOF, afsTemplate: 'pty',
  },
  {
    code: 'ltd', label: 'Public company (Ltd)', registration: CIPC_REG,
    peopleLabel: 'Directors', personRole: 'Director', maxPeople: null,
    requiredProof: CIPC_PROOF, afsTemplate: 'pty',
  },
  {
    code: 'cc', label: 'Close corporation (CC)',
    registration: { label: 'CK number', placeholder: 'CK1998/012345/23' },
    peopleLabel: 'Members', personRole: 'Member', maxPeople: null,
    requiredProof: { kind: 'document', documentType: 'ck_certificate', label: 'CK1 or CK2' },
    afsTemplate: 'cc',
  },
  {
    code: 'npc', label: 'Non-profit company (NPC)', registration: CIPC_REG,
    peopleLabel: 'Directors', personRole: 'Director', maxPeople: null,
    requiredProof: CIPC_PROOF, afsTemplate: 'pty',
  },
  {
    code: 'trust', label: 'Trust',
    registration: { label: "Master's reference (IT number)", placeholder: 'IT1234/2020' },
    peopleLabel: 'Trustees', personRole: 'Trustee', maxPeople: null,
    requiredProof: { kind: 'document', documentType: 'letters_of_authority', label: "Master's Letters of Authority" },
    afsTemplate: 'trust',
  },
  {
    code: 'other', label: 'Other', registration: null,
    peopleLabel: 'Key people', personRole: 'Representative', maxPeople: null,
    requiredProof: { kind: 'none' }, afsTemplate: null,
  },
];

const BY_CODE = new Map<string, EntityTypeDef>(ENTITY_TYPES.map(t => [t.code, t]));

export function isEntityTypeCode(value: unknown): value is EntityTypeCode {
  return typeof value === 'string' && BY_CODE.has(value);
}

/** The definition for a code; throws on an unknown code (validate input first). */
export function getEntityType(code: EntityTypeCode): EntityTypeDef {
  const def = BY_CODE.get(code);
  if (!def) throw new Error(`Unknown entity type: ${code}`);
  return def;
}

/** Label for any stored value; an unknown value is shown as-is. */
export function entityTypeLabel(value: string | null | undefined): string {
  if (!value) return '';
  return BY_CODE.get(value)?.label ?? value;
}

/** The AFS template for a stored entity type, falling back to `pty` as AFS always has. */
export function afsTemplateFor(value: string | null | undefined): AfsTemplateKey {
  return (value ? BY_CODE.get(value)?.afsTemplate : null) ?? 'pty';
}

/** Document types a required proof can name, with their labels. */
export const PROOF_DOCUMENT_LABELS: Record<string, string> = {
  cipc_certificate: 'CIPC Registration Certificate',
  ck_certificate: 'CK1 / CK2 Founding Statement',
  letters_of_authority: "Master's Letters of Authority",
};
