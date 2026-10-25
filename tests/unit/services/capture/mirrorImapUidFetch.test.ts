/**
 * S-07e part B, review round 3: the mirror cursor is an IMAP UID, so every FETCH a
 * scan sends must be a UID FETCH. ImapFlow takes that as `{ uid: true }` in its
 * OPTIONS argument; `uid: true` in the query only asks for the UID attribute, and
 * a plain FETCH reads the number as a message sequence number. The two differ as
 * soon as one message has been expunged, so the scan used to skip new mail and to
 * ingest the body of a different message than the one whose envelope passed the
 * allowed/denied-sender filter.
 *
 * ImapFlow is the real class, talking to a scripted IMAP server over a spied
 * socket (nothing leaves the process). The mailbox has had UIDs 4, 7 and 8
 * expunged, so its messages are
 *   seq 1 = UID 3, seq 2 = UID 5, seq 3 = UID 6, seq 4 = UID 9   (UIDNEXT 10)
 * and each carries a PDF named after its own UID.
 */
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  lookup: vi.fn(),
  sql: [] as Array<{ text: string; values: unknown[] }>,
  commands: [] as string[],
  /** A server that answers a body fetch with the next message's UID (a bug, or a hostile server). */
  wrongBody: false,
}));

vi.mock('node:dns/promises', () => ({ lookup: h.lookup }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => {
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    h.sql.push({ text, values });
    return /RETURNING id/.test(text) ? [{ id: crypto.randomUUID() }] : [];
  });
  return { sql, withTransaction: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) };
});
// The connection-row stamps run on migration_admin (S-07e part B): the same recorder.
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (_label: string, text: string, values: unknown[]) => {
    h.sql.push({ text: text.replace(/\s+/g, ' ').trim(), values });
    return [];
  }),
}));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'password' }));
vi.mock('@/lib/documentStorage', () => ({ sha256: () => 'sha', storeCapturedBytes: async () => ({ bucket: 'b', path: 'p' }) }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({ routeEvent: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/capture/imapMirrorInbox', () => ({
  ensureMirrorInbox: vi.fn(async () => 'inbox-1'), isTransientIngestError: vi.fn(() => false),
}));
vi.mock('@/modules/accounting/services/capture/mirrorScanError', () => ({ markMirrorScanError: vi.fn() }));

import { scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { scanSentConnection, type SentMirrorConnection } from '@/modules/accounting/services/ar/sentMirrorService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PUBLIC = '93.184.216.34';
const UIDNEXT = 10;

interface Msg { seq: number; uid: number; from: string; subject: string; file: string; source: string }
const message = (seq: number, uid: number, from: string, name: string): Msg => {
  const file = `${name}.pdf`;
  const source = [
    `From: ${from}`, 'To: ap@co.test', `Subject: Invoice ${name}`, 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="bnd"', '',
    '--bnd', 'Content-Type: text/plain', '', `body of ${name}`,
    '--bnd', `Content-Type: application/pdf; name="${file}"`, `Content-Disposition: attachment; filename="${file}"`,
    'Content-Transfer-Encoding: base64', '', Buffer.from(`%PDF-1.4 ${name}`).toString('base64'),
    '--bnd--', '',
  ].join('\r\n');
  return { seq, uid, from, subject: `Invoice ${name}`, file, source };
};
const MAILBOX: Msg[] = [
  message(1, 3, 'a@ok.test', 'three'), message(2, 5, 'a@ok.test', 'five'),
  message(3, 6, 'a@ok.test', 'six'), message(4, 9, 'spam@denied.test', 'nine'),
];

/** A set such as `6:*`, `3` or `1,4:5`, resolved against the highest key like an IMAP server does (`*` = highest; a:b = b:a). */
function resolveSet(set: string, highest: number): (key: number) => boolean {
  const ranges = set.split(',').map((part) => {
    const [a, b = a] = part.split(':').map((x) => (x === '*' ? highest : Number(x)));
    return [Math.min(a!, b!), Math.max(a!, b!)] as const;
  });
  return (key) => ranges.some(([lo, hi]) => key >= lo && key <= hi);
}

/** A scripted IMAP server that answers FETCH (sequence numbers) and UID FETCH (UIDs) the way RFC 3501 says. */
class ScriptedImap extends Duplex {
  remoteAddress = PUBLIC; remotePort = 993; localAddress = '10.0.0.9'; localPort = 5555;
  private buf = '';
  constructor() {
    super();
    setImmediate(() => this.push('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n'));
  }
  setKeepAlive() { return this; }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  _read() { /* answers are pushed */ }
  _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.buf += chunk.toString();
    let i: number;
    while ((i = this.buf.indexOf('\r\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      this.handle(line);
    }
    cb();
  }
  private reply(s: string) { setImmediate(() => this.push(s)); }
  private handle(line: string) {
    h.commands.push(line.replace(/LOGIN .*/, 'LOGIN ***'));
    const [tag, first, second, set, items = ''] = line.split(/ (?![^(]*\))/);
    const cmd = (first ?? '').toUpperCase();
    const ok = (extra = '') => this.reply(`${tag} OK${extra}\r\n`);
    if (cmd === 'CAPABILITY') { this.reply('* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n'); ok(); return; }
    if (cmd === 'LOGIN' || cmd === 'AUTHENTICATE') { ok(' [CAPABILITY IMAP4rev1] logged in'); return; }
    if (cmd === 'SELECT' || cmd === 'EXAMINE') {
      this.reply(`* ${MAILBOX.length} EXISTS\r\n* OK [UIDVALIDITY 7] v\r\n* OK [UIDNEXT ${UIDNEXT}] n\r\n* FLAGS (\\Seen)\r\n`);
      ok(' [READ-WRITE] selected');
      return;
    }
    if (cmd === 'LOGOUT') { this.reply('* BYE\r\n'); ok(); setImmediate(() => this.push(null)); return; }
    const byUid = cmd === 'UID' && (second ?? '').toUpperCase() === 'FETCH';
    if (cmd === 'FETCH' || byUid) {
      const [setText, itemText] = byUid ? [set!, items] : [second!, set ?? ''];
      const wanted = resolveSet(setText, byUid ? Math.max(...MAILBOX.map((m) => m.uid)) : MAILBOX.length);
      for (const m of MAILBOX.filter((x) => wanted(byUid ? x.uid : x.seq))) {
        let atoms = `UID ${m.uid}`;
        if (/RFC822\.SIZE/.test(itemText)) atoms += ` RFC822.SIZE ${m.source.length}`;
        if (/ENVELOPE/.test(itemText)) {
          const [mailbox, host] = m.from.split('@');
          atoms += ` ENVELOPE (NIL "${m.subject}" (("x" NIL "${mailbox}" "${host}")) NIL NIL (("c" NIL "ap" "co.test")) NIL NIL NIL NIL)`;
        }
        if (/BODY\.PEEK\[\]/.test(itemText)) {
          const sent = h.wrongBody ? MAILBOX[m.seq % MAILBOX.length]! : m;
          atoms = atoms.replace(`UID ${m.uid}`, `UID ${sent.uid}`) + ` BODY[] {${Buffer.byteLength(sent.source)}}\r\n${sent.source}`;
        }
        this.reply(`* ${m.seq} FETCH (${atoms})\r\n`);
      }
      ok(' fetched');
      return;
    }
    ok();
  }
}

beforeEach(() => {
  h.sql.length = 0;
  h.commands.length = 0;
  h.wrongBody = false;
  h.lookup.mockReset();
  h.lookup.mockResolvedValue([{ address: PUBLIC, family: 4 }]);
  vi.spyOn(tls, 'connect').mockImplementation(((_o: unknown, cb?: () => void) => {
    const s = new ScriptedImap() as unknown as { getCipher: () => object; authorized: boolean };
    s.getCipher = () => ({ name: 'scripted' });
    s.authorized = true;
    if (cb) setImmediate(cb);
    return s as never;
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

const imapConn = (scanCursor: Record<string, number>): MirrorConnection => ({
  id: 'c1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', folder: 'INBOX', scanCursor,
  allowedSenders: [], deniedSenders: ['denied.test'], imapHost: 'imap.uid.test', imapPort: 993, imapUseTls: true,
  imapUsername: 'u', imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});
const sentConn = (scanCursor: Record<string, number>): SentMirrorConnection => ({
  id: 's1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', sentFolder: 'INBOX', scanCursor,
  imapHost: 'imap.uid.test', imapPort: 993, imapUseTls: true, imapUsername: 'u', imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});

const fetchCommands = () => h.commands.filter((c) => /\bFETCH\b/.test(c));
/** The imap_uid of each scan-log row; the log's values are (connection, company, uid, ...). */
const loggedUids = (table: string) => h.sql.filter((q) => q.text.startsWith(`INSERT INTO ${table}`)).map((q) => String(q.values[2]));
/** The attachment file of the message ingested just before each scan-log row: [imap_uid, file]. */
function ingestedFilesByLoggedUid(logTable: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  let file: string | null = null;
  for (const q of h.sql) {
    if (q.text.startsWith('INSERT INTO captured_documents')) file = String(q.values[1]);
    if (q.text.startsWith(`INSERT INTO ${logTable}`)) {
      if (file) pairs.push([String(q.values[2]), file]);
      file = null;
    }
  }
  return pairs;
}
const cursorStored = (table: string) => {
  const w = h.sql.find((q) => q.text.startsWith(`UPDATE ${table} SET scan_cursor`));
  return w ? JSON.parse(String(w.values[0])) as Record<string, number> : null;
};

describe('capture mirror: UID FETCH, in a mailbox whose UIDs are not its sequence numbers', () => {
  it('after cursor UID 5, fetches exactly UIDs 6 and 9 (a plain FETCH 6:* would read 6 as a sequence number)', async () => {
    const r = await scanConnection(imapConn({ INBOX: 5 }));
    expect(fetchCommands()[0]).toMatch(/^\d+ UID FETCH 6:\* /);
    expect(loggedUids('imap_mirror_scan_log')).toEqual(['6', '9']);
    expect([r.scanned, r.ingested, r.skipped, r.errors]).toEqual([2, 1, 1, 0]);
    expect(cursorStored('imap_mirror_connections')).toEqual({ INBOX: 9 });
  });

  it('ingests the body of the message whose envelope passed the filter, not the one at that sequence number', async () => {
    await scanConnection(imapConn({}));
    expect(fetchCommands().every((c) => / UID FETCH /.test(c))).toBe(true);
    expect(ingestedFilesByLoggedUid('imap_mirror_scan_log')).toEqual([
      ['3', 'three.pdf'], ['5', 'five.pdf'], ['6', 'six.pdf'],
    ]);
  });

  it('a cursor on the newest message is not read again: N:* beyond the last UID answers with that last message', async () => {
    const r = await scanConnection(imapConn({ INBOX: 9 }));
    expect(fetchCommands()[0]).toMatch(/^\d+ UID FETCH 10:\* /);
    expect([r.scanned, r.ingested, h.sql.filter((q) => q.text.startsWith('INSERT INTO imap_mirror_scan_log')).length]).toEqual([0, 0, 0]);
  });
});

describe('a body that is not the one asked for is never ingested', () => {
  it('capture mirror: the answer names another UID, so the message is skipped', async () => {
    h.wrongBody = true;
    const r = await scanConnection(imapConn({ INBOX: 5 }));
    expect([r.ingested, r.skipped, r.errors]).toEqual([0, 2, 0]);
    expect(h.sql.some((q) => q.text.startsWith('INSERT INTO captured_documents'))).toBe(false);
  });

  it('sent mirror: the answer names another UID, so the message is skipped', async () => {
    h.wrongBody = true;
    const r = await scanSentConnection(sentConn({ INBOX: 5 }));
    expect([r.captured, r.skipped, r.errors]).toEqual([0, 2, 0]);
    expect(h.sql.some((q) => q.text.startsWith('INSERT INTO captured_documents'))).toBe(false);
  });
});

describe('sent mirror: UID FETCH, in a mailbox whose UIDs are not its sequence numbers', () => {
  it('after cursor UID 5, fetches exactly UIDs 6 and 9', async () => {
    const r = await scanSentConnection(sentConn({ INBOX: 5 }));
    expect(fetchCommands()[0]).toMatch(/^\d+ UID FETCH 6:\* /);
    expect(loggedUids('sent_mirror_scan_log')).toEqual(['6', '9']);
    expect([r.scanned, r.captured, r.errors]).toEqual([2, 2, 0]);
    expect(ingestedFilesByLoggedUid('sent_mirror_scan_log')).toEqual([['6', 'six.pdf'], ['9', 'nine.pdf']]);
    expect(cursorStored('sent_mirror_connections')).toEqual({ INBOX: 9 });
  });

  it('captures each message\'s own attachment', async () => {
    await scanSentConnection(sentConn({}));
    expect(fetchCommands().every((c) => / UID FETCH /.test(c))).toBe(true);
    expect(ingestedFilesByLoggedUid('sent_mirror_scan_log')).toEqual([
      ['3', 'three.pdf'], ['5', 'five.pdf'], ['6', 'six.pdf'], ['9', 'nine.pdf'],
    ]);
  });

  it('a cursor on the newest message (UIDNEXT - 1) fetches nothing', async () => {
    const r = await scanSentConnection(sentConn({ INBOX: 9 }));
    expect(fetchCommands()).toEqual([]);
    expect([r.scanned, r.captured]).toEqual([0, 0]);
  });
});
