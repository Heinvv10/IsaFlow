// The provisioner's safety rails: it may only ever be pointed at isaflow_dev, the slots are numbered the way ci.yml
// numbers its runners, and it adds keys to the shared env file without touching anything else in it.
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_GOTRUE_URL, GOLDEN_SLOTS, MAX_SLOT_GENERATION, SOURCE_COMPANY_ID, assertDevDatabaseUrl, assertConnectedToDev, assertFreshSlotSeeds, assertGoTrueUrl, assertResetSeeds, assertSlotCompanyId, generationOf,
  parseEnvFile, slotCompanyId, slotCompanyName, slotEnvKeys, upsertEnvKeys,
} from '../../../scripts/ci/golden/slotConfig';

describe('assertDevDatabaseUrl', () => {
  const dev = 'postgresql://u:p@100.96.203.105:7772/isaflow_dev?sslmode=disable';

  it('accepts isaflow_dev', () => {
    expect(() => assertDevDatabaseUrl(dev)).not.toThrow();
    expect(() => assertDevDatabaseUrl('postgresql://u:p@localhost/isaflow_dev')).not.toThrow();
  });

  it.each([
    ['production, which shares the dev host and port', 'postgresql://u:p@100.96.203.105:7772/isaflow?sslmode=disable'],
    ['a name that merely starts with isaflow_dev', 'postgresql://u:p@h:7772/isaflow_dev_copy'],
    ['isaflow_dev only in the query string', 'postgresql://u:p@h:7772/isaflow?options=isaflow_dev'],
    ['isaflow_dev as the user name', 'postgresql://isaflow_dev:p@h:7772/isaflow'],
    ['no database name', 'postgresql://u:p@h:7772'],
    ['a url that does not parse', 'not a url'],
    ['an empty url', ''],
    ['a database named in the query string over the path (a driver may honour it)', 'postgresql://u:p@h:7772/isaflow_dev?database=isaflow'],
    ['dbname in the query string', 'postgresql://u:p@h:7772/isaflow_dev?dbname=isaflow'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertDevDatabaseUrl(url)).toThrow(/isaflow_dev/);
  });

  it('never prints the credentials it refuses', () => {
    let message = '';
    try { assertDevDatabaseUrl('postgresql://someuser:s3cretpw@h:7772/isaflow'); } catch (e) { message = (e as Error).message; }
    expect(message).not.toContain('s3cretpw');
    expect(message).not.toContain('someuser');
  });

  it('allows another database only when the caller names it (the disposable fixture in tests)', () => {
    expect(() => assertDevDatabaseUrl('postgresql://u:p@h/isaflow_schema_fixture', 'isaflow_schema_fixture')).not.toThrow();
    expect(() => assertDevDatabaseUrl(dev, 'isaflow_schema_fixture')).toThrow();
  });
});

describe('slots', () => {
  it('are three, with deterministic version-4 ids that are not the demo company', () => {
    expect(GOLDEN_SLOTS).toEqual([1, 2, 3]);
    const ids = GOLDEN_SLOTS.map(slotCompanyId);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(id).not.toBe(SOURCE_COMPANY_ID);
    }
  });

  it('a reset starts the next generation under a new id, and the generation can be read back from the id', () => {
    const ids = [0, 1, MAX_SLOT_GENERATION].map((g) => slotCompanyId(2, g));
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([0, 1, 9].map((g) => generationOf(slotCompanyId(3, g)))).toEqual([0, 1, 9]);
    expect(generationOf(SOURCE_COMPANY_ID)).toBe(0);
    expect(generationOf('not an id')).toBe(0);
  });

  it('are named no longer than the Demo company, whose 22 characters are what the shell header is sized for', () => {
    const names = GOLDEN_SLOTS.flatMap((n) => Array.from({ length: MAX_SLOT_GENERATION + 1 }, (_, g) => slotCompanyName(n, g)));
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.length).toBeLessThanOrEqual('ISAFlow Demo (Pty) Ltd'.length);
  });

  it('use the key names ci.yml reads', () => {
    expect(slotEnvKeys(2)).toEqual({ companyId: 'GOLDEN_SLOT_2_COMPANY_ID', email: 'GOLDEN_SLOT_2_EMAIL', password: 'GOLDEN_SLOT_2_PASSWORD' });
  });
});

describe('assertSlotCompanyId', () => {
  it('accepts every generation of the slot\'s own id', () => {
    for (let g = 0; g <= MAX_SLOT_GENERATION; g++) expect(() => assertSlotCompanyId(2, slotCompanyId(2, g))).not.toThrow();
  });

  it.each([
    ['Demo', SOURCE_COMPANY_ID],
    ['a real dev tenant', 'd27bac33-1111-4222-8333-444455556666'],
    ['another slot\'s company', slotCompanyId(1, 0)],
    ['a generation past the limit', '601d00a0-0000-4000-8000-000000000002'],
    ['empty', ''],
  ])('refuses %s', (_label, id) => {
    expect(() => assertSlotCompanyId(2, id)).toThrow(/refusing company id/);
  });
});

describe('assertConnectedToDev', () => {
  const answering = (db: string | undefined) => ({ query: async () => ({ rows: db === undefined ? [] : [{ db }] }) });

  it('returns the name when the server says it is isaflow_dev', async () => {
    await expect(assertConnectedToDev(answering('isaflow_dev'))).resolves.toBe('isaflow_dev');
  });

  it.each(['isaflow', 'postgres', 'isaflow_dev_2', undefined])('refuses a server that says %s, before any write', async (name) => {
    await expect(assertConnectedToDev(answering(name))).rejects.toThrow(/not isaflow_dev/);
  });
});

describe('assertResetSeeds', () => {
  it('refuses a reset without a seed url: a bare clone fails the volume specs', () => {
    expect(() => assertResetSeeds(2, undefined, false)).toThrow(/--reset-slot 2 needs --seed-url/);
    expect(() => assertResetSeeds(1, '', false)).toThrow(/--seed-url/);
  });

  it('lets a reset with a seed url, a dry-run reset (it seeds nothing) and a run with no reset through', () => {
    expect(() => assertResetSeeds(2, 'http://localhost:3450', false)).not.toThrow();
    expect(() => assertResetSeeds(2, undefined, true)).not.toThrow();
    expect(() => assertResetSeeds(undefined, undefined, false)).not.toThrow();
  });
});

describe('assertFreshSlotSeeds', () => {
  it('refuses to activate a fresh slot without seed data', () => {
    expect(() => assertFreshSlotSeeds(3, true, undefined, false)).toThrow(/new slot 3 needs --seed-url/);
  });

  it('allows seeded, existing, and rolled-back dry-run slots', () => {
    expect(() => assertFreshSlotSeeds(3, true, 'http://localhost:3450', false)).not.toThrow();
    expect(() => assertFreshSlotSeeds(3, false, undefined, false)).not.toThrow();
    expect(() => assertFreshSlotSeeds(3, true, undefined, true)).not.toThrow();
  });
});

describe('assertGoTrueUrl', () => {
  it('accepts the pinned instance, with or without a trailing slash', () => {
    expect(() => assertGoTrueUrl(EXPECTED_GOTRUE_URL)).not.toThrow();
    expect(() => assertGoTrueUrl(`${EXPECTED_GOTRUE_URL}/`)).not.toThrow();
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['another host', 'http://10.0.0.5:7770/auth/v1'],
    ['another port (another stack)', 'http://100.96.203.105:7771/auth/v1'],
    ['a url that merely starts with it', `${EXPECTED_GOTRUE_URL}.evil.test`],
  ])('refuses %s', (_label, url) => {
    expect(() => assertGoTrueUrl(url)).toThrow(/GOTRUE_URL/);
  });
});

describe('env file', () => {
  const file = 'A=1\nSMTP_FROM=ISAFlow <no-reply@x.test>\n\nB="two words"\n';

  it('parses KEY=value lines and ignores comments and blanks', () => {
    expect(parseEnvFile(`# c\n${file}`)).toEqual({ A: '1', SMTP_FROM: 'ISAFlow <no-reply@x.test>', B: '"two words"' });
  });

  it('adds new keys and keeps every existing line byte for byte', () => {
    const out = upsertEnvKeys(file, { GOLDEN_SLOT_1_EMAIL: 'e@x.test' });
    expect(out.startsWith(file)).toBe(true);
    expect(out.endsWith('GOLDEN_SLOT_1_EMAIL=e@x.test\n')).toBe(true);
  });

  it('replaces a key in place instead of duplicating it', () => {
    const once = upsertEnvKeys(file, { A: '9' });
    expect(once).toBe('A=9\nSMTP_FROM=ISAFlow <no-reply@x.test>\n\nB="two words"\n');
    expect(upsertEnvKeys(once, { A: '9' })).toBe(once);
  });

  it('does not match a key that only starts with the same letters', () => {
    expect(upsertEnvKeys('GOLDEN_SLOT_1_EMAIL_OLD=x\n', { GOLDEN_SLOT_1_EMAIL: 'y' })).toBe('GOLDEN_SLOT_1_EMAIL_OLD=x\nGOLDEN_SLOT_1_EMAIL=y\n');
  });

  it('adds the missing newline before appending to a file without a trailing one', () => {
    expect(upsertEnvKeys('A=1', { B: '2' })).toBe('A=1\nB=2\n');
  });

  it('refuses a value that would break the line', () => {
    expect(() => upsertEnvKeys('A=1\n', { B: 'x\nC=evil' })).toThrow(/newline/);
  });
});
