import { describe, it, expect } from 'vitest';
import { chooseTransportName } from '@/lib/pdf/selectTransport';

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
