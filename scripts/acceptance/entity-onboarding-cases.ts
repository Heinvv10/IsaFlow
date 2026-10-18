// The eight onboarding scenarios, one per entity type (src/lib/entityTypes.ts). Labels, roles and required proof
// are copied from entityTypes.ts / entityOnboardingRules.ts; the run asserts the product shows exactly these.
export type Person = { name: string; withId: boolean };

/**
 * An incomplete state the wizard must block on the documents step, before the run completes the people.
 * `add` is typed in at this stage (on top of the earlier stages); `blockedText` is the exact reason shown next to Continue.
 */
export interface Stage { add: Person[]; blockedText: string }

export interface Case {
  n: number; slug: string; entityDb: string; typeLabel: string; label: RegExp; name: string;
  reg?: string;                 // registration number typed on the details step (and stored); none = stored NULL
  regPlaceholder?: string;      // the field's placeholder (entityTypes.ts registration.placeholder), used to find it
  regLabel?: string;            // the field's label (entityTypes.ts registration.label); none = the entity has no registration field
  people: Person[];             // people on the details step once the run is complete
  peopleLabel: string; role: string;
  needsHint: RegExp;            // line under the entity card
  smartSetup: boolean;          // smartSetupSourceFor(entity).kind !== 'none': the Smart Setup pre-step is shown
  proof: 'person_ids' | 'document' | 'none';
  requiredLine?: string;        // person_ids: the "Required: ..." line on the details step
  doc?: { label: string; file: string; type: string };
  blockedText?: string;         // document proof: exact text shown next to the dimmed Continue on the documents step
  stages?: Stage[];             // person_ids: the incomplete states to block first; the run then completes the last person's ID
}

const CIPC = { label: 'CIPC Registration Certificate', file: 'cipc.pdf', type: 'cipc_certificate' };
const CIPC_BLOCK = 'Upload the CIPC registration certificate (COR14.3) to continue.';

export const CASES: Case[] = [
  { n: 1, slug: 'sole-prop', entityDb: 'sole_proprietor', typeLabel: 'Sole proprietor', label: /Sole proprietor/, name: 'Synth Plumbing',
    people: [{ name: 'Synth Owner', withId: true }], peopleLabel: 'Owner', role: 'Owner', needsHint: /Owner · needs: Owner's ID document/,
    smartSetup: true, proof: 'person_ids', requiredLine: "Required: Owner's ID document.",
    stages: [
      { add: [], blockedText: "Add the owner and upload the owner's ID document to continue." },
      { add: [{ name: 'Synth Owner', withId: false }], blockedText: 'Upload the ID document of Synth Owner to continue.' },
    ] },
  { n: 2, slug: 'partnership', entityDb: 'partnership', typeLabel: 'Partnership', label: /Partnership/, name: 'Synth Partners',
    people: [{ name: 'Synth Partner One', withId: true }, { name: 'Synth Partner Two', withId: true }], peopleLabel: 'Partners', role: 'Partner',
    needsHint: /Partners · needs: ID document of every partner/, smartSetup: false, proof: 'person_ids', requiredLine: 'Required: ID document of every partner.',
    stages: [
      { add: [{ name: 'Synth Partner One', withId: true }], blockedText: 'Add at least 2 partners, each with their ID document to continue.' },
      { add: [{ name: 'Synth Partner Two', withId: false }], blockedText: 'Upload the ID document of Synth Partner Two to continue.' },
    ] },
  { n: 3, slug: 'pty-ltd', entityDb: 'pty_ltd', typeLabel: 'Private company (Pty) Ltd', label: /Private company/, name: 'Synth Holdings (Pty) Ltd',
    reg: '2020/123456/07', regLabel: 'CIPC registration number', regPlaceholder: '2020/123456/07', people: [], peopleLabel: 'Directors', role: 'Director',
    needsHint: /Directors · needs: CIPC registration certificate/, smartSetup: true, proof: 'document', doc: CIPC, blockedText: CIPC_BLOCK },
  { n: 4, slug: 'ltd', entityDb: 'ltd', typeLabel: 'Public company (Ltd)', label: /Public company/, name: 'Synth Listed Ltd',
    reg: '2015/987654/06', regLabel: 'CIPC registration number', regPlaceholder: '2020/123456/07', people: [{ name: 'Synth Director', withId: false }], peopleLabel: 'Directors', role: 'Director',
    needsHint: /Directors · needs: CIPC registration certificate/, smartSetup: true, proof: 'document', doc: CIPC, blockedText: CIPC_BLOCK },
  { n: 5, slug: 'cc', entityDb: 'cc', typeLabel: 'Close corporation (CC)', label: /Close corporation/, name: 'Synth Builders CC',
    reg: 'CK1998/012345/23', regLabel: 'CK number', regPlaceholder: 'CK1998/012345/23', people: [], peopleLabel: 'Members', role: 'Member', needsHint: /Members · needs: CK1 or CK2/,
    smartSetup: true, proof: 'document', doc: { label: 'CK1 / CK2 Founding Statement', file: 'ck1.pdf', type: 'ck_certificate' },
    blockedText: 'Upload the CK1 or CK2 to continue.' },
  { n: 6, slug: 'npc', entityDb: 'npc', typeLabel: 'Non-profit company (NPC)', label: /Non-profit company/, name: 'Synth Foundation NPC',
    reg: '2018/456789/08', regLabel: 'CIPC registration number', regPlaceholder: '2020/123456/07', people: [{ name: 'Synth Director One', withId: false }, { name: 'Synth Director Two', withId: false }],
    peopleLabel: 'Directors', role: 'Director', needsHint: /Directors · needs: CIPC registration certificate/,
    smartSetup: true, proof: 'document', doc: CIPC, blockedText: CIPC_BLOCK },
  { n: 7, slug: 'trust', entityDb: 'trust', typeLabel: 'Trust', label: /^Trust/, name: 'Synth Family Trust',
    reg: 'IT1234/2020', regLabel: "Master's reference (IT number)", regPlaceholder: 'IT1234/2020', people: [], peopleLabel: 'Trustees', role: 'Trustee', needsHint: /Trustees · needs: Master's Letters of Authority/,
    smartSetup: false, proof: 'document', doc: { label: "Master's Letters of Authority", file: 'loa.pdf', type: 'letters_of_authority' },
    blockedText: "Upload the Master's Letters of Authority to continue." },
  { n: 8, slug: 'other', entityDb: 'other', typeLabel: 'Other', label: /^Other/, name: 'Synth Other Entity',
    people: [{ name: 'Synth Representative', withId: false }], peopleLabel: 'Key people', role: 'Representative',
    needsHint: /Key people · no document required/, smartSetup: false, proof: 'none' },
];
