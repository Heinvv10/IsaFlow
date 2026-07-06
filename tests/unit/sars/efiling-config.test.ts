/**
 * TDD (RED first): SARS eFiling env-config gate.
 * The whole ISV feature is dark unless every credential is present AND the
 * master switch is on. efilingConfigStatus() is the redacted shape the UI
 * reads — it must NEVER leak the activation key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getEfilingConfig,
  isEfilingConfigured,
  efilingConfigStatus,
} from '@/modules/accounting/services/reports/sarsEfilingConfig';

const KEYS = [
  'SARS_EFILING_ENABLED',
  'SARS_EFILING_BASE_URL',
  'SARS_EFILING_ISV_LOGIN',
  'SARS_EFILING_ISV_KEY',
] as const;

function configureAll() {
  process.env.SARS_EFILING_ENABLED = 'true';
  process.env.SARS_EFILING_BASE_URL = 'http://127.0.0.1:9999/isv';
  process.env.SARS_EFILING_ISV_LOGIN = 'isv-login-001';
  process.env.SARS_EFILING_ISV_KEY = 'super-secret-activation-key';
}

describe('sarsEfilingConfig', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is not configured when the master switch is off', () => {
    process.env.SARS_EFILING_BASE_URL = 'http://127.0.0.1:9999/isv';
    process.env.SARS_EFILING_ISV_LOGIN = 'isv-login-001';
    process.env.SARS_EFILING_ISV_KEY = 'k';
    // SARS_EFILING_ENABLED intentionally unset
    expect(isEfilingConfigured()).toBe(false);
    expect(getEfilingConfig()).toBeNull();
  });

  it('is not configured when any credential is missing', () => {
    process.env.SARS_EFILING_ENABLED = 'true';
    process.env.SARS_EFILING_BASE_URL = 'http://127.0.0.1:9999/isv';
    process.env.SARS_EFILING_ISV_LOGIN = 'isv-login-001';
    // key missing
    expect(getEfilingConfig()).toBeNull();
    expect(isEfilingConfigured()).toBe(false);
  });

  it('is not configured when the base URL is not a valid absolute URL', () => {
    configureAll();
    process.env.SARS_EFILING_BASE_URL = 'not-a-url';
    expect(getEfilingConfig()).toBeNull();
  });

  it('returns a full config when enabled and every credential is present', () => {
    configureAll();
    const cfg = getEfilingConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.baseUrl).toBe('http://127.0.0.1:9999/isv');
    expect(cfg!.isvLogin).toBe('isv-login-001');
    expect(cfg!.activationKey).toBe('super-secret-activation-key');
    expect(isEfilingConfigured()).toBe(true);
  });

  it('exposes a redacted status that never leaks the activation key', () => {
    configureAll();
    const status = efilingConfigStatus();
    expect(status.configured).toBe(true);
    expect(status.baseUrlHost).toBe('127.0.0.1');
    // The activation key and login must not appear anywhere in the status.
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('super-secret-activation-key');
    expect(serialized).not.toContain('isv-login-001');
  });

  it('reports not-configured status when dark', () => {
    const status = efilingConfigStatus();
    expect(status.configured).toBe(false);
    expect(status.baseUrlHost).toBeNull();
  });
});
