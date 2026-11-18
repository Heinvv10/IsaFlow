// migrate-slot-emails.ts end to end against fakes: arguments, env-file discovery and rewriting, per-account progress, refusals.
import { appendFileSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertTempUnderTest, rewriteEnvFiles } from '../../../scripts/ci/golden/slotEmailEnv';
import { knownAccounts, parseMigrationArgs } from '../../../scripts/ci/golden/slotEmailPlan';
import { homedir } from 'node:os';
import { main, resolveDefaults, type Io, type ResolvedArgs } from '../../../scripts/ci/golden/migrate-slot-emails';
import { EXPECTED_GOTRUE_URL } from '../../../scripts/ci/golden/slotConfig';
import { fakes, newWorld, type World } from '../../helpers/slotEmailWorld';

const KEY_MARKER = 'service-key-value-9f3a';
const OLD1 = 'golden-slot-1@isaflow.dev';
const NEW1 = 'golden-slot-1@isaflow.co.za';

describe('migrate-slot-emails main', () => {
  let dir: string; let outside: string; let ciEnv: string; let deployEnv: string; let secrets: string; let ws: string; let w: World; let said: string[]; let connected: string[];
  const f = (...p: string[]): string => join(dir, ...p);
  const put = (path: string, text: string, mode = 0o600): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text, { mode }); };
  const ciText = (over: Record<string, string> = {}): string => Object.entries({
    DATABASE_URL: 'postgresql://u@h:7772/isaflow_dev', GOTRUE_URL: EXPECTED_GOTRUE_URL, SUPABASE_SERVICE_ROLE_KEY: KEY_MARKER,
    GOLDEN_SLOT_1_EMAIL: OLD1, GOLDEN_SLOT_2_EMAIL: 'golden-slot-2@isaflow.dev', GOLDEN_SLOT_1_PASSWORD: 'pw1', ...over,
  }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  const mkIo = (world: World, wrap?: (gt: ReturnType<typeof fakes>['gt']) => ReturnType<typeof fakes>['gt']): Io => {
    const x = fakes(world);
    return { processEnv: {}, say: (l) => said.push(l), connect: async (u) => { connected.push(u); return x.db; }, useGoTrue: () => (wrap ? wrap(x.gt) : x.gt) };
  };
  /** Every path is passed explicitly and is a temp path; main() takes no default of its own. */
  const baseArgs = (): ResolvedArgs => ({ apply: false, allowUnrecognised: [], envFile: ciEnv, deployEnvFile: deployEnv, secretsDir: secrets, workspaceRoot: ws, allowedRoot: dir });
  const baseFlags = (): string[] => ['--env-file', ciEnv, '--deploy-env-file', deployEnv, '--secrets-dir', secrets, '--workspace-root', ws, '--allowed-root', dir];
  const run = (extra: string[] = [], world = w, io = mkIo(world)) => main({ ...baseArgs(), ...parseMigrationArgs([...baseFlags(), ...extra]) } as ResolvedArgs, io);
  const read = (p: string): string => readFileSync(p, 'utf8');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slot-email-')); outside = mkdtempSync(join(tmpdir(), 'slot-email-outside-')); ciEnv = f('ci.env'); deployEnv = f('deploy.env'); secrets = f('secrets'); ws = f('ws'); w = newWorld(); said = []; connected = [];
    put(ciEnv, ciText());
    put(deployEnv, 'E2E_ADMIN_EMAIL=reporting-qa@isaflow.dev\nE2E_APPROVER_EMAIL=reporting-qa-approver@isaflow.dev\n');
    put(f('secrets', 'isaflow-dev-golden-qa.env'), 'GOLDEN_QA_W6_EMAIL=golden-qa-w6@isaflow.dev\nGOLDEN_QA_W6_PASSWORD=w6pw\n');
    put(f('secrets', 'isaflow-reporting-qa.env'), 'E2E_ADMIN_EMAIL=reporting-qa@isaflow.dev\n');
    put(f('secrets', 'notes.txt'), `GOLDEN_SLOT_1_EMAIL=${OLD1}\n`);
    mkdirSync(f('ws', 'IsaFlow'), { recursive: true });
    symlinkSync(ciEnv, f('ws', 'IsaFlow', '.env.local'));
    put(f('ws', 'IsaFlow-a', '.env.local'), `export GOLDEN_SLOT_1_EMAIL="${OLD1}"\r\nGOLDEN_SLOT_2_EMAIL='golden-slot-2@isaflow.dev'\r\n`);
    put(f('ws', 'IsaFlow_wt', 'b', '.env.local'), `GOLDEN_SLOT_3_EMAIL=golden-slot-3@isaflow.dev\n`);
    put(f('ws', 'IsaFlow_wt', 'b', 'sub', '.env.local'), `GOLDEN_SLOT_1_EMAIL=${OLD1}\n`);
    put(f('ws', 'Other', '.env.local'), `GOLDEN_SLOT_1_EMAIL=${OLD1}\n`);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

  const untouched = (): void => {
    expect(w.log).toEqual(['end']);
    expect(w.gotrue.get('g1')).toBe(OLD1);
    expect(read(ciEnv)).toContain(`GOLDEN_SLOT_1_EMAIL=${OLD1}\n`);
    expect(read(f('ws', 'IsaFlow-a', '.env.local'))).toContain(OLD1);
    expect(read(f('secrets', 'isaflow-reporting-qa.env'))).toContain('reporting-qa@isaflow.dev');
  };

  describe('arguments', () => {
    it.each([
      ['a misspelt flag', ['--dryrun']],
      ['a stray word', ['apply']],
      ['--apply with --dry-run', ['--apply', '--dry-run']],
      ['a flag given twice', ['--apply', '--apply']],
      ['--allow-unrecognised without --apply', ['--allow-unrecognised', '/x']],
    ])('refuses %s, before connecting or writing anything', async (_l, extra) => {
      await expect(async () => run(extra)).rejects.toThrow(/argument|--/);
      expect(connected).toEqual([]);
      expect(w.log).toEqual([]);
      expect(read(ciEnv)).toContain(`GOLDEN_SLOT_1_EMAIL=${OLD1}\n`);
    });

    it.each<[string, string[]]>([
      ['--secrets-dir with no value', ['--secrets-dir']],
      ['--env-file with no value', ['--env-file']],
      ['--deploy-env-file with no value', ['--deploy-env-file']],
      ['--workspace-root with no value', ['--workspace-root']],
      ['--allowed-root with no value', ['--allowed-root']],
      ['--allow-unrecognised with no value', ['--apply', '--allow-unrecognised']],
      ['a value flag followed by another flag', ['--workspace-root', '--apply']],
    ])('the parser refuses %s', (_l, argv) => {
      expect(() => parseMigrationArgs(argv)).toThrow(/needs a value/);
    });

    it('main() has no defaults: a call missing any path option is refused before it reads or connects', async () => {
      for (const key of ['envFile', 'deployEnvFile', 'secretsDir', 'workspaceRoot', 'allowedRoot'] as const) {
        await expect(main({ ...baseArgs(), [key]: undefined } as unknown as ResolvedArgs, mkIo(w))).rejects.toThrow(new RegExp(`missing: ${key}$`));
      }
      await expect(main({ apply: false, allowUnrecognised: [] } as unknown as ResolvedArgs, mkIo(w))).rejects.toThrow(/requires/);
      expect(connected).toEqual([]);
      expect(w.log).toEqual([]);
    });

    it('the real default paths live in resolveDefaults (the CLI block), and an explicit option wins', () => {
      expect(resolveDefaults(parseMigrationArgs([]))).toEqual({
        apply: false, allowUnrecognised: [], envFile: '/home/hein/isaflow-ci.env', deployEnvFile: '/home/hein/isaflow-deploy.env',
        secretsDir: join(homedir(), '.secrets'), workspaceRoot: '/home/hein/Workspace', allowedRoot: '/home/hein',
      });
      expect(resolveDefaults(parseMigrationArgs(['--env-file', '/x/a.env', '--allowed-root', '/x']))).toMatchObject({ envFile: '/x/a.env', allowedRoot: '/x', deployEnvFile: '/home/hein/isaflow-deploy.env' });
    });

    it('with no arguments is a dry run: prints the plan and the env files, writes nothing', async () => {
      expect(await run()).toBe(0);
      untouched();
      const out = said.join('\n');
      expect(out).toContain(`slot 1: ${OLD1} -> ${NEW1}`);
      expect(out).toContain('dry run');
      expect(out).toContain('--apply');
      expect(out).toContain(`${f('ws', 'IsaFlow-a', '.env.local')}: would rewrite GOLDEN_SLOT_1_EMAIL, GOLDEN_SLOT_2_EMAIL`);
      expect(out).toContain(`${f('secrets', 'isaflow-reporting-qa.env')}: would rewrite E2E_ADMIN_EMAIL`);
      expect(out).toContain(`${f('ws', 'IsaFlow_wt', 'b', '.env.local')}: would rewrite GOLDEN_SLOT_3_EMAIL`);
      expect(out).toContain('env files checked: 6'); // the CI file, the deploy file, two secrets files, one checkout, one worktree: the symlinked copy is the CI file
      expect(out).toContain(`${deployEnv}: would rewrite E2E_ADMIN_EMAIL, E2E_APPROVER_EMAIL`);
      expect(out.split(`${ciEnv}: would rewrite`).length - 1).toBe(1);
      expect(out).not.toContain(f('ws', 'Other'));
      expect(out).not.toContain(f('ws', 'IsaFlow_wt', 'b', 'sub'));
      expect(out).not.toContain(f('secrets', 'notes.txt'));
      expect(out).toContain('UNKNOWN GoTrue account on the old domain, untouched: stranger@isaflow.dev');
      expect(out).not.toContain(KEY_MARKER);
      expect(out).not.toContain('pw1');
    });

    it('--dry-run is the same as no argument', async () => {
      expect(parseMigrationArgs(['--dry-run']).apply).toBe(false);
      expect(await run(['--dry-run'])).toBe(0);
      untouched();
    });

    it('always says, in words, that production users rows are not touched', async () => {
      await run();
      expect(said.join('\n')).toMatch(/production `users` rows for these GoTrue ids, if any, keep the old address \(not touched/);
    });
  });

  describe('--apply', () => {
    it('migrates every account and rewrites every discovered file once (symlinks followed, mode kept, values never printed)', async () => {
      expect(await run(['--apply'])).toBe(0);
      expect(w.gotrue.get('g1')).toBe(NEW1);
      expect(w.gotrue.get('gx')).toBe('stranger@isaflow.dev');
      expect(w.users.get('ux')).toBe('orphan@isaflow.dev');
      expect(read(ciEnv)).toContain(`GOLDEN_SLOT_1_EMAIL=${NEW1}\n`);
      expect(read(ciEnv)).toContain('GOLDEN_SLOT_2_EMAIL=golden-slot-2@isaflow.co.za\n');
      expect(read(ciEnv)).toContain(`SUPABASE_SERVICE_ROLE_KEY=${KEY_MARKER}\n`);
      expect(lstatSync(f('ws', 'IsaFlow', '.env.local')).isSymbolicLink()).toBe(true);
      expect(read(f('ws', 'IsaFlow-a', '.env.local'))).toBe('export GOLDEN_SLOT_1_EMAIL="golden-slot-1@isaflow.co.za"\r\nGOLDEN_SLOT_2_EMAIL=\'golden-slot-2@isaflow.co.za\'\r\n');
      expect(read(f('secrets', 'isaflow-dev-golden-qa.env'))).toBe('GOLDEN_QA_W6_EMAIL=golden-qa-w6@isaflow.co.za\nGOLDEN_QA_W6_PASSWORD=w6pw\n');
      expect(read(f('secrets', 'isaflow-reporting-qa.env'))).toBe('E2E_ADMIN_EMAIL=reporting-qa@isaflow.co.za\n');
      expect(read(deployEnv)).toBe('E2E_ADMIN_EMAIL=reporting-qa@isaflow.co.za\nE2E_APPROVER_EMAIL=reporting-qa-approver@isaflow.co.za\n');
      expect(read(f('ws', 'IsaFlow_wt', 'b', '.env.local'))).toBe('GOLDEN_SLOT_3_EMAIL=golden-slot-3@isaflow.co.za\n');
      // Not discovered: not *.env, not directly under a worktree, not an IsaFlow* directory.
      expect(read(f('ws', 'IsaFlow_wt', 'b', 'sub', '.env.local'))).toContain(OLD1);
      expect(read(f('ws', 'Other', '.env.local'))).toContain(OLD1);
      expect(read(f('secrets', 'notes.txt'))).toContain(OLD1);
      for (const p of [ciEnv, f('ws', 'IsaFlow-a', '.env.local'), f('secrets', 'isaflow-reporting-qa.env')]) expect(statSync(p).mode & 0o777).toBe(0o600);
      const out = said.join('\n');
      expect(out).toContain(`${f('secrets', 'isaflow-reporting-qa.env')}: rewrote E2E_ADMIN_EMAIL`);
      expect(out).not.toContain(KEY_MARKER);
      expect(out).not.toContain('pw1');
      expect(out).not.toContain('w6pw');
    });

    it('a second run changes nothing (idempotent)', async () => {
      await run(['--apply']);
      const snapshot = [ciEnv, f('ws', 'IsaFlow-a', '.env.local'), f('secrets', 'isaflow-reporting-qa.env')].map(read);
      const before = w.log.length;
      said = [];
      expect(await run(['--apply'])).toBe(0);
      expect(w.log.length).toBe(before + 1); // only the connection's end
      expect([ciEnv, f('ws', 'IsaFlow-a', '.env.local'), f('secrets', 'isaflow-reporting-qa.env')].map(read)).toEqual(snapshot);
    });

    it('rewrites each account\'s keys right after its commit: a third account failing leaves accounts 1 and 2 done', async () => {
      w.failGoTrueFor = 'gw';
      await expect(run(['--apply'])).rejects.toThrow(/gotrue down/);
      expect(w.gotrue.get('g1')).toBe(NEW1);
      expect(w.gotrue.get('gw')).toBe('golden-qa-w6@isaflow.dev');
      expect(read(ciEnv)).toContain(`GOLDEN_SLOT_1_EMAIL=${NEW1}\n`);
      expect(read(ciEnv)).toContain('GOLDEN_SLOT_2_EMAIL=golden-slot-2@isaflow.co.za\n');
      expect(read(f('secrets', 'isaflow-dev-golden-qa.env'))).toContain('GOLDEN_QA_W6_EMAIL=golden-qa-w6@isaflow.dev');
    });

    it('re-reads a file just before writing it, so a line a peer added meanwhile is kept', async () => {
      const peer = f('ws', 'IsaFlow-a', '.env.local');
      const io = mkIo(w, (gt) => ({ ...gt, setEmail: async (id, email) => { await gt.setEmail(id, email); if (id === 'g1') appendFileSync(peer, 'ADDED_BY_PEER=1\r\n'); } }));
      expect(await run(['--apply'], w, io)).toBe(0);
      const text = read(peer);
      expect(text).toContain('ADDED_BY_PEER=1');
      expect(text).toContain('GOLDEN_SLOT_1_EMAIL="golden-slot-1@isaflow.co.za"');
    });

    it('on a conflict writes nothing to the database or GoTrue, but still rewrites the keys of an account that is already migrated', async () => {
      w.gotrue.set('g1', NEW1); w.users.set('g1', NEW1);
      w.companies[0]!.email = NEW1;
      w.gotrue.set('gdup', 'golden-slot-2@isaflow.co.za');
      expect(await run(['--apply'])).toBe(1);
      expect(w.log).toEqual(['end']);
      expect(w.gotrue.get('g2')).toBe('golden-slot-2@isaflow.dev');
      expect(read(ciEnv)).toContain(`GOLDEN_SLOT_1_EMAIL=${NEW1}\n`);
      expect(read(ciEnv)).toContain('GOLDEN_SLOT_2_EMAIL=golden-slot-2@isaflow.dev\n');
      expect(said.join('\n')).toMatch(/REFUSED/);
    });

    it('a dry run with a conflict exits 1 and writes nothing', async () => {
      w.gotrue.set('gdup', 'golden-slot-2@isaflow.co.za');
      expect(await run()).toBe(1);
      untouched();
    });
  });

  describe('lines that still mention the old domain', () => {
    beforeEach(() => { put(f('ws', 'IsaFlow-a', '.env.local'), `GOLDEN_SLOT_1_EMAIL=${OLD1}\nSMTP_FROM=IsaFlow <noreply@isaflow.dev>\n# was stranger@isaflow.dev\n`); });

    it('are reported by key or line number (never value) in a dry run, with a note that --apply would refuse', async () => {
      expect(await run()).toBe(0);
      const out = said.join('\n');
      expect(out).toContain(`${f('ws', 'IsaFlow-a', '.env.local')}: still mentions the old domain, would not be rewritten: SMTP_FROM, line 3`);
      expect(out).toMatch(/--apply will refuse.*--allow-unrecognised/);
      expect(out).not.toContain('noreply');
      untouched();
    });

    it('make --apply refuse before any write unless --allow-unrecognised is given', async () => {
      expect(await run(['--apply'])).toBe(1);
      untouched();
      expect(said.join('\n')).toMatch(/REFUSED.*--allow-unrecognised/);
    });

    it('--allow-unrecognised <file> migrates the rest and leaves that file\'s lines as written', async () => {
      expect(await run(['--apply', '--allow-unrecognised', f('ws', 'IsaFlow-a', '.env.local')])).toBe(0);
      expect(w.gotrue.get('g1')).toBe(NEW1);
      expect(read(f('ws', 'IsaFlow-a', '.env.local'))).toBe(`GOLDEN_SLOT_1_EMAIL=${NEW1}\nSMTP_FROM=IsaFlow <noreply@isaflow.dev>\n# was stranger@isaflow.dev\n`);
    });

    it('--allow-unrecognised silences only the file it names: a second offending file still refuses', async () => {
      put(f('ws', 'IsaFlow_wt', 'b', '.env.local'), 'GOLDEN_SLOT_3_EMAIL=golden-slot-3@isaflow.dev\nOTHER=a <x@isaflow.dev>\n');
      expect(await run(['--apply', '--allow-unrecognised', f('ws', 'IsaFlow-a', '.env.local')])).toBe(1);
      untouched();
      expect(said.join('\n')).toContain(`${f('ws', 'IsaFlow_wt', 'b', '.env.local')}: still mentions`);
      said = []; w.log.length = 0;
      expect(await run(['--apply', '--allow-unrecognised', f('ws', 'IsaFlow-a', '.env.local'), '--allow-unrecognised', f('ws', 'IsaFlow_wt', 'b', '.env.local')])).toBe(0);
      expect(w.gotrue.get('g1')).toBe(NEW1);
    });

    it('--allow-unrecognised names a scanned file: any other path is refused before anything runs', async () => {
      await expect(run(['--apply', '--allow-unrecognised', f('ws', 'Other', '.env.local')])).rejects.toThrow(/not a scanned env file/);
      untouched();
    });

    it('an unreadable file counts as unrecognised (it may hold an old address)', async () => {
      if (process.getuid?.() === 0) return;
      put(f('ws', 'IsaFlow-a', '.env.local'), `GOLDEN_SLOT_1_EMAIL=${OLD1}\n`);
      chmodSync(f('ws', 'IsaFlow-a', '.env.local'), 0o000);
      expect(await run(['--apply'])).toBe(1);
      expect(said.join('\n')).toContain(`${f('ws', 'IsaFlow-a', '.env.local')}: cannot be read`);
      chmodSync(f('ws', 'IsaFlow-a', '.env.local'), 0o600);
      expect(w.gotrue.get('g1')).toBe(OLD1);
    });
  });

  describe('files outside the allowed root', () => {
    const target = (): string => join(outside, 'elsewhere.env');
    beforeEach(() => {
      put(target(), `GOLDEN_SLOT_1_EMAIL=${OLD1}\n`);
      mkdirSync(f('ws', 'IsaFlow-out'), { recursive: true });
      symlinkSync(target(), f('ws', 'IsaFlow-out', '.env.local'));
    });

    it('rewriteEnvFiles never writes through a symlink that resolves outside the root', () => {
      expect(rewriteEnvFiles([f('ws', 'IsaFlow-out', '.env.local')], knownAccounts(), dir)).toEqual([]);
      expect(read(target())).toBe(`GOLDEN_SLOT_1_EMAIL=${OLD1}\n`);
      expect(rewriteEnvFiles([f('ws', 'IsaFlow-a', '.env.local')], knownAccounts(), dir).length).toBe(1);
    });

    it('a sibling directory that merely starts with the root\'s name is outside it', () => {
      const evil = `${dir}-evil`;
      mkdirSync(evil);
      try {
        put(join(evil, 'x.env'), `GOLDEN_SLOT_1_EMAIL=${OLD1}\n`);
        expect(rewriteEnvFiles([join(evil, 'x.env')], knownAccounts(), dir)).toEqual([]);
        expect(read(join(evil, 'x.env'))).toBe(`GOLDEN_SLOT_1_EMAIL=${OLD1}\n`);
      } finally { rmSync(evil, { recursive: true, force: true }); }
    });

    it('a file outside the root that mentions no old address is skipped silently (noted), and does not block --apply', async () => {
      put(target(), 'UNRELATED=1\n');
      expect(await run()).toBe(0);
      const out = said.join('\n');
      expect(out).not.toContain(f('ws', 'IsaFlow-out', '.env.local'));
      expect(out).toMatch(/env files checked: 7 \(1 outside .*, skipped: no old address\)/);
      said = []; w.log.length = 0;
      expect(await run(['--apply'])).toBe(0);
      expect(w.gotrue.get('g1')).toBe(NEW1);
      expect(read(target())).toBe('UNRELATED=1\n');
    });

    it('a file outside the root that holds a lookalike or unknown old-domain line still blocks', async () => {
      put(target(), 'SMTP_FROM=x <a@isaflow.dev>\n');
      said = []; w.log.length = 0;
      expect(await run(['--apply'])).toBe(1);
      expect(said.join('\n')).toContain(`${f('ws', 'IsaFlow-out', '.env.local')}: resolves outside ${dir}, will not be written`);
      untouched();
    });

    it('is reported by path in a dry run, and --apply refuses before any write', async () => {
      expect(await run()).toBe(0);
      expect(said.join('\n')).toContain(`${f('ws', 'IsaFlow-out', '.env.local')}: resolves outside ${dir}, will not be written`);
      said = []; w.log.length = 0;
      expect(await run(['--apply'])).toBe(1);
      untouched();
      expect(read(target())).toBe(`GOLDEN_SLOT_1_EMAIL=${OLD1}\n`);
    });

    it('with --allow-unrecognised <that file> the rest migrates and the outside file is still not written', async () => {
      expect(await run(['--apply', '--allow-unrecognised', f('ws', 'IsaFlow-out', '.env.local')])).toBe(0);
      expect(w.gotrue.get('g1')).toBe(NEW1);
      expect(read(target())).toBe(`GOLDEN_SLOT_1_EMAIL=${OLD1}\n`);
    });
  });

  describe('the test-run guard (no test may touch a real env file)', () => {
    it.each<[string, Partial<ResolvedArgs>]>([
      ['an env file', { envFile: '/home/hein/isaflow-ci.env' }],
      ['a secrets dir', { secretsDir: '/home/hein/.secrets' }],
      ['a workspace root', { workspaceRoot: '/home/hein/Workspace' }],
      ['a deploy env file', { deployEnvFile: '/home/hein/isaflow-deploy.env' }],
    ])('main refuses %s outside the temp dir before reading or connecting (dry run: a removed guard would only read)', async (_l, over) => {
      await expect(main({ ...baseArgs(), ...over }, mkIo(w))).rejects.toThrow(/refusing under vitest/);
      expect(connected).toEqual([]);
    });

    it('rewriteEnvFiles refuses a path outside the temp dir, even one that does not exist', () => {
      expect(() => rewriteEnvFiles(['/home/hein/.no-such-dir/x.env'], knownAccounts(), '/home/hein')).toThrow(/refusing under vitest/);
    });

    it('assertTempUnderTest: temp paths and a missing temp path pass, the real home and a symlink out of temp refuse, and it is inert outside a test run', () => {
      expect(() => assertTempUnderTest([ciEnv, f('not-yet')], true)).not.toThrow();
      expect(() => assertTempUnderTest(['/home/hein/isaflow-ci.env'], true)).toThrow(/outside/);
      expect(() => assertTempUnderTest(['/tmp-evil/x'], true)).toThrow(/outside/);
      expect(() => assertTempUnderTest(['/home/hein/isaflow-ci.env'], false)).not.toThrow();
      mkdirSync(f('ws', 'lnk'), { recursive: true });
      symlinkSync('/home', f('ws', 'lnk', 'home'));
      expect(() => assertTempUnderTest([f('ws', 'lnk', 'home')], true)).toThrow(/outside/);
    });
  });

  describe('guards', () => {
    it.each([
      ['production on the same host (url path)', { DATABASE_URL: 'postgresql://u@h:7772/isaflow' }, /isaflow_dev/],
      ['a database named in the query string', { DATABASE_URL: 'postgresql://u@h:7772/isaflow_dev?dbname=isaflow' }, /query string/],
      ['another GoTrue instance', { GOTRUE_URL: 'http://127.0.0.1:9999/auth/v1' }, /GOTRUE_URL/],
    ])('refuses %s before connecting (dry run and --apply)', async (_l, env, re) => {
      put(ciEnv, ciText(env));
      await expect(run()).rejects.toThrow(re);
      await expect(run(['--apply'])).rejects.toThrow(re);
      expect(connected).toEqual([]);
      expect(w.log).toEqual([]);
    });

    it('refuses when the server says it is not isaflow_dev, before any write (the real guard)', async () => {
      w.dbName = 'isaflow';
      await expect(run(['--apply'])).rejects.toThrow(/not isaflow_dev/);
      untouched();
    });

    it('refuses without the GoTrue service key', async () => {
      put(ciEnv, ciText({ SUPABASE_SERVICE_ROLE_KEY: '' }));
      await expect(run()).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    });
  });
});
