/**
 * A scripted IMAP server for the mirror scans' tests. The real ImapFlow runs against it: the
 * test spies on `tls.connect` and returns a FakeImap (a Duplex), so the whole protocol exchange
 * is real and nothing leaves the process. One FakeServer per mail host; the scan's vetted
 * address is the server's key (tests make `node:dns/promises` answer a distinct address per host).
 *
 * Modes: 'ok' serves `messages` (UID FETCH of a range answers every message at or past its start,
 * or the last one when none is, as RFC 3501 6.4.8 has it); 'drip' answers SELECT with an untagged
 * line every 100 ms and never the tagged completion (the socket is never idle); 'throttle' answers
 * every UID FETCH with a throttle BAD asking for `backoffMs`.
 */
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { vi } from 'vitest';

export interface FakeMessage { uid: number; subject?: string; size?: number; pdf?: string }

export interface FakeServer {
  mode: 'ok' | 'drip' | 'throttle';
  uidNext: number;
  messages: FakeMessage[];
  backoffMs?: number;
  /** Every command line the client sent (LOGIN's password masked). */
  commands: string[];
  /** Every idle timeout the client asked the socket for. */
  socketTimeouts: number[];
  /** Connections opened to it. */
  connects: number;
}

export const fakeServer = (over: Partial<FakeServer> = {}): FakeServer =>
  ({ mode: 'ok', uidNext: 1, messages: [], commands: [], socketTimeouts: [], connects: 0, ...over });

const envelope = (subject: string) => `ENVELOPE (NIL "${subject}" (("a" NIL "a" "b.test")) NIL NIL (("c" NIL "c" "d.test")) NIL NIL NIL NIL)`;
const mime = (tag: string) => [
  'From: a@b.test', 'To: c@d.test', 'Subject: Invoice', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=XX', '',
  '--XX', 'Content-Type: text/plain', '', 'hi', '--XX', `Content-Type: application/pdf; name="${tag}.pdf"`,
  `Content-Disposition: attachment; filename="${tag}.pdf"`, '', tag, '--XX--', ''].join('\r\n');

export class FakeImap extends Duplex {
  remoteAddress = '93.184.216.34'; remotePort = 993; localAddress = '10.0.0.9'; localPort = 5555;
  authorized = true;
  private buf = '';
  private drip: NodeJS.Timeout | null = null;

  constructor(private readonly server: FakeServer, private readonly registry: FakeImap[]) {
    super();
    registry.push(this);
    server.connects += 1;
    setImmediate(() => this.line('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready'));
  }

  getCipher() { return { name: 'fake' }; }
  setKeepAlive() { return this; }
  setNoDelay() { return this; }
  setTimeout(ms: number) { this.server.socketTimeouts.push(ms); return this; }
  line(s: string) { this.push(`${s}\r\n`); }
  kill() { if (this.drip) clearInterval(this.drip); this.push(null); }
  _read() { /* data is pushed by the script */ }

  _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.buf += chunk.toString();
    let i = this.buf.indexOf('\r\n');
    while (i >= 0) {
      const l = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      this.handle(l);
      i = this.buf.indexOf('\r\n');
    }
    cb();
  }

  private handle(line: string) {
    this.server.commands.push(line.replace(/LOGIN .*/, 'LOGIN ***'));
    const [tag, c1, c2, range] = line.split(' ');
    const cmd = (c1 ?? '').toUpperCase();
    const out = (s: string) => setImmediate(() => this.line(s));
    const s = this.server;
    if (cmd === 'CAPABILITY') { out('* CAPABILITY IMAP4rev1 AUTH=PLAIN'); out(`${tag} OK`); return; }
    if (cmd === 'LOGIN' || cmd === 'AUTHENTICATE') { out(`${tag} OK [CAPABILITY IMAP4rev1] logged in`); return; }
    if (cmd === 'SELECT' || cmd === 'EXAMINE') {
      if (s.mode === 'drip') { this.drip = setInterval(() => this.line('* OK still selecting'), 100); return; }
      out(`* ${s.messages.length} EXISTS`); out('* OK [UIDVALIDITY 7] v'); out(`* OK [UIDNEXT ${s.uidNext}] n`); out(`${tag} OK [READ-WRITE] selected`); return;
    }
    if (cmd === 'UID' && (c2 ?? '').toUpperCase() === 'FETCH') { this.fetch(tag!, range ?? '', out); return; }
    if (cmd === 'LOGOUT') { out('* BYE'); out(`${tag} OK`); setImmediate(() => this.kill()); return; }
    out(`${tag} OK`);
  }

  private fetch(tag: string, range: string, out: (s: string) => void) {
    const s = this.server;
    if (s.mode === 'throttle') { out(`${tag} BAD Request is throttled. Suggested Backoff Time: ${s.backoffMs ?? 2147483647} milliseconds`); return; }
    if (range.includes(':')) {
      const from = Number(range.split(':')[0]);
      const past = s.messages.filter((m) => m.uid >= from);
      const answer = past.length > 0 ? past : s.messages.slice(-1);
      answer.forEach((m, n) => out(`* ${n + 1} FETCH (UID ${m.uid} RFC822.SIZE ${m.size ?? 200} ${envelope(m.subject ?? 'Invoice')})`));
      out(`${tag} OK fetched`);
      return;
    }
    const uid = Number(range);
    const m = s.messages.find((x) => x.uid === uid);
    if (!m) { out(`${tag} OK fetched`); return; }
    const body = mime(m.pdf ?? `body-of-${uid}`);
    out(`* 1 FETCH (UID ${uid} BODY[] {${Buffer.byteLength(body)}}\r\n${body})`);
    out(`${tag} OK fetched`);
  }
}

/** Routes `tls.connect` to the FakeServer keyed by the address the scan dials. Call `close()` in afterEach. */
export function installFakeImap(servers: Record<string, FakeServer>): { close: () => void; sockets: FakeImap[] } {
  const live: FakeImap[] = [];
  vi.spyOn(tls, 'connect').mockImplementation(((o: { host?: string }, cb?: () => void) => {
    const server = servers[o.host ?? ''];
    if (!server) throw new Error(`no fake IMAP server for ${o.host}`);
    const sock = new FakeImap(server, live);
    if (cb) setImmediate(cb);
    return sock as never;
  }) as never);
  return { sockets: live, close: () => { for (const s of live) s.kill(); vi.restoreAllMocks(); } };
}
