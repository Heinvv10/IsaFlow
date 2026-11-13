/**
 * Sage read-only MCP — configuration from a LOCAL env file, never from tool input.
 *
 * The credentials belong to a dedicated Sage integration user. They live in one file on the
 * machine running the server (default ~/.config/isaflow-sage-mcp/sage.env, override with
 * SAGE_MCP_ENV_FILE) and are read once at start. A file other users can read is refused: the
 * password is the one secret this server holds. Error messages name the missing KEYS, never values.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SageConfig {
  baseUrl: string;
  username: string;
  password: string;
  apiKey: string;
  companyId: string;
  /** Where sage_download_attachment writes files. */
  downloadDir: string;
  /** Rolling-hour ledger of failed logins (see lockout.ts). */
  stateDir: string;
}

export const DEFAULT_BASE_URL = 'https://accounting.sageone.co.za/api/2.0.0';
const REQUIRED = ['SAGE_USERNAME', 'SAGE_PASSWORD', 'SAGE_API_KEY', 'SAGE_COMPANY_ID'] as const;

export class SageConfigError extends Error {}

export function defaultConfigDir(): string {
  return join(homedir(), '.config', 'isaflow-sage-mcp');
}

/** KEY=VALUE lines; '#' comments and blank lines ignored; optional surrounding quotes stripped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function configFromValues(values: Record<string, string>, dir = defaultConfigDir()): SageConfig {
  const missing = REQUIRED.filter((k) => !values[k]);
  if (missing.length > 0) {
    throw new SageConfigError(`Sage env file is missing ${missing.join(', ')} (see sage-env.template).`);
  }
  const baseUrl = (values.SAGE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!/^https:\/\//.test(baseUrl)) throw new SageConfigError('SAGE_BASE_URL must be https.');
  return {
    baseUrl,
    username: values.SAGE_USERNAME!,
    password: values.SAGE_PASSWORD!,
    apiKey: values.SAGE_API_KEY!,
    companyId: values.SAGE_COMPANY_ID!,
    downloadDir: values.SAGE_DOWNLOAD_DIR || join(dir, 'downloads'),
    stateDir: values.SAGE_STATE_DIR || dir,
  };
}

/** Reads and validates the env file. Throws SageConfigError with a message safe to show an agent. */
export function loadConfig(path = process.env.SAGE_MCP_ENV_FILE || join(defaultConfigDir(), 'sage.env')): SageConfig {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new SageConfigError(`No Sage env file at ${path}. Copy sage-env.template there and fill it in.`);
  }
  if ((mode & 0o077) !== 0) {
    throw new SageConfigError(`Sage env file ${path} is readable by other users; run: chmod 600 ${path}`);
  }
  return configFromValues(parseEnvFile(readFileSync(path, 'utf8')));
}
