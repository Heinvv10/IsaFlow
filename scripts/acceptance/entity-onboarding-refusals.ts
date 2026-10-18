// Requests for POST /api/onboarding/complete-setup that the server must REFUSE (the catalogue), and ones it ACCEPTS
// but must store differently from what was sent (the probes). Messages are copied from entityOnboardingRules.ts
// (setupIssues and its parts) and onboardingSetupPayload.ts (file checks). Data only: no database access here.
import { pdfDataUrl, pngDataUrl, saId, textDataUrl, tinyPdfDataUrl, tinyPngDataUrl } from './entity-onboarding-support';

export type Body = {
  requestKey: string; entityType: string; coaTemplate: string;
  company: Record<string, unknown>; people: Array<Record<string, unknown>>; documents: Array<Record<string, unknown>>;
};
export interface RefusalCase { label: string; body: Body; expect: string }
export interface ProbeCase { label: string; body: Body; expectReg: string | null }

const REG: Record<string, string> = { pty_ltd: '2020/123456/07', ltd: '2015/987654/06', npc: '2018/456789/08', cc: 'CK1998/012345/23', trust: 'IT1234/2020' };
const PROOF: Record<string, string> = { pty_ltd: 'cipc_certificate', ltd: 'cipc_certificate', npc: 'cipc_certificate', cc: 'ck_certificate', trust: 'letters_of_authority' };
let seq = 0;
const next = () => ++seq;

const person = (name: string, over: Record<string, unknown> = {}) => {
  const k = next();
  return { name, idNumber: saId('800101', 7000 + k), idDocument: { name: `id-${k}.png`, data: pngDataUrl(`id-${k}`) }, ...over };
};
const doc = (type: string, name = `${type}.pdf`) => ({ type, name, data: pdfDataUrl(`${type}-${next()}`), mimeType: 'application/pdf', size: 2400 });

/** A request the server accepts for this entity: every rule satisfied, so each case below breaks exactly one thing. */
export function valid(entity: string, name = `Synth Refusal ${entity}`): Body {
  const people = entity === 'sole_proprietor' ? [person('Synth Owner')]
    : entity === 'partnership' ? [person('Synth Partner One'), person('Synth Partner Two')]
    : entity === 'other' ? [person('Synth Representative', { idDocument: null })] : [];
  return {
    requestKey: crypto.randomUUID(), entityType: entity, coaTemplate: 'isaflow_standard',
    company: { name, ...(REG[entity] ? { registrationNumber: REG[entity] } : {}) },
    people, documents: PROOF[entity] ? [doc(PROOF[entity]!)] : [],
  };
}
const withReg = (entity: string, reg: string): Body => { const b = valid(entity); b.company.registrationNumber = reg; return b; };
const withDoc = (entity: string, type: string): Body => { const b = valid(entity); b.documents.push(doc(type)); return b; };
const label = (type: string) => ({ cipc_certificate: 'CIPC Registration Certificate', ck_certificate: 'CK1 / CK2 Founding Statement' }[type] ?? type);
const belongs = (other: string, not: string) => `That registration number belongs to a ${other}, not a ${not}`;

export function refusalCatalogue(): RefusalCase[] {
  const dupNumber = valid('partnership'); dupNumber.people[1]!.idNumber = dupNumber.people[0]!.idNumber;
  const dupDoc = valid('partnership'); dupDoc.people[1]!.idDocument = dupDoc.people[0]!.idDocument;
  const dupName = valid('partnership');
  Object.assign(dupName.people[0]!, { name: 'Pat Jones', idNumber: '' });
  Object.assign(dupName.people[1]!, { name: 'pat  jones', idNumber: '' });
  const twoOwners = valid('sole_proprietor'); twoOwners.people.push(person('Synth Second Owner'));
  const tiny = valid('pty_ltd'); tiny.documents = [{ ...doc('cipc_certificate', 'tiny.pdf'), data: tinyPdfDataUrl() }];
  const tinyId = valid('sole_proprietor'); tinyId.people[0]!.idDocument = { name: 'tiny-id.png', data: tinyPngDataUrl() };
  const fakePdf = valid('pty_ltd'); fakePdf.documents = [{ ...doc('cipc_certificate', 'fake.pdf'), data: textDataUrl('application/pdf') }];
  const textMime = valid('pty_ltd'); textMime.documents = [{ ...doc('cipc_certificate', 'notes.txt'), data: textDataUrl('text/plain'), mimeType: 'text/plain' }];
  const fakeId = valid('sole_proprietor'); fakeId.people[0]!.idDocument = { name: 'fake-id.png', data: textDataUrl('image/png') };
  return [
    { label: 'duplicate people: same ID number', body: dupNumber, expect: 'Two people have the same ID number' },
    { label: 'duplicate people: same ID document bytes', body: dupDoc, expect: 'Two people have the same ID document' },
    { label: 'duplicate people: same name, neither has an ID number', body: dupName, expect: 'Pat Jones is listed more than once' },
    { label: 'too many people: sole proprietor with 2 owners', body: twoOwners, expect: 'A sole proprietor has 1 owner' },
    ...(['pty_ltd:CK1998/012345/07:Private company (Pty) Ltd', 'ltd:CK1998/012345/06:Public company (Ltd)', 'npc:CK1998/012345/08:Non-profit company (NPC)']
      .map(s => s.split(':') as [string, string, string])
      .map(([e, reg, name]): RefusalCase => ({ label: `registration: CK-prefixed ${reg} on ${e}`, body: withReg(e, reg), expect: belongs('Close corporation (CC)', name) }))),
    { label: 'registration: a /07 number on cc', body: withReg('cc', '2020/123456/07'), expect: belongs('Private company (Pty) Ltd', 'Close corporation (CC)') },
    { label: 'registration: a CIPC-format number on trust', body: withReg('trust', '2020/123456/07'), expect: belongs('Private company (Pty) Ltd', 'Trust') },
    { label: 'registration: a /06 number on pty_ltd', body: withReg('pty_ltd', '2015/987654/06'), expect: belongs('Public company (Ltd)', 'Private company (Pty) Ltd') },
    { label: 'registration: a /07 number on ltd', body: withReg('ltd', '2020/123456/07'), expect: belongs('Private company (Pty) Ltd', 'Public company (Ltd)') },
    { label: 'registration: a /07 number on npc', body: withReg('npc', '2020/123456/07'), expect: belongs('Private company (Pty) Ltd', 'Non-profit company (NPC)') },
    { label: 'document type: ck_certificate on pty_ltd', body: withDoc('pty_ltd', 'ck_certificate'), expect: `${label('ck_certificate')} is not a document for a Private company (Pty) Ltd` },
    { label: 'document type: cipc_certificate on trust', body: withDoc('trust', 'cipc_certificate'), expect: `${label('cipc_certificate')} is not a document for a Trust` },
    { label: 'document type: cipc_certificate on cc', body: withDoc('cc', 'cipc_certificate'), expect: `${label('cipc_certificate')} is not a document for a Close corporation (CC)` },
    { label: 'document type: cipc_certificate on sole_proprietor', body: withDoc('sole_proprietor', 'cipc_certificate'), expect: `${label('cipc_certificate')} is not a document for a Sole proprietor` },
    { label: 'document type: cipc_certificate on partnership', body: withDoc('partnership', 'cipc_certificate'), expect: `${label('cipc_certificate')} is not a document for a Partnership` },
    { label: 'document type: cipc_certificate on other', body: withDoc('other', 'cipc_certificate'), expect: `${label('cipc_certificate')} is not a document for a Other` },
    { label: 'document type: an unknown type on other', body: withDoc('other', 'passport'), expect: 'passport is not a document for a Other' },
    { label: 'file: a PDF under 1 KB', body: tiny, expect: 'Document "tiny.pdf" is too small to be a real document (under 1 KB)' },
    { label: 'file: an ID image under 1 KB', body: tinyId, expect: 'ID document of Synth Owner is too small to be a real document (under 1 KB)' },
    { label: 'file: text bytes named .pdf (application/pdf)', body: fakePdf, expect: 'Document "fake.pdf": contents do not match application/pdf' },
    { label: 'file: text/plain document', body: textMime, expect: 'Document "notes.txt": file type text/plain not allowed' },
    { label: 'file: text bytes as an ID image (image/png)', body: fakeId, expect: 'ID document of Synth Owner: contents do not match image/png' },
  ];
}

/**
 * Accepted by the rules module (registrationNumberFor returns null for entities without a registration field; a number
 * whose format the suffix check cannot read is not judged), so the server stores NULL / the text as sent.
 */
export function probeCatalogue(): ProbeCase[] {
  return [
    { label: 'sole_proprietor sent a registration number', body: withReg('sole_proprietor', '2020/123456/07'), expectReg: null },
    { label: 'partnership sent a registration number', body: withReg('partnership', 'IT1234/2020'), expectReg: null },
    { label: 'other sent a registration number', body: withReg('other', '2020/123456/07'), expectReg: null },
    { label: 'trust sent a wrong-format number', body: withReg('trust', 'not a real number'), expectReg: 'not a real number' },
  ];
}
