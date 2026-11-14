/**
 * POP inbox, phase 1: the IMAP mirror's handling of ABSA "Notice of payment" mail.
 *   - a DKIM-trusted notice is filed as a proof of payment: no capture event, no VLM read;
 *   - a notice that is not filed (failed verification, untrusted payer, unreadable) is NOT read as a bill:
 *     it is logged as 'pop_not_filed' with its reason; a DNS failure stops the scan so the message is retried;
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
  trust: 'trusted' as 'trusted' | 'no_absa_signature' | 'dns_unavailable',
  pdfText: '',
  envelope: { from: 'ibreply@absa.co.za', subject: 'Notice of payment: JANE Q PUBLIC' },
  attachment: { contentType: 'application/pdf' as string, content: Buffer.from('%PDF-1.4 notice') },
  popHeld: null as null | { payment_date: string; amount: string; beneficiary: string },
  payerTrusted: true,
  stored: 0,
  stamps: [] as Array<{ text: string; params: unknown[] }>,
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
  isTrustedAbsaNotice: vi.fn(async () => (h.trust === 'trusted' ? { trusted: true } : { trusted: false, reason: h.trust })),
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
vi.mock('@/modules/accounting/services/capture/imapMirrorInbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/capture/imapMirrorInbox')>()),
  ensureMirrorInbox: vi.fn(async () => 'inbox-1'),
}));
vi.mock('@/modules/accounting/services/capture/capturedDocumentHash', () => ({ isFileAlreadyCaptured: vi.fn(async () => false) }));
vi.mock('@/lib/neon', () => {
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    h.statements.push({ text, values });
    if (/FROM proof_of_payments WHERE/.test(text)) return h.popHeld ? [h.popHeld] : [];
    if (/SELECT 1 FROM pop_trusted_payers/.test(text)) return h.payerTrusted && values[1] === 'EXAMPLE TRADING PTY LTD' ? [{ '?column?': 1 }] : [];
    return /RETURNING id/.test(text) ? [{ id: crypto.randomUUID() }] : [];
  });
  return { sql, withTransaction: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) };
});
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (_label: string, text: string, params: unknown[] = []) => {
    h.stamps.push({ text: text.replace(/\s+/g, ' ').trim(), params });
    return [];
  }),
}));

import { scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const conn = (): MirrorConnection => ({
  id: 'c1', companyId: COMPANY, provider: 'imap', accountEmail: 'pop@co.test', folder: 'INBOX', scanCursor: { INBOX: 10 },
  allowedSenders: [], deniedSenders: [], imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u',
  imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});
const inserts = (table: string) => h.statements.filter((s) => s.text.startsWith(`INSERT INTO ${table}`));
const scanLogOutcome = () => inserts('imap_mirror_scan_log')[0]?.values[6];
const scanLogError = () => inserts('imap_mirror_scan_log')[0]?.values[7];
const notReadAsBill = () => {
  expect(inserts('proof_of_payments')).toEqual([]);
  expect(inserts('captured_documents')).toEqual([]);
  expect(inserts('capture_events')).toEqual([]);
};

beforeEach(() => {
  h.statements.length = 0;
  h.trust = 'trusted';
  h.pdfText = NOTICE_TEXT;
  h.envelope = { from: 'ibreply@absa.co.za', subject: 'Notice of payment: JANE Q PUBLIC' };
  h.attachment = { contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 notice') };
  h.popHeld = null;
  h.payerTrusted = true;
  h.stored = 0;
  h.stamps.length = 0;
});

describe('IMAP mirror: ABSA notice of payment', () => {
  it('files a trusted notice as a proof of payment, with no capture event, and advances the cursor', async () => {
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
    expect(h.stamps.find((s) => s.text.includes('SET scan_cursor'))?.params[0]).toBe('{"INBOX":11}');
  });

  it('takes a notice PDF that ABSA labelled */*', async () => {
    h.attachment = { contentType: '*/*', content: Buffer.from('%PDF-1.4 notice') };
    expect(await scanConnection(conn())).toMatchObject({ ingested: 1 });
    expect(inserts('proof_of_payments')).toHaveLength(1);
  });

  it('does not file or read as a bill a notice that fails verification; logs why', async () => {
    h.trust = 'no_absa_signature';
    h.attachment = { contentType: '*/*', content: Buffer.from('%PDF-1.4 notice') };
    expect(await scanConnection(conn())).toMatchObject({ ingested: 0, skipped: 1, errors: 0 });
    notReadAsBill();
    expect(scanLogOutcome()).toBe('pop_not_filed');
    expect(scanLogError()).toBe('not filed: no_absa_signature');
  });

  it('stops the scan at a notice whose DKIM key lookup failed for DNS, so it is retried', async () => {
    h.trust = 'dns_unavailable';
    const r = await scanConnection(conn());
    expect(r).toMatchObject({ ingested: 0, errors: 1 });
    notReadAsBill();
    expect(scanLogOutcome()).toBe('error');
    // The cursor is not moved past the message, and the stop is stamped with why.
    expect(h.stamps.filter((s) => s.text.includes('SET scan_cursor'))).toEqual([]);
    expect(h.stamps.find((s) => s.text.includes('last_error = $1'))?.params[0]).toMatch(/DNS/);
  });

  it('does not file or read as a bill a trusted notice whose PDF does not read as a complete notice', async () => {
    h.pdfText = NOTICE_TEXT.replace(/For the amount of.*\n/, '');
    expect(await scanConnection(conn())).toMatchObject({ ingested: 0, skipped: 1 });
    notReadAsBill();
    expect(scanLogError()).toBe('not filed: missing_amount');
  });

  it('does not file or read as a bill a genuine notice from a payer the company does not trust', async () => {
    h.payerTrusted = false; // e.g. another ABSA customer had their notice mailed to this inbox
    expect(await scanConnection(conn())).toMatchObject({ ingested: 0, skipped: 1 });
    notReadAsBill();
    expect(scanLogError()).toBe('not filed: payer_not_trusted');
  });

  it('logs (does not drop as a duplicate) a reused transaction number that names a different payment', async () => {
    h.popHeld = { payment_date: '2026-11-13', amount: '2750.00', beneficiary: 'JANE Q PUBLIC' };
    expect(await scanConnection(conn())).toMatchObject({ ingested: 0, skipped: 1 });
    notReadAsBill();
    expect(scanLogError()).toBe('not filed: transaction_number_conflict');
  });

  it('files nothing for a notice already held (same ABSA transaction number)', async () => {
    h.popHeld = { payment_date: '2026-11-13', amount: '3000.00', beneficiary: 'JANE Q PUBLIC' };
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
