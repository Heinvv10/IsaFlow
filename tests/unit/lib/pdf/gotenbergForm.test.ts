import { describe, it, expect } from 'vitest';
import { buildGotenbergFields } from '@/lib/pdf/transports/gotenbergForm';

const request = {
  url: 'https://app.isaflow.co.za/accounting/reports/report-packs?pack=management&print=1',
  landscape: false,
  allowedApiPaths: ['/api/accounting/reports-pack'],
  cookies: [
    { name: 'sb-access-token', value: 'tok.sig', httpOnly: true },
    { name: 'active_company_id', value: 'c-1', httpOnly: false },
  ],
};

describe('buildGotenbergFields', () => {
  it('sends the page URL and A4 geometry in inches', () => {
    const f = buildGotenbergFields(request);
    expect(f.url).toBe(request.url);
    expect(f.paperWidth).toBe('8.27');
    expect(f.paperHeight).toBe('11.69');
    expect(f.marginTop).toBe('0.71');
    expect(f.marginLeft).toBe('0.55');
  });

  it('waits for the print-ready flag rather than a fixed delay', () => {
    const f = buildGotenbergFields(request);
    expect(f.waitForExpression).toContain('[data-print-ready="true"]');
    expect(f.waitDelay).toBeUndefined();
  });

  it('emulates print media and prints backgrounds', () => {
    const f = buildGotenbergFields(request);
    expect(f.emulatedMediaType).toBe('print');
    expect(f.printBackground).toBe('true');
  });

  it('carries every cookie in one Cookie header', () => {
    const headers = JSON.parse(buildGotenbergFields(request).extraHttpHeaders!);
    expect(headers.Cookie).toBe('sb-access-token=tok.sig; active_company_id=c-1');
  });

  it('sets landscape only when asked', () => {
    expect(buildGotenbergFields(request).landscape).toBe('false');
    expect(buildGotenbergFields({ ...request, landscape: true }).landscape).toBe('true');
  });
});
