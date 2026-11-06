/**
 * The env a Next dev server sees (master plan wave 4, MW): tests/e2e/rubric/_rubricServerEnv.ts. Adapted from the
 * security review's attack test (PR #1209): the guard used to read `.env.local` alone, while Next dev gives the process
 * env first, then `.env.development.local`, then `.env.local`. These run @next/env itself, in a child process whose env
 * is the server's /proc environ, so the guard judges what the server judges.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertDevDatabases } from '../../e2e/rubric/_rubricDatabaseGuard';
import { nextEnvModule, serverDatabaseEnv } from '../../e2e/rubric/_rubricServerEnv';

const DEV = 'postgresql://u@100.96.203.105:7772/isaflow_dev';
const PROD = 'postgresql://u@100.96.203.105:7772/isaflow';
const NEXT_ENV = nextEnvModule(process.cwd());

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rubric-env-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
const seen = (files: Record<string, string>, environ: Record<string, string> = {}) =>
  serverDatabaseEnv(tree(files), environ, NEXT_ENV);

describe('Next dev precedence', () => {
  it('.env.development.local beats .env.local', () => {
    const env = seen({ '.env.local': `DATABASE_URL=${DEV}\n`, '.env.development.local': `DATABASE_URL=${PROD}\n` });
    expect(env.DATABASE_URL).toBe(PROD);
    expect(() => assertDevDatabases(env)).toThrow(/DATABASE_URL: .*not isaflow_dev/);
  });

  it('the process env beats every file', () => {
    const env = seen({ '.env.local': `DATABASE_URL=${DEV}\n` }, { DATABASE_URL: PROD });
    expect(env.DATABASE_URL).toBe(PROD);
  });

  it('reads .env.local under a test-mode NODE_ENV in the harness (the server is dev)', () => {
    expect(seen({ '.env.local': `DATABASE_URL=${DEV}\n` }).DATABASE_URL).toBe(DEV);
  });

  it('sees a SERVICE_DATABASE_URL the app prefers over DATABASE_URL', () => {
    const env = seen({ '.env.local': `DATABASE_URL=${DEV}\n`, '.env.development.local': `SERVICE_DATABASE_URL=${PROD}\n` });
    expect(() => assertDevDatabases(env)).toThrow(/SERVICE_DATABASE_URL: .*not isaflow_dev/);
  });

  it('reads the env of a forked server (next-server is forked: its environ carries an IPC channel fd)', () => {
    expect(seen({ '.env.local': `DATABASE_URL=${DEV}\n` }, { NODE_CHANNEL_FD: '3', NODE_CHANNEL_SERIALIZATION_MODE: 'json' }).DATABASE_URL)
      .toBe(DEV);
  });

  it('returns only the *DATABASE_URL keys', () => {
    expect(Object.keys(seen({ '.env.local': `DATABASE_URL=${DEV}\nSMTP_PASS=secret\n` }, { HOME: '/x' }))).toEqual(['DATABASE_URL']);
  });
});

describe('dotenv parsing, as Next does it (parseEnvFile used to diverge)', () => {
  it.each([
    ['last duplicate wins', `DATABASE_URL=${DEV}\nDATABASE_URL=${PROD}\n`],
    ['quoted value with a trailing comment', `DATABASE_URL='${PROD}' # ${DEV}'\n`],
    ['colon separator', `DATABASE_URL: ${PROD}\n`],
    ['expansion', `DATABASE_URL=\${OTHER}\nOTHER=${PROD}\n`],
  ])('%s: refused', (_, text) => {
    const env = seen({ '.env.local': text });
    expect(env.DATABASE_URL).toBe(PROD);
    expect(() => assertDevDatabases(env)).toThrow(/not isaflow_dev/);
  });

  it('CRLF: accepted as the dev URL it is', () => {
    expect(seen({ '.env.local': `DATABASE_URL=${DEV}\r\n` }).DATABASE_URL).toBe(DEV);
  });
});
