// Checks — and with --apply, makes — a disposable database's schema match the migrations of ONE commit.
//
// Brought into the repository unchanged from the throwaway UI-proof harness written earlier in the
// forensic-controls programme, where it solved the same problem against a scratch stack. It lives
// here because it is what keeps fixture/schema.sql honest: a snapshot nobody can verify against the
// branch is worse than no fixture. Wrapper: fixture-verify.sh. See fixture/README.md.
//
// usage: bun schema-match.ts --repo R --commit SHA --db URL --node-base DIR [--reverts DIR] [--floor 600] [--apply]
//
// The fixture's schema_migrations table is empty, so the migration FILES are the source of truth:
//  * expected: every table, ADD COLUMN, trigger and function body that the commit's migrations leave behind
//    (replayed in apply order, honouring later DROP/RENAME), for objects last touched by a file >= --floor;
//    function bodies compare byte-for-byte against pg_proc.prosrc.
//  * ahead: objects created by migration files that exist in ANY git ref but not in the commit. Present => that
//    migration was applied to the source schema, and it needs reverts/<migration file name>.sql.
//  * a revert file declares `-- migration: <file>` and `-- detect: <SQL returning one boolean>` so migrations
//    that leave no object (grants) are detected too. After applying, every detect must be false.
// Refuses (exit 2) on an ahead migration without a revert file, or a revert file for a migration the commit HAS.
// Exit 1 on any remaining mismatch, 0 on an exact match. Limitation: privileges are checked only via detect lines.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const REPO = arg('repo'), SHA = arg('commit'), DB = arg('db'), NODE_BASE = arg('node-base'), REVERTS = arg('reverts');
const FLOOR = Number(arg('floor', '600')), APPLY = process.argv.includes('--apply');
if (!REPO || !SHA || !DB || !NODE_BASE) { console.error('usage: bun schema-match.ts --repo R --commit SHA --db URL --node-base DIR [--reverts DIR] [--floor N] [--apply]'); process.exit(2); }
const dbUrl = new URL(DB);
if (!['127.0.0.1', 'localhost'].includes(dbUrl.hostname)) throw new Error('loopback databases only');
if (APPLY && dbUrl.port === '33149') throw new Error('refusing --apply against the shared fixture');
const pg = createRequire(join(NODE_BASE, 'package.json'))('pg');
const MIG = 'scripts/migrations/sql';
const git = (...a: string[]) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });

function catBlobs(specs: string[]): string[] {
  if (!specs.length) return [];
  const r = spawnSync('git', ['-C', REPO, 'cat-file', '--batch'], { input: specs.join('\n') + '\n', maxBuffer: 1 << 30 });
  const buf = r.stdout as Buffer, out: string[] = [];
  let pos = 0;
  for (const spec of specs) {
    const nl = buf.indexOf(10, pos), header = buf.subarray(pos, nl).toString();
    if (header.endsWith(' missing')) throw new Error(`git object missing: ${spec}`);
    const size = Number(header.split(' ')[2]);
    out.push(buf.subarray(nl + 1, nl + 1 + size).toString('utf8'));
    pos = nl + 1 + size + 1;
  }
  return out;
}
const version = (name: string) => { const m = /^(\d+)([a-z]?)_/.exec(name); if (!m) throw new Error(`unversioned migration ${name}`); return { n: Number(m[1]), l: m[2] ?? '' }; };
const byApplyOrder = (a: string, b: string) => { const x = version(a), y = version(b); return x.n - y.n || (x.l < y.l ? -1 : x.l > y.l ? 1 : a < b ? -1 : a > b ? 1 : 0); };

type Ev = { at: number; kind: string; a: string; b?: string; body?: string | null; stmt?: string };
const ident = (s: string) => s.replace(/"/g, '').toLowerCase();
/** Blank comments without moving offsets, so positions in the stripped text index the raw text. */
const strip = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length)).replace(/--[^\n]*/g, m => ' '.repeat(m.length));

function parse(raw: string): Ev[] {
  let s = strip(raw);
  const ev: Ev[] = [];
  // Functions first: their bodies are masked so CREATE TABLE etc. inside plpgsql are not mistaken for DDL.
  for (const m of s.matchAll(/\bcreate\s+(?:or\s+replace\s+)?function\s+(?:public\.)?("?\w+"?)\s*\(/gi)) {
    const start = m.index!, semi = s.indexOf(';', start);
    const as = /\bas\s+(\$[A-Za-z0-9_]*\$)/gi; as.lastIndex = start;
    const hit = as.exec(s);
    if (!hit || (semi >= 0 && semi < hit.index)) { ev.push({ at: start, kind: 'fn+', a: ident(m[1]), body: null }); continue; }
    const tag = hit[1], bodyStart = hit.index + hit[0].length, bodyEnd = raw.indexOf(tag, bodyStart);
    if (bodyEnd < 0) throw new Error('unterminated function body');
    const end = s.indexOf(';', bodyEnd + tag.length);
    ev.push({ at: start, kind: 'fn+', a: ident(m[1]), body: raw.slice(bodyStart, bodyEnd), stmt: raw.slice(start, end + 1) });
    s = s.slice(0, bodyStart) + ' '.repeat(bodyEnd - bodyStart) + s.slice(bodyEnd);
  }
  for (const m of s.matchAll(/\bdrop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?("?\w+"?)/gi)) ev.push({ at: m.index!, kind: 'fn-', a: ident(m[1]) });
  for (const m of s.matchAll(/\bcreate\s+(?:(?:global|local)\s+)?(temp\s+|temporary\s+)?(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?("?\w+"?)/gi)) if (!m[1]) ev.push({ at: m.index!, kind: 'table+', a: ident(m[2]) });
  for (const m of s.matchAll(/\bdrop\s+table\s+(?:if\s+exists\s+)?([^;]+?)(?:\s+cascade|\s+restrict)?\s*;/gi)) for (const t of m[1].split(',')) ev.push({ at: m.index!, kind: 'table-', a: ident(t.trim().replace(/^public\./i, '')) });
  for (const m of s.matchAll(/\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?("?\w+"?)\s+([^;]*)/gi)) {
    const t = ident(m[1]), body = m[2];
    const ren = /^\s*rename\s+to\s+("?\w+"?)/i.exec(body);
    if (ren) { ev.push({ at: m.index!, kind: 'rename', a: t, b: ident(ren[1]) }); continue; }
    for (const c of body.matchAll(/\badd\s+column\s+(?:if\s+not\s+exists\s+)?("?\w+"?)/gi)) ev.push({ at: m.index! + c.index!, kind: 'col+', a: `${t}.${ident(c[1])}` });
    for (const c of body.matchAll(/\bdrop\s+column\s+(?:if\s+exists\s+)?("?\w+"?)/gi)) ev.push({ at: m.index! + c.index!, kind: 'col-', a: `${t}.${ident(c[1])}` });
    for (const c of body.matchAll(/\brename\s+column\s+("?\w+"?)\s+to\s+("?\w+"?)/gi)) ev.push({ at: m.index! + c.index!, kind: 'colrename', a: `${t}.${ident(c[1])}`, b: `${t}.${ident(c[2])}` });
  }
  // (?![.%\w]) and [^;]: dynamic DDL such as format('... ON public.%I', t) names no table and is skipped.
  for (const m of s.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+("?\w+"?)\s[^;]*?\bon\s+(?:public\.)?("?\w+"?)(?![.%\w])/gi)) ev.push({ at: m.index!, kind: 'trg+', a: `${ident(m[2])}.${ident(m[1])}` });
  for (const m of s.matchAll(/\bdrop\s+trigger\s+(?:if\s+exists\s+)?("?\w+"?)\s+on\s+(?:public\.)?("?\w+"?)(?![.%\w])/gi)) ev.push({ at: m.index!, kind: 'trg-', a: `${ident(m[2])}.${ident(m[1])}` });
  return ev.sort((x, y) => x.at - y.at);
}

type Origin = { file: string; body?: string | null; stmt?: string };
class Schema {
  tables = new Map<string, Origin>(); cols = new Map<string, Origin>(); fns = new Map<string, Origin>(); trgs = new Map<string, Origin>();
  ever = new Set<string>();
  apply(file: string, evs: Ev[]) {
    for (const e of evs) {
      const o = { file };
      switch (e.kind) {
        case 'table+': this.tables.set(e.a, o); this.ever.add(`table:${e.a}`); break;
        case 'table-': this.tables.delete(e.a); for (const m of [this.cols, this.trgs]) for (const k of [...m.keys()]) if (k.startsWith(`${e.a}.`)) m.delete(k); break;
        case 'rename': for (const m of [this.cols, this.trgs]) for (const [k, v] of [...m]) if (k.startsWith(`${e.a}.`)) { m.delete(k); m.set(`${e.b}.${k.slice(e.a.length + 1)}`, v); }
          if (this.tables.has(e.a)) { this.tables.set(e.b!, this.tables.get(e.a)!); this.tables.delete(e.a); } this.ever.add(`table:${e.b}`); break;
        case 'col+': this.cols.set(e.a, o); this.ever.add(`col:${e.a}`); break;
        case 'col-': this.cols.delete(e.a); break;
        case 'colrename': if (this.cols.has(e.a)) this.cols.delete(e.a); this.cols.set(e.b!, o); this.ever.add(`col:${e.b}`); break;
        case 'fn+': this.fns.set(e.a, { file, body: e.body, stmt: e.stmt }); this.ever.add(`fn:${e.a}`); break;
        case 'fn-': this.fns.delete(e.a); break;
        case 'trg+': this.trgs.set(e.a, o); this.ever.add(`trg:${e.a}`); break;
        case 'trg-': this.trgs.delete(e.a); break;
      }
    }
  }
}

// ── the commit's migrations ──────────────────────────────────────────────────
const commitFiles = git('ls-tree', '--name-only', SHA, `${MIG}/`).split('\n').filter(Boolean).map(p => p.slice(MIG.length + 1)).filter(n => n.endsWith('.sql')).sort(byApplyOrder);
const commitText = new Map(commitFiles.map((n, i) => [n, catBlobs(commitFiles.map(f => `${SHA}:${MIG}/${f}`))[i]!]));
const expected = new Schema();
for (const f of commitFiles) expected.apply(f, parse(commitText.get(f)!));
const recent = (o: Origin) => version(o.file).n >= FLOOR;

// ── migrations in any ref but not in the commit ─────────────────────────────
const inCommit = new Set(commitFiles);
const raw = git('log', '--all', '--format=', '--raw', '--no-abbrev', '--', `${MIG}/`);
const aheadBlobs = new Map<string, Set<string>>();
for (const line of raw.split('\n')) {
  const m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) \w+\t(.+)$/.exec(line);
  if (!m || /^0+$/.test(m[1])) continue;
  const name = m[2].slice(MIG.length + 1);
  if (!name.endsWith('.sql') || inCommit.has(name) || version(name).n < FLOOR) continue;
  (aheadBlobs.get(name) ?? aheadBlobs.set(name, new Set()).get(name)!).add(m[1]);
}
const aheadObjects = new Map<string, Set<string>>(); // "kind:key" -> ahead files that create it
for (const [name, blobs] of aheadBlobs) for (const text of catBlobs([...blobs])) {
  const local = new Schema(); local.apply(name, parse(text));
  for (const key of local.ever) if (!expected.ever.has(key)) (aheadObjects.get(key) ?? aheadObjects.set(key, new Set()).get(key)!).add(name);
}

// ── revert files ────────────────────────────────────────────────────────────
type Revert = { file: string; migration: string; detect: string; sql: string };
const reverts: Revert[] = [];
if (REVERTS && existsSync(REVERTS)) for (const f of readdirSync(REVERTS).filter(f => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(REVERTS, f), 'utf8');
  const migration = /^--\s*migration:\s*(\S+)/m.exec(sql)?.[1], detect = /^--\s*detect:\s*(.+)$/m.exec(sql)?.[1];
  if (!migration || !detect) { console.error(`REFUSED: ${f} lacks -- migration: / -- detect: headers`); process.exit(2); }
  if (inCommit.has(migration)) { console.error(`REFUSED: ${f} would revert ${migration}, which commit ${SHA.slice(0, 9)} contains`); process.exit(2); }
  reverts.push({ file: f, migration, detect, sql });
}

// ── compare ─────────────────────────────────────────────────────────────────
const client = new pg.Client({ connectionString: DB, ssl: false, ...(APPLY ? {} : { options: '-c default_transaction_read_only=on' }) });
await client.connect();
async function observe() {
  const q = async (sql: string) => (await client.query(sql)).rows as Record<string, string>[];
  const tables = new Set((await q("SELECT c.relname AS k FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")).map(r => r.k));
  const cols = new Set((await q("SELECT a.attrelid::regclass::text||'.'||a.attname AS k FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p')")).map(r => r.k.replace(/^public\./, '').replace(/"/g, '')));
  const fns = new Map<string, string[]>();
  for (const r of await q("SELECT p.proname AS k, p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")) (fns.get(r.k) ?? fns.set(r.k, []).get(r.k)!).push(r.src);
  const trgs = new Set((await q("SELECT c.relname||'.'||t.tgname AS k FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal")).map(r => r.k));
  const has = (key: string) => { const [kind, k] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    return kind === 'table' ? tables.has(k) : kind === 'col' ? cols.has(k) : kind === 'fn' ? fns.has(k) : trgs.has(k); };
  const missing: string[] = [], bodyDiff: string[] = [], ahead: string[] = [], aheadFiles = new Set<string>();
  for (const [k, o] of expected.tables) if (recent(o) && !tables.has(k)) missing.push(`table ${k} (${o.file})`);
  for (const [k, o] of expected.cols) if (recent(o) && expected.tables.has(k.split('.')[0]!) && !cols.has(k)) missing.push(`column ${k} (${o.file})`);
  for (const [k, o] of expected.trgs) if (recent(o) && !trgs.has(k)) missing.push(`trigger ${k} (${o.file})`);
  for (const [k, o] of expected.fns) if (recent(o) && o.body != null) {
    const got = fns.get(k);
    if (!got) missing.push(`function ${k} (${o.file})`); else if (!got.includes(o.body)) bodyDiff.push(k);
  }
  for (const [key, files] of aheadObjects) if (has(key)) { ahead.push(`${key} (${[...files].join(', ')})`); for (const f of files) aheadFiles.add(f); }
  const detected: string[] = [];
  for (const r of reverts) if ((await client.query(r.detect)).rows[0] && Object.values((await client.query(r.detect)).rows[0])[0] === true) detected.push(r.migration);
  return { missing, bodyDiff, ahead, aheadFiles, detected };
}
const report = (label: string, o: Awaited<ReturnType<typeof observe>>) => {
  console.log(`== ${label}: commit ${SHA.slice(0, 9)}, ${commitFiles.length} migrations (last ${commitFiles.at(-1)}), floor ${FLOOR}`);
  console.log(`   ahead migrations detected: ${JSON.stringify([...new Set([...o.aheadFiles, ...o.detected])].sort(byApplyOrder))}`);
  for (const [t, xs] of [['ahead object present', o.ahead], ['missing', o.missing], ['function body differs from commit', o.bodyDiff]] as const)
    for (const x of xs) console.log(`   ${t}: ${x}`);
};

const before = await observe();
report(APPLY ? 'before' : 'check (read-only)', before);
const needed = [...new Set([...before.aheadFiles, ...before.detected])].sort(byApplyOrder).reverse(); // newest first
const uncovered = needed.filter(n => !reverts.some(r => r.migration === n));
if (uncovered.length) { console.error(`REFUSED: no revert file for ahead migration(s): ${uncovered.join(', ')}`); await client.end(); process.exit(2); }
if (APPLY && (needed.length || before.bodyDiff.length)) {
  await client.query('BEGIN');
  try {
    for (const n of needed) { const r = reverts.find(x => x.migration === n)!; console.log(`   reverting ${n} via ${r.file}`); await client.query(r.sql); }
    const mid = await observe();
    for (const name of mid.bodyDiff) {
      const o = expected.fns.get(name)!, text = commitText.get(o.file)!, st = strip(text);
      const extra = [...st.matchAll(new RegExp(`\\b(?:alter\\s+function|revoke\\s[^;]*?\\son\\s+function|grant\\s[^;]*?\\son\\s+function)\\s+(?:public\\.)?"?${name}"?\\b[^;]*;`, 'gi'))].map(m => text.slice(m.index!, m.index! + m[0].length));
      // CREATE OR REPLACE resets a function's SET clauses (proconfig). Later migrations may have added some through
      // ALTER FUNCTION (690: lock_timeout), so keep the ones the source schema carries beyond the definition's own.
      const before = (await client.query('SELECT oid::regprocedure::text AS sig, proconfig FROM pg_proc WHERE pronamespace=\'public\'::regnamespace AND proname=$1', [name])).rows as { sig: string; proconfig: string[] | null }[];
      console.log(`   restoring function ${name} from ${o.file} (+${extra.length} owner/privilege statements; preserving SET ${JSON.stringify(before.map(r => r.proconfig ?? []))})`);
      await client.query(o.stmt!.replace(/^create\s+function/i, 'CREATE OR REPLACE FUNCTION'));
      for (const x of extra) await client.query(x);
      for (const r of before) for (const cfg of r.proconfig ?? []) {
        const eq = cfg.indexOf('='), key = cfg.slice(0, eq), val = cfg.slice(eq + 1);
        if (!/^[a-z_.]+$/.test(key)) throw new Error(`unexpected proconfig key ${key}`);
        await client.query(`ALTER FUNCTION ${r.sig} SET ${key} = $1`.replace('$1', `'${val.replace(/'/g, "''")}'`));
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); console.error('REFUSED: apply failed and was rolled back:', (e as Error).message); await client.end(); process.exit(2); }
}
const after = APPLY ? await observe() : before;
if (APPLY) report('after', after);
// Privilege/config-only migrations (e.g. 690) leave no object; surface the lock_timeout holders so the log shows them.
const holders = (await client.query("SELECT oid::regprocedure::text AS sig, proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'lock_timeout=%') ORDER BY 1")).rows as { sig: string; proconfig: string[] }[];
console.log(`   functions with lock_timeout SET (690): ${holders.map(h => `${h.sig}[${h.proconfig.find(c => c.startsWith('lock_timeout'))}]`).join(', ') || 'none'}`);
await client.end();
const clean = !after.missing.length && !after.bodyDiff.length && !after.ahead.length && !after.detected.length;
console.log(clean ? `MATCH: schema matches ${SHA.slice(0, 9)}` : `MISMATCH: schema does not match ${SHA.slice(0, 9)}`);
console.log('   limitation: privilege-only changes are verified only through revert detect queries.');
process.exit(clean ? 0 : 1);
