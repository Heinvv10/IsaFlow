/**
 * The per-entity onboarding rules: one required proof per entity type, everything else
 * optional. The wizard (Continue gating) and POST /api/onboarding/complete-setup (the
 * server's refusal) both call these functions, so a rule changed here changes both.
 */
import { describe, expect, it } from 'vitest';
import { ENTITY_TYPE_CODES, type EntityTypeCode } from '@/lib/entityTypes';
import {
  allowedDocumentTypes, businessNameLabel, documentSlotsFor, entityFromRegistrationNumber,
  hasRequiredProofDocument, proofIssues, registrationNumberFor, setupIssues, smartSetupSourceFor,
  type SetupFacts,
} from '@/modules/onboarding/services/entityOnboardingRules';

const withId = (name: string) => ({ name, hasIdDocument: true });
const noId = (name: string) => ({ name, hasIdDocument: false });
const facts = (entityType: EntityTypeCode, over: Partial<SetupFacts> = {}): SetupFacts => ({
  entityType, name: 'Synthetic Trading', people: [], documentTypes: [], ...over,
});

describe('documentSlotsFor', () => {
  it('a (Pty) Ltd must upload the CIPC certificate; tax clearance, B-BBEE and VAT are optional', () => {
    expect(documentSlotsFor('pty_ltd')).toEqual([
      { type: 'cipc_certificate', label: 'CIPC Registration Certificate', required: true },
      { type: 'tax_clearance', label: 'SARS Tax Clearance Certificate', required: false },
      { type: 'bbbee_certificate', label: 'B-BBEE Certificate', required: false },
      { type: 'vat_registration', label: 'VAT Registration Certificate', required: false },
    ]);
  });
  it('a CC needs its CK1/CK2, a trust its Letters of Authority', () => {
    expect(documentSlotsFor('cc').filter(s => s.required).map(s => s.type)).toEqual(['ck_certificate']);
    expect(documentSlotsFor('trust').filter(s => s.required).map(s => s.type)).toEqual(['letters_of_authority']);
  });
  it('a sole proprietor, a partnership and "other" have no required company document and are never offered CIPC', () => {
    for (const code of ['sole_proprietor', 'partnership', 'other'] as const) {
      expect(documentSlotsFor(code).some(s => s.required)).toBe(false);
      expect(allowedDocumentTypes(code)).not.toContain('cipc_certificate');
    }
  });
});

describe('proofIssues', () => {
  it('pty_ltd, ltd and npc are refused without a cipc_certificate and accepted with one', () => {
    for (const code of ['pty_ltd', 'ltd', 'npc'] as const) {
      expect(proofIssues(facts(code))).toEqual(['Upload the CIPC registration certificate (COR14.3)']);
      expect(proofIssues(facts(code, { documentTypes: ['cipc_certificate'] }))).toEqual([]);
    }
  });
  it('a CIPC certificate does not satisfy a CC or a trust', () => {
    expect(proofIssues(facts('cc', { documentTypes: ['cipc_certificate'] }))).toEqual(['Upload the CK1 or CK2']);
    expect(proofIssues(facts('cc', { documentTypes: ['ck_certificate'] }))).toEqual([]);
    expect(proofIssues(facts('trust', { documentTypes: ['tax_clearance'] })))
      .toEqual(["Upload the Master's Letters of Authority"]);
    expect(proofIssues(facts('trust', { documentTypes: ['letters_of_authority'] }))).toEqual([]);
  });
  it('a sole proprietor needs the owner with an ID document, and no CIPC', () => {
    expect(proofIssues(facts('sole_proprietor'))).toEqual(["Add the owner and upload the owner's ID document"]);
    expect(proofIssues(facts('sole_proprietor', { people: [noId('Owner A')] })))
      .toEqual(["Upload the ID document of Owner A"]);
    expect(proofIssues(facts('sole_proprietor', { people: [withId('Owner A')] }))).toEqual([]);
  });
  it('a partnership needs at least two partners, each with an ID document', () => {
    expect(proofIssues(facts('partnership', { people: [withId('Partner A')] })))
      .toEqual(['Add at least 2 partners, each with their ID document']);
    expect(proofIssues(facts('partnership', { people: [withId('Partner A'), noId('Partner B')] })))
      .toEqual(['Upload the ID document of Partner B']);
    expect(proofIssues(facts('partnership', { people: [withId('Partner A'), withId('Partner B')] }))).toEqual([]);
  });
  it('people with a blank name do not count towards the proof', () => {
    expect(proofIssues(facts('partnership', { people: [withId('Partner A'), withId('  ')] })))
      .toEqual(['Add at least 2 partners, each with their ID document']);
  });
  it('"other" needs nothing', () => {
    expect(proofIssues(facts('other'))).toEqual([]);
  });
});

describe('setupIssues (the whole server-side rule)', () => {
  it('every entity is accepted with exactly its required proof', () => {
    const proof: Record<EntityTypeCode, Partial<SetupFacts>> = {
      sole_proprietor: { people: [withId('Owner A')] },
      partnership: { people: [withId('Partner A'), withId('Partner B')] },
      pty_ltd: { documentTypes: ['cipc_certificate'] }, ltd: { documentTypes: ['cipc_certificate'] },
      npc: { documentTypes: ['cipc_certificate'] }, cc: { documentTypes: ['ck_certificate'] },
      trust: { documentTypes: ['letters_of_authority'] }, other: {},
    };
    for (const code of ENTITY_TYPE_CODES) expect(setupIssues(facts(code, proof[code])), code).toEqual([]);
  });
  it('a name is required', () => {
    expect(setupIssues(facts('pty_ltd', { name: '  ', documentTypes: ['cipc_certificate'] }))).toEqual(['Enter the company name']);
    expect(setupIssues(facts('sole_proprietor', { name: '', people: [withId('Owner A')] })))
      .toEqual(['Enter the business name']);
  });
  it('a sole proprietor has exactly one owner', () => {
    expect(setupIssues(facts('sole_proprietor', { people: [withId('Owner A'), withId('Owner B')] })))
      .toEqual(['A sole proprietor has 1 owner']);
  });
  it('a document the entity does not use is refused (a CIPC certificate for a sole proprietor)', () => {
    expect(setupIssues(facts('sole_proprietor', { people: [withId('Owner A')], documentTypes: ['cipc_certificate'] })))
      .toEqual(['CIPC Registration Certificate is not a document for a Sole proprietor']);
  });
  it('an unknown entity type is refused before any other rule', () => {
    expect(setupIssues({ ...facts('other'), entityType: 'company' as EntityTypeCode })).toEqual(['Choose the type of business']);
  });
});

describe('setupIssues: duplicate people', () => {
  it('the same person twice is refused: same name (any case/spacing), same ID number, or the same ID document', () => {
    expect(setupIssues(facts('partnership', { people: [withId('Partner A'), withId(' partner  a ')] })))
      .toEqual(['Partner A is listed more than once']);
    expect(setupIssues(facts('partnership', { people: [
      { name: 'Partner A', hasIdDocument: true, idNumber: 'SYNTH-1' }, { name: 'Partner B', hasIdDocument: true, idNumber: ' SYNTH-1 ' },
    ] }))).toEqual(['Two people have the same ID number']);
    expect(setupIssues(facts('partnership', { people: [
      { name: 'Partner A', hasIdDocument: true, idDocumentData: 'data:x' }, { name: 'Partner B', hasIdDocument: true, idDocumentData: 'data:x' },
    ] }))).toEqual(['Two people have the same ID document']);
  });
  it('blank ID numbers and missing documents are not duplicates', () => {
    expect(setupIssues(facts('partnership', { people: [
      { name: 'Partner A', hasIdDocument: true, idNumber: '', idDocumentData: 'data:a' },
      { name: 'Partner B', hasIdDocument: true, idNumber: '', idDocumentData: 'data:b' },
    ] }))).toEqual([]);
  });
});

describe('setupIssues: a registration number of another entity type', () => {
  it('a CK number on a (Pty) Ltd, or a /07 number on a CC, is refused', () => {
    expect(setupIssues(facts('pty_ltd', { documentTypes: ['cipc_certificate'], registrationNumber: 'CK1998/012345/23' })))
      .toEqual(['That registration number belongs to a Close corporation (CC), not a Private company (Pty) Ltd']);
    expect(setupIssues(facts('cc', { documentTypes: ['ck_certificate'], registrationNumber: '2020/123456/07' })))
      .toEqual(['That registration number belongs to a Private company (Pty) Ltd, not a Close corporation (CC)']);
  });
  it('a matching, unreadable or ignored number is fine', () => {
    expect(setupIssues(facts('pty_ltd', { documentTypes: ['cipc_certificate'], registrationNumber: '2020/123456/07' }))).toEqual([]);
    expect(setupIssues(facts('trust', { documentTypes: ['letters_of_authority'], registrationNumber: 'IT1234/2020' }))).toEqual([]);
    // A sole proprietor has no registration number; whatever is sent is dropped, not judged.
    expect(setupIssues(facts('sole_proprietor', { people: [withId('Owner A')], registrationNumber: 'CK1998/012345/23' }))).toEqual([]);
  });
});

describe('registrationNumberFor', () => {
  it('keeps the number for entities that carry one, trimmed', () => {
    expect(registrationNumberFor('pty_ltd', ' 2020/123456/07 ')).toBe('2020/123456/07');
    expect(registrationNumberFor('trust', 'IT1234/2020')).toBe('IT1234/2020');
  });
  it('drops it for a sole proprietor, a partnership and "other" (no registration number)', () => {
    for (const code of ['sole_proprietor', 'partnership', 'other'] as const) {
      expect(registrationNumberFor(code, '2020/123456/07')).toBeNull();
    }
  });
  it('an empty value is null', () => expect(registrationNumberFor('cc', '  ')).toBeNull());
});

describe('entityFromRegistrationNumber', () => {
  it('reads the CIPC suffix', () => {
    expect(entityFromRegistrationNumber('2020/123456/07')).toBe('pty_ltd');
    expect(entityFromRegistrationNumber('2020/123456/06')).toBe('ltd');
    expect(entityFromRegistrationNumber('2020/123456/08')).toBe('npc');
    expect(entityFromRegistrationNumber('1998/012345/23')).toBe('cc');
    expect(entityFromRegistrationNumber('CK1998/012345/23')).toBe('cc');
  });
  it('says nothing when it cannot tell', () => {
    expect(entityFromRegistrationNumber('')).toBeNull();
    expect(entityFromRegistrationNumber('2020/123456/10')).toBeNull();
    expect(entityFromRegistrationNumber('not a number')).toBeNull();
  });
});

describe('smartSetupSourceFor / hasRequiredProofDocument / businessNameLabel', () => {
  it('company types extract from their certificate, a sole proprietor from the owner ID, others have none', () => {
    expect(smartSetupSourceFor('pty_ltd')).toEqual({ kind: 'company_document', documentType: 'cipc_certificate' });
    expect(smartSetupSourceFor('cc')).toEqual({ kind: 'company_document', documentType: 'ck_certificate' });
    expect(smartSetupSourceFor('sole_proprietor')).toEqual({ kind: 'owner_id' });
    for (const code of ['partnership', 'trust', 'other'] as const) expect(smartSetupSourceFor(code)).toEqual({ kind: 'none' });
  });
  it('hasRequiredProofDocument is true only for a document proof that is present', () => {
    expect(hasRequiredProofDocument('pty_ltd', ['cipc_certificate'])).toBe(true);
    expect(hasRequiredProofDocument('pty_ltd', ['ck_certificate'])).toBe(false);
    expect(hasRequiredProofDocument('sole_proprietor', ['cipc_certificate'])).toBe(false);
    expect(hasRequiredProofDocument('other', [])).toBe(false);
  });
  it('the name field is named after the entity', () => {
    expect(businessNameLabel('sole_proprietor')).toBe('Business name');
    expect(businessNameLabel('partnership')).toBe('Partnership name');
    expect(businessNameLabel('trust')).toBe('Trust name');
    expect(businessNameLabel('pty_ltd')).toBe('Company name');
  });
});
