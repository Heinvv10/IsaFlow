/** Sage MCP config: env file parsing, required keys, refusal of a world-readable file. */
import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromValues, loadConfig, parseEnvFile, SageConfigError, DEFAULT_BASE_URL } from '../../../packages/sage-readonly-mcp/src/config';

const FULL = ['SAGE_USERNAME=u@x.test', 'SAGE_PASSWORD="p w"', '# c', 'SAGE_API_KEY=k', 'SAGE_COMPANY_ID=9', ''].join('\n');

function file(text: string, mode: number): string {
  const p = join(mkdtempSync(join(tmpdir(), 'sage-cfg-')), 'sage.env');
  writeFileSync(p, text);
  chmodSync(p, mode);
  return p;
}

describe('sage env config', () => {
  it('parses KEY=VALUE with comments and quotes', () => {
    expect(parseEnvFile(FULL)).toEqual({ SAGE_USERNAME: 'u@x.test', SAGE_PASSWORD: 'p w', SAGE_API_KEY: 'k', SAGE_COMPANY_ID: '9' });
  });

  it('loads a 600 file and defaults the base url', () => {
    const c = loadConfig(file(FULL, 0o600));
    expect(c).toMatchObject({ username: 'u@x.test', password: 'p w', apiKey: 'k', companyId: '9', baseUrl: DEFAULT_BASE_URL });
  });

  it('refuses a file other users can read, without reading its values into the message', () => {
    const p = file(FULL, 0o644);
    expect(() => loadConfig(p)).toThrow(/readable by other users; run: chmod 600/);
  });

  it('names the missing keys, never the present values', () => {
    try {
      configFromValues({ SAGE_USERNAME: 'u', SAGE_PASSWORD: 'topsecret' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SageConfigError);
      expect((err as Error).message).toContain('SAGE_API_KEY, SAGE_COMPANY_ID');
      expect((err as Error).message).not.toContain('topsecret');
    }
  });

  it('refuses a non-https base url', () => {
    expect(() => configFromValues({ SAGE_USERNAME: 'u', SAGE_PASSWORD: 'p', SAGE_API_KEY: 'k', SAGE_COMPANY_ID: '1', SAGE_BASE_URL: 'http://x' }))
      .toThrow(/https/);
  });

  it('reports a missing file with the template to copy', () => {
    expect(() => loadConfig('/nonexistent/sage.env')).toThrow(/sage-env.template/);
  });
});
