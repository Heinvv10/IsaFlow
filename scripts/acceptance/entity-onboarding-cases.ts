// The eight onboarding scenarios, one per entity type (src/lib/entityTypes.ts). Labels, roles and required proof
// are copied from entityTypes.ts / entityOnboardingRules.ts; the run asserts the product shows exactly these.
export type Person = { name: string; withId: boolean };
export type Refusal = { label: string; body: Record<string, unknown>; expect: string };

export interface Case {
  n: number; slug: string; entityDb: string; typeLabel: string; label: RegExp; name: string;
  reg?: string;                 // registration number typed on the details step
  regPlaceholder?: string;      // the field's placeholder (entityTypes.ts registration.placeholder), used to find it
  people: Person[];             // people on the details step once the run is complete
  peopleLabel: string; role: string;
  needsHint: RegExp;            // line under the entity card
  proof: 'person_ids' | 'document' | 'none';
  doc?: { label: string; file: string; type: string };
  blockedText?: string;         // exact text shown next to the dimmed Continue on the documents step
  // person_ids entities: the first (incomplete) pass the wizard must block, then what is added to fix it
  firstPass?: Person[];
  refusals: Array<(base: Record<string, unknown>, proofDoc: unknown) => Refusal>; // extra server-side refusals on top of the UI-state one
}

const CIPC = { label: 'CIPC Registration Certificate', file: 'cipc.pdf', type: 'cipc_certificate' };
const CIPC_BLOCK = 'Upload the CIPC registration certificate (COR14.3) to continue.';
// The proof document is attached, so the registration number is the only reason for the refusal.
const withReg = (reg: string) => (base: Record<string, unknown>, proofDoc: unknown): Refusal => ({
  label: `registration ${reg} belongs to another entity type`,
  body: { ...base, company: { ...(base.company as object), registrationNumber: reg }, documents: [proofDoc] },
  expect: 'That registration number belongs to a',
});

export const CASES: Case[] = [
  { n: 1, slug: 'sole-prop', entityDb: 'sole_proprietor', typeLabel: 'Sole proprietor', label: /Sole proprietor/, name: 'Synth Plumbing',
    people: [{ name: 'Synth Owner', withId: true }], peopleLabel: 'Owner', role: 'Owner', needsHint: /Owner · needs: Owner's ID document/,
    proof: 'person_ids', firstPass: [{ name: 'Synth Owner', withId: false }], blockedText: 'Upload the ID document of Synth Owner to continue.',
    refusals: [base => ({ label: 'no owner at all', body: { ...base, people: [] }, expect: "Add the owner and upload the owner's ID document" })] },
  { n: 2, slug: 'partnership', entityDb: 'partnership', typeLabel: 'Partnership', label: /Partnership/, name: 'Synth Partners',
    people: [{ name: 'Synth Partner One', withId: true }, { name: 'Synth Partner Two', withId: true }], peopleLabel: 'Partners', role: 'Partner',
    needsHint: /Partners · needs: ID document of every partner/, proof: 'person_ids',
    firstPass: [{ name: 'Synth Partner One', withId: true }, { name: 'Synth Partner Two', withId: false }],
    blockedText: 'Upload the ID document of Synth Partner Two to continue.',
    refusals: [base => ({ label: 'only one partner', body: { ...base, people: (base.people as unknown[]).slice(0, 1) }, expect: 'Add at least 2 partners, each with their ID document' })] },
  { n: 3, slug: 'pty-ltd', entityDb: 'pty_ltd', typeLabel: 'Private company (Pty) Ltd', label: /Private company/, name: 'Synth Holdings (Pty) Ltd',
    reg: '2020/123456/07', regPlaceholder: '2020/123456/07', people: [], peopleLabel: 'Directors', role: 'Director', needsHint: /Directors · needs: CIPC registration certificate/,
    proof: 'document', doc: CIPC, blockedText: CIPC_BLOCK, refusals: [withReg('2015/987654/06')] },
  { n: 4, slug: 'ltd', entityDb: 'ltd', typeLabel: 'Public company (Ltd)', label: /Public company/, name: 'Synth Listed Ltd',
    reg: '2015/987654/06', regPlaceholder: '2020/123456/07', people: [{ name: 'Synth Director', withId: false }], peopleLabel: 'Directors', role: 'Director',
    needsHint: /Directors · needs: CIPC registration certificate/, proof: 'document', doc: CIPC, blockedText: CIPC_BLOCK,
    refusals: [withReg('2020/123456/07')] },
  { n: 5, slug: 'cc', entityDb: 'cc', typeLabel: 'Close corporation (CC)', label: /Close corporation/, name: 'Synth Builders CC',
    reg: 'CK1998/012345/23', regPlaceholder: 'CK1998/012345/23', people: [], peopleLabel: 'Members', role: 'Member', needsHint: /Members · needs: CK1 or CK2/,
    proof: 'document', doc: { label: 'CK1 / CK2 Founding Statement', file: 'ck1.pdf', type: 'ck_certificate' },
    blockedText: 'Upload the CK1 or CK2 to continue.', refusals: [] },
  { n: 6, slug: 'npc', entityDb: 'npc', typeLabel: 'Non-profit company (NPC)', label: /Non-profit company/, name: 'Synth Foundation NPC',
    reg: '2018/456789/08', regPlaceholder: '2020/123456/07', people: [{ name: 'Synth Director One', withId: false }, { name: 'Synth Director Two', withId: false }],
    peopleLabel: 'Directors', role: 'Director', needsHint: /Directors · needs: CIPC registration certificate/,
    proof: 'document', doc: CIPC, blockedText: CIPC_BLOCK, refusals: [withReg('2020/123456/07')] },
  { n: 7, slug: 'trust', entityDb: 'trust', typeLabel: 'Trust', label: /^Trust/, name: 'Synth Family Trust',
    reg: 'IT1234/2020', regPlaceholder: 'IT1234/2020', people: [], peopleLabel: 'Trustees', role: 'Trustee', needsHint: /Trustees · needs: Master's Letters of Authority/,
    proof: 'document', doc: { label: "Master's Letters of Authority", file: 'loa.pdf', type: 'letters_of_authority' },
    blockedText: "Upload the Master's Letters of Authority to continue.", refusals: [] },
  { n: 8, slug: 'other', entityDb: 'other', typeLabel: 'Other', label: /^Other/, name: 'Synth Other Entity',
    people: [{ name: 'Synth Representative', withId: false }], peopleLabel: 'Key people', role: 'Representative',
    needsHint: /Key people · no document required/, proof: 'none',
    refusals: [base => ({ label: 'blank name (the only thing "other" requires)', body: { ...base, company: { ...(base.company as object), name: '' } }, expect: 'Enter the name' })] },
];
