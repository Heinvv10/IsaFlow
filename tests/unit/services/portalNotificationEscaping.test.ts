/**
 * TDD (RED first): portal notification emails must HTML-escape interpolated
 * user-controlled names, or a name containing markup injects arbitrary HTML
 * into the recipient's email (stored-XSS-style). All four builders share the
 * fix. (P3.5 review LOW: escape names in all 4 sibling builders together.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PortalContact } from '@/modules/accounting/services/afs/afsTypes';

const sendEmailMock = vi.hoisted(() => vi.fn());
const sqlMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: sendEmailMock }));

import {
  notifyMagicLinkRequested,
  notifySigningRequested,
  notifyDocumentSignedOff,
  notifyAnnotationReceived,
} from '@/modules/accounting/services/afs/portalNotificationService';

const XSS = '<script>alert(1)</script>';
const ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt;';

function lastHtml(): string {
  const call = sendEmailMock.mock.calls.at(-1);
  return (call?.[0] as { html: string }).html;
}

function contactWith(name: string): PortalContact {
  return { id: 'c1', name, email: 'a@b.co', companyId: 'co-1' } as unknown as PortalContact;
}

beforeEach(() => {
  sendEmailMock.mockReset();
  sqlMock.mockReset();
});

describe('portal notification HTML escaping', () => {
  it('escapes contact.name in the magic-link email', async () => {
    await notifyMagicLinkRequested(contactWith(XSS), 'https://app/magic');
    expect(lastHtml()).toContain(ESCAPED);
    expect(lastHtml()).not.toContain(XSS);
  });

  it('escapes contact.name in the signing-request email', async () => {
    await notifySigningRequested(contactWith(XSS), 'doc-1', 'https://app/sign');
    expect(lastHtml()).toContain(ESCAPED);
    expect(lastHtml()).not.toContain(XSS);
  });

  it('escapes the recipient name in the signed-off email', async () => {
    sqlMock.mockResolvedValue([{ id: 'r1', name: XSS, email: 'd@e.co' }]);
    await notifyDocumentSignedOff('co-1', 'doc-1');
    expect(lastHtml()).toContain(ESCAPED);
    expect(lastHtml()).not.toContain(XSS);
  });

  it('escapes the author name in the annotation email', async () => {
    sqlMock.mockResolvedValue([{ email: 'g@h.co', first_name: 'Jo' }]);
    await notifyAnnotationReceived('co-1', 'section-1', XSS);
    expect(lastHtml()).toContain(ESCAPED);
    expect(lastHtml()).not.toContain(XSS);
  });
});
