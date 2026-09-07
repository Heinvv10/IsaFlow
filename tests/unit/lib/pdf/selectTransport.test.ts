import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { chooseTransportName, resetAllowListWarning, ALLOW_LIST_VERIFIED_ENV } from '@/lib/pdf/selectTransport';
import { log } from '@/lib/logger';

beforeEach(() => {
  resetAllowListWarning();
  vi.mocked(log.warn).mockClear();
});

describe('chooseTransportName', () => {
  it('uses Gotenberg when GOTENBERG_URL is set', () => {
    expect(chooseTransportName({ GOTENBERG_URL: 'http://localhost:5002' })).toBe('gotenberg');
  });
  it('falls back to Playwright when it is not', () => {
    expect(chooseTransportName({})).toBe('playwright');
  });
  it('treats an empty or whitespace GOTENBERG_URL as unset', () => {
    expect(chooseTransportName({ GOTENBERG_URL: '' })).toBe('playwright');
    expect(chooseTransportName({ GOTENBERG_URL: '   ' })).toBe('playwright');
  });
  it('lets PDF_TRANSPORT force Playwright even when a container is configured', () => {
    expect(chooseTransportName({ GOTENBERG_URL: 'http://x', PDF_TRANSPORT: 'playwright' })).toBe('playwright');
  });

  it('throws in production when GOTENBERG_URL is absent, rather than falling back to Playwright', () => {
    expect(() => chooseTransportName({ NODE_ENV: 'production' })).toThrow(/GOTENBERG_URL is required in production/);
  });

  it('throws in production when GOTENBERG_URL is blank', () => {
    expect(() => chooseTransportName({ NODE_ENV: 'production', GOTENBERG_URL: '   ' })).toThrow(
      /GOTENBERG_URL is required in production/,
    );
  });

  it('lets PDF_TRANSPORT=playwright override the production guard deliberately', () => {
    expect(chooseTransportName({ NODE_ENV: 'production', PDF_TRANSPORT: 'playwright' })).toBe('playwright');
  });

  it('uses Gotenberg in production when GOTENBERG_URL is set', () => {
    expect(chooseTransportName({ NODE_ENV: 'production', GOTENBERG_URL: 'http://localhost:5002' })).toBe(
      'gotenberg',
    );
  });

  it('keeps the Playwright default outside production when GOTENBERG_URL is unset', () => {
    expect(chooseTransportName({ NODE_ENV: 'test' })).toBe('playwright');
    expect(chooseTransportName({ NODE_ENV: 'development' })).toBe('playwright');
  });
});

/**
 * ADVERSARIAL LOW-3: the print-token cookies are scoped to a bare `domain`,
 * which matches subdomains (gotenbergForm.ts explains why Gotenberg offers no
 * tighter form). What contains that is the container's own
 * --chromium-allow-list — a flag on a docker run line, with no compose file,
 * systemd unit or deploy env-check in this repo to assert it against, and
 * Gotenberg's /health and /version report neither flags nor configuration. So
 * it cannot be verified from here; it can only be made visible.
 */
describe('the Gotenberg allow-list assumption', () => {
  it('warns on every boot that selects Gotenberg without the operator flag', () => {
    expect(chooseTransportName({ GOTENBERG_URL: 'http://localhost:5002' })).toBe('gotenberg');
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('allow-list'),
      expect.objectContaining({ setting: ALLOW_LIST_VERIFIED_ENV }),
      'pdf',
    );
  });

  it('warns for the forced-gotenberg route too, not only the URL-derived one', () => {
    expect(chooseTransportName({ PDF_TRANSPORT: 'gotenberg' })).toBe('gotenberg');
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);
  });

  it('stays quiet once an operator has confirmed the running container', () => {
    chooseTransportName({ GOTENBERG_URL: 'http://localhost:5002', [ALLOW_LIST_VERIFIED_ENV]: 'true' });
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it('says it once, not once per export', () => {
    for (let i = 0; i < 5; i += 1) chooseTransportName({ GOTENBERG_URL: 'http://localhost:5002' });
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);
  });

  it('says nothing when Playwright is the transport — there is no container to pin', () => {
    chooseTransportName({});
    chooseTransportName({ GOTENBERG_URL: 'http://x', PDF_TRANSPORT: 'playwright' });
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });
});
