// The provisioner's safety rails: it may only ever be pointed at isaflow_dev, the slots are numbered the way ci.yml
// numbers its runners, and it adds keys to the shared env file without touching anything else in it.
import { describe, expect, it } from 'vitest';
import {
  GOLDEN_SLOTS, SOURCE_COMPANY_ID, assertDevDatabaseUrl, parseEnvFile, slotCompanyId, slotEnvKeys, upsertEnvKeys,
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

  it('use the key names ci.yml reads', () => {
    expect(slotEnvKeys(2)).toEqual({ companyId: 'GOLDEN_SLOT_2_COMPANY_ID', email: 'GOLDEN_SLOT_2_EMAIL', password: 'GOLDEN_SLOT_2_PASSWORD' });
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
