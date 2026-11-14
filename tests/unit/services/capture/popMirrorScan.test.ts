/**
 * POP inbox, phase 1: the IMAP mirror's handling of ABSA "Notice of payment" mail.
 *   - a DKIM-trusted notice is filed as a proof of payment: no capture event, no VLM read;
 *   - an ABSA-looking notice that fails verification goes to the normal capture ingest;
 *   - a PDF ABSA labels `*\/*` is still taken; a second copy of a filed notice files nothing;
 *   - mail that is neither an ABSA notice nor invoice-shaped is skipped as before.
 * Trust and the PDF text are stubbed here (absaPopTrust.test.ts and absaPopParser.test.ts
 * prove them); the scan, the branch and the ingest SQL are real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOTICE_TEXT = `Notice of Payment 13 November 2026
Absa Bank Limited
Dear EXAMPLE TRADING PTY LTD
Transaction number: 80AB12CD34-11
Payment date: 2026-11-13
Payment made from: EXAMPLE MAIN
Payment made to: JANE Q PUBLIC
Beneficiary bank name: CAPITEC
For the amount of: 3 000.00
Reference on beneficiary statement: Example Ref`;

const h = vi.hoisted(() => ({
  statements: [] as Array<{ text: string; values: unknown[] }>,
  trusted: true,
  pdfText: '',
  envelope: { from: 'ibreply@absa.co.za', subject: 'Notice of payment: JANE Q PUBLIC' },
  attachment: { contentType: 'application/pdf' as string, content: Buffer.from('%PDF-1.4 notice') },
  popHeld: false,
  payerTrusted: true,
  stored: 0,
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { uidNext: 0 };
    streamer = { write: () => true, push: () => true };
    on() { /* error listener */ }
    close() { /* guard close */ }
    async connect() { /* fake */ }
    async logout() { /* fake */ }
    async getMailboxLock() { return { release: () => undefined }; }
    async *fetch() { yield { uid: 11, size: 100, envelope: { from: [{ address: h.envelope.from }], subject: h.envelope.subject } }; }
    async fetchOne(uid: string) { return { uid: Number(uid), source: Buffer.from('raw message') }; }
  },
}));
vi.mock('mailparser', () => ({
  simpleParser: async () => ({
    subject: h.envelope.subject, from: { text: h.envelope.from },
    attachments: [{ ...h.attachment, size: h.attachment.content.length, filename: 'Absa.pdf' }],
  }),
}));
vi.mock('@/modules/accounting/services/capture/pop/pdfText', () => ({ pdfText: vi.fn(async () => h.pdfText) }));
vi.mock('@/modules/accounting/services/capture/pop/absaPopTrust', () => ({
  ABSA_NOTICE_SENDER: 'ibreply@absa.co.za',
  isTrustedAbsaNotice: vi.fn(async () => (h.trusted ? { trusted: true } : { trusted: false, reason: 'no_absa_signature' })),
}));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'password' }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));
vi.mock('@/lib/documentStorage', () => ({
  sha256: (b: Buffer) => `sha-${b.length}`,
  storeCapturedBytes: async () => { h.stored += 1; return { bucket: 'b', path: 'p' }; },
}));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({ routeEvent: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/capture/imapMirrorInbox', () => ({
  ensureMirrorInbox: vi.fn(async () => 'inbox-1'), isTransientIngestError: vi.fn(() => false),
}));
vi.mock('@/modules/accounting/services/capture/capturedDocumentHash', () => ({ isFileAlreadyCaptured: vi.fn(async () => false) }));
vi.mock('@/lib/neon', () => {
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    h.statements.push({ text, values });
    if (/SELECT 1 FROM proof_of_payments/.test(text)) return h.popHeld ? [{ '?column?': 1 }] : [];
    if (/SELECT 1 FROM pop_trusted_payers/.test(text)) return h.payerTrusted && values[1] === 'EXAMPLE TRADING PTY LTD' ? [{ '?column?': 1 }] : [];
    return /RETURNING id/.test(text) ? [{ id: crypto.randomUUID() }] : [];
  });
  return { sql, withTransaction: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) };
});
vi.mock('@/lib/auth/routeAdminPool', () => ({ routeAdminQuery: vi.fn(async () => []) }));

import { scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const conn = (): MirrorConnection => ({
  id: 'c1', companyId: COMPANY, provider: 'imap', accountEmail: 'pop@co.test', folder: 'INBOX', scanCursor: { INBOX: 10 },
  allowedSenders: [], deniedSenders: [], imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u',
  imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});
const inserts = (table: string) => h.statements.filter((s) => s.text.startsWith(`INSERT INTO ${table}`));
const scanLogOutcome = () => inserts('imap_mirror_scan_log')[0]?.values[6];

beforeEach(() => {
  h.statements.length = 0;
  h.trusted = true;
  h.pdfText = NOTICE_TEXT;
  h.envelope = { from: 'ibreply@absa.co.za', subject: 'Notice of payment: JANE Q PUBLIC' };
  h.attachment = { contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 notice') };
  h.popHeld = false;
  h.payerTrusted = true;
  h.stored = 0;
});

describe('IMAP mirror: ABSA notice of payment', () => {
  it('files a trusted notice as a proof of payment, with no capture event', async () => {
    const r = await scanConnection(conn());
    expect(r).toMatchObject({ ingested: 1, skipped: 0, errors: 0 });
    const [doc] = inserts('captured_documents');
    expect(doc!.text).toMatch(/'processed', 'proof_of_payment'/);
    const [pop] = inserts('proof_of_payments');
    expect(pop!.values).toEqual([COMPANY, expect.any(String), '80AB12CD34-11', '2026-11-13', '3000.00',
      'JANE Q PUBLIC', 'CAPITEC', 'Example Ref', 'EXAMPLE MAIN', 'EXAMPLE TRADING PTY LTD']);
    expect(pop!.values[1]).toBe(h.statements.find((s) => s.text.startsWith('UPDATE captured_documents'))!.values[2]);
    expect(h.stored).toBe(1);
    expect(inserts('capture_events')).toEqual([]);
    expect(scanLogOutcome()).toBe('pop_filed');
  });

  it('takes a notice PDF that ABSA labelled */*', async () => {
    h.attachment = { contentType: '*/*', content: Buffer.from('%PDF-1.4 notice') };
    expect(await scanConnection(conn())).toMatchObject({ ingested: 1 });
    expect(inserts('proof_of_payments')).toHaveLength(1);
  });

  it('sends an ABSA-looking notice that fails verification to normal capture (a person reviews it)', async () => {
    h.trusted = false;
    h.attachment = { contentType: '*/*', content: Buffer.from('%PDF-1.4 notice') };
    expect(await scanConnection(conn())).toMatchObject({ ingested: 1 });
    expect(inserts('proof_of_payments')).toEqual([]);
    const [doc] = inserts('captured_documents');
    expect(doc!.values).toContain('application/pdf'); // typed so the VLM read accepts it
    expect(inserts('capture_events')).toHaveLength(1);
    expect(scanLogOutcome()).toBe('ingested');
  });

  it('sends a trusted notice whose PDF does not read as a complete notice to normal capture', async () => {
    h.pdfText = NOTICE_TEXT.replace(/For the amount of.*\n/, '');
    expect(await scanConnection(conn())).toMatchObject({ ingested: 1 });
    expect(inserts('proof_of_payments')).toEqual([]);
    expect(inserts('capture_events')).toHaveLength(1);
  });

  it('sends a genuine ABSA notice from a payer the company does not trust to capture review', async () => {
    h.payerTrusted = false; // e.g. another ABSA customer had their notice mailed to this inbox
    expect(await scanConnection(conn())).toMatchObject({ ingested: 1 });
    expect(inserts('proof_of_payments')).toEqual([]);
    expect(inserts('capture_events')).toHaveLength(1);
    expect(scanLogOutcome()).toBe('ingested');
  });

  it('files nothing for a notice already held (same ABSA transaction number)', async () => {
    h.popHeld = true;
    expect(await scanConnection(conn())).toMatchObject({ ingested: 0, skipped: 1 });
    expect(inserts('captured_documents')).toEqual([]);
    expect(inserts('capture_events')).toEqual([]);
    expect(scanLogOutcome()).toBe('skipped_duplicate');
  });

  it('files nothing when the concurrent insert lost the race (ON CONFLICT returned no row)', async () => {
    const { sql } = await import('@/lib/neon');
    const real = vi.mocked(sql).getMockImplementation()!;
    vi.mocked(sql).mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (strings.join('?').includes('INSERT INTO proof_of_payments') ? (h.statements.push({ text: 'INSERT INTO proof_of_payments (race)', values }), []) : real(strings, ...values)));
    try {
      expect(await scanConnection(conn())).toMatchObject({ ingested: 0, skipped: 1, errors: 0 });
      expect(inserts('capture_events')).toEqual([]);
    } finally {
      vi.mocked(sql).mockImplementation(real);
    }
  });

  it('treats other ABSA mail (not a notice of payment) as ordinary mirror mail', async () => {
    h.envelope = { from: 'ibreply@absa.co.za', subject: 'Your monthly statement' };
    expect(await scanConnection(conn())).toMatchObject({ ingested: 1 });
    expect(inserts('proof_of_payments')).toEqual([]);
    expect(inserts('capture_events')).toHaveLength(1);
  });

  it('still skips mail that is neither an ABSA notice nor invoice-shaped', async () => {
    h.envelope = { from: 'someone@example.com', subject: 'Notice of payment: JANE Q PUBLIC' };
    expect(await scanConnection(conn())).toMatchObject({ ingested: 0, skipped: 1 });
    expect(scanLogOutcome()).toBe('skipped_not_invoice');
    expect(inserts('captured_documents')).toEqual([]);
  });
});
