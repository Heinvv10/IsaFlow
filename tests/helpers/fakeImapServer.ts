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
 *
 * Sizes (S-07e part B, review round 5): a message may claim one RFC822.SIZE (`size`, or none
 * with `noSize`) and send a body of `bodyBytes` instead, or an envelope whose subject is a
 * literal of `subjectBytes`. Those are streamed in 64 KB chunks as the client reads, so a
 * client that closes the socket stops the server; `sentBytes` counts what it sent.
 */
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { vi } from 'vitest';

export interface FakeMessage {
  uid: number; subject?: string; size?: number; pdf?: string;
  /** Leave RFC822.SIZE out of the envelope answer. */
  noSize?: boolean;
  /** Send a body literal of this many bytes, whatever `size` says. */
  bodyBytes?: number;
  /** Send the envelope's subject as a literal of this many bytes. */
  subjectBytes?: number;
}

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
  /** Bytes it has sent, over every connection. */
  sentBytes: number;
}

export const fakeServer = (over: Partial<FakeServer> = {}): FakeServer =>
  ({ mode: 'ok', uidNext: 1, messages: [], commands: [], socketTimeouts: [], connects: 0, sentBytes: 0, ...over });

const envelope = (subject: string) => `ENVELOPE (NIL "${subject}" (("a" NIL "a" "b.test")) NIL NIL (("c" NIL "c" "d.test")) NIL NIL NIL NIL)`;
const mime = (tag: string, subject = 'Invoice') => [
  'From: a@b.test', 'To: c@d.test', `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=XX', '',
  '--XX', 'Content-Type: text/plain', '', 'hi', '--XX', `Content-Type: application/pdf; name="${tag}.pdf"`,
  `Content-Disposition: attachment; filename="${tag}.pdf"`, '', tag, '--XX--', ''].join('\r\n');

export class FakeImap extends Duplex {
  remoteAddress = '93.184.216.34'; remotePort = 993; localAddress = '10.0.0.9'; localPort = 5555;
  authorized = true;
  private buf = '';
  private drip: NodeJS.Timeout | null = null;
  /** Literal bytes still to stream, then the text that follows them. */
  private streaming: Array<{ remaining: number; after: string }> = [];

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
  /** A line, after anything still streaming. */
  line(s: string) {
    if (this.streaming.length > 0) this.streaming.push({ remaining: 0, after: `${s}\r\n` });
    else this.send(`${s}\r\n`);
  }
  kill() { if (this.drip) clearInterval(this.drip); this.streaming = []; this.push(null); }
  _read() { this.pump(); }

  private send(s: string): boolean {
    if (this.destroyed) return false;
    this.server.sentBytes += Buffer.byteLength(s);
    return this.push(s);
  }

  /** `head`, then `bytes` of filler as the client reads them, then `after`: all after anything still streaming. */
  private stream(head: string, bytes: number, after: string) {
    this.streaming.push({ remaining: 0, after: head }, { remaining: bytes, after });
    this.pump();
  }

  private pump() {
    while (this.streaming.length > 0 && !this.destroyed) {
      const cur = this.streaming[0]!;
      if (cur.remaining === 0) { this.streaming.shift(); if (!this.send(cur.after)) return; continue; }
      const n = Math.min(64 * 1024, cur.remaining);
      cur.remaining -= n;
      this.server.sentBytes += n;
      if (!this.push(Buffer.alloc(n, 0x41))) return;
    }
  }

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
      setImmediate(() => {
        answer.forEach((m, n) => {
          const size = m.noSize ? '' : ` RFC822.SIZE ${m.size ?? 200}`;
          if (!m.subjectBytes) { this.line(`* ${n + 1} FETCH (UID ${m.uid}${size} ${envelope(m.subject ?? 'Invoice')})`); return; }
          const [pre, post] = envelope('\u0000').split('"\u0000"');
          this.stream(`* ${n + 1} FETCH (UID ${m.uid}${size} ${pre}{${m.subjectBytes}}\r\n`, m.subjectBytes, `${post})\r\n`);
        });
        this.line(`${tag} OK fetched`);
      });
      return;
    }
    const uid = Number(range);
    const m = s.messages.find((x) => x.uid === uid);
    if (!m) { out(`${tag} OK fetched`); return; }
    if (m.bodyBytes) {
      setImmediate(() => this.stream(`* 1 FETCH (UID ${uid} BODY[] {${m.bodyBytes}}\r\n`, m.bodyBytes!, `)\r\n${tag} OK fetched\r\n`));
      return;
    }
    const body = mime(m.pdf ?? `body-of-${uid}`, m.subject);
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
