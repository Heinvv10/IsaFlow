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
});
