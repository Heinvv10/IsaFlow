/**
 * Audit S-04/S-08 follow-up (item D) — emailLayout(content) puts `content`
 * straight inside its card <table>. Bare <h2>/<p> blocks there are not valid
 * table content, so an HTML parser hoists them ABOVE the card and the logo:
 * the email opens with its text on the grey page, then an empty card. Each
 * email below is rendered through its real code path and parsed by happy-dom
 * (browsers hoist the blocks above the card; happy-dom empties them there). Its
 * heading and first paragraph must sit inside the card, after the logo, in
 * exactly one content row of the card.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Window } from 'happy-dom';
import type { PortalContact } from '@/modules/accounting/services/afs/afsTypes';

const m = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  sql: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => m.sql(...a) }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: m.sendEmail }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: async () => true,
  getClientIp: () => '127.0.0.1',
  withRateLimit: (h: unknown) => h,
}));
vi.mock('@/lib/auth/gotrue', () => ({
  adminGetUserByEmail: m.getUser,
  adminCreateUser: async () => ({ id: 'new-user' }),
  adminDeleteUser: async () => undefined,
}));
vi.mock('@/lib/auth/emailVerificationService', () => ({
  createEmailVerificationToken: async () => ({ token: 'a'.repeat(64), expiresAt: new Date() }),
  invalidateVerificationTokensForUser: async () => 0,
  purgeExpiredVerificationTokens: async () => ({ removed: 0, abandonedUserIds: [] }),
}));
vi.mock('@/lib/auth/passwordResetService', () => ({
  issuePasswordResetToken: async () => ({ token: 'b'.repeat(64), tokenHash: 'h' }),
  supersedePasswordResetTokens: async () => undefined,
  withdrawPasswordResetToken: async () => undefined,
}));
vi.mock('@/modules/accounting/services/afs/afsKpiService', () => ({
  getKpiScorecard: async () => ({ kpis: [{ label: 'Net margin', formatted: '12%', rag: 'green' }] }),
}));
vi.mock('@/modules/accounting/services/afs/pdfExportService', () => ({ exportToPdf: async () => null }));

import registerHandler from '@/../pages/api/auth/register';
import contactHandler from '@/../pages/api/contact';
import { sendPasswordResetEmail } from '@/lib/auth/passwordResetEmail';
import { deliverPack } from '@/modules/accounting/services/afs/packDeliveryService';
import {
  notifyMagicLinkRequested,
  notifySigningRequested,
  notifyDocumentSignedOff,
  notifyAnnotationReceived,
} from '@/modules/accounting/services/afs/portalNotificationService';

function res() {
  const r = {
    statusCode: 0,
    status(code: number) { r.statusCode = code; return r; },
    json() { return r; },
    setHeader() { return r; },
  };
  return r as unknown as NextApiResponse;
}

function req(body: Record<string, unknown>) {
  return { method: 'POST', body, headers: {}, socket: {} } as unknown as NextApiRequest;
}

function sentHtml(): string {
  const call = m.sendEmail.mock.calls.at(-1);
  if (!call) throw new Error('no email was sent');
  return (call[0] as { html: string }).html;
}

/** Card = the 600px table; its direct rows are header, content, footer. */
function expectInsideCard(html: string, heading: string, firstPara: string) {
  const doc = new new Window().DOMParser().parseFromString(html, 'text/html');
  const card = doc.querySelector('table[width="600"]');
  const logo = doc.querySelector('img[alt="ISAFlow"]');
  const h = [...doc.querySelectorAll('h2')].find((e) => e.textContent?.trim() === heading);
  const p = [...doc.querySelectorAll('p')].find((e) => e.textContent?.includes(firstPara));
  expect(card, 'card table').toBeTruthy();
  expect(logo, 'logo').toBeTruthy();
  expect(h, `heading "${heading}"`).toBeTruthy();
  expect(p, `paragraph "${firstPara}"`).toBeTruthy();
  for (const el of [h!, p!]) {
    expect(card!.contains(el), `"${el.textContent?.trim().slice(0, 40)}" is inside the card`).toBe(true);
    // DOCUMENT_POSITION_FOLLOWING (4): the text comes after the logo.
    expect(logo!.compareDocumentPosition(el) & 4).toBe(4);
  }
  // Header, ONE content row, footer: a double-wrapped row leaves an empty extra row.
  const rows = [...card!.querySelectorAll('tr')].filter((r) => r.parentElement?.closest('table') === card);
  expect(rows).toHaveLength(3);
  expect(rows[1]!.contains(h!)).toBe(true);
}

beforeEach(() => {
  m.sendEmail.mockReset().mockResolvedValue({ success: true });
  m.sql.mockReset();
  m.getUser.mockReset().mockResolvedValue(null);
});

describe('emails with bare content sit inside the card, after the logo', () => {
  it('register: confirm your email', async () => {
    await registerHandler(req({
      email: 'new@example.co.za', password: 'CorrectHorseBattery1',
      companyName: 'New Co', firstName: 'New', lastName: 'User',
    }), res());
    expectInsideCard(sentHtml(), 'Confirm your email', 'Thanks for signing up for ISAFlow.');
  });

  it('contact form enquiry', async () => {
    await contactHandler(req({ name: 'Jo', email: 'jo@example.co.za', message: 'Please call me back.' }), res());
    expectInsideCard(sentHtml(), 'New contact request from isaflow.co.za', 'Please call me back.');
  });

  it('password reset', async () => {
    await sendPasswordResetEmail('u1', 'jo@example.co.za');
    expectInsideCard(sentHtml(), 'Reset your ISAFlow password', 'We received a request to reset the password');
  });

  it('management pack delivery', async () => {
    m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const q = strings.join('?');
      if (q.includes('FROM afs_documents')) return [{ id: 'd1', period: '2026-09', status: 'final' }];
      if (q.includes('FROM management_pack_configs')) return [{ recipients: [{ email: 'cfo@example.co.za', receives: 'both' }] }];
      if (q.includes('FROM companies')) return [{ name: 'Alpha (Pty) Ltd' }];
      return [];
    });
    await deliverPack('d1', 'co-1');
    expectInsideCard(sentHtml(), 'Alpha (Pty) Ltd', 'Management Accounts — 2026-09');
  });

  it('portal: sign-in link', async () => {
    await notifyMagicLinkRequested({ name: 'Jo', email: 'jo@example.co.za' },
      [{ companyId: 'co-1', companyName: 'Alpha', url: 'https://app/verify?token=a' }]);
    expectInsideCard(sentHtml(), 'ISaFlow Portal — Sign-in Link', 'Hi Jo,');
  });

  it('portal: signature required', async () => {
    const contact = { id: 'c1', name: 'Jo', email: 'jo@example.co.za', companyId: 'co-1' } as unknown as PortalContact;
    await notifySigningRequested(contact, 'd1', 'https://app/sign/x');
    expectInsideCard(sentHtml(), 'Annual Financial Statements — Signature Required', 'Hi Jo,');
  });

  it('portal: signed off', async () => {
    m.sql.mockResolvedValue([{ id: 'c1', name: 'Jo', email: 'jo@example.co.za' }]);
    await notifyDocumentSignedOff('co-1', 'd1');
    expectInsideCard(sentHtml(), 'Annual Financial Statements — Signed Off', 'Hi Jo,');
  });

  it('portal: annotation received', async () => {
    m.sql.mockResolvedValue([{ email: 'owner@example.co.za', first_name: 'Sam' }]);
    await notifyAnnotationReceived('co-1', 's1', 'Jo');
    expectInsideCard(sentHtml(), 'New Client Annotation — AFS Review', 'Hi Sam,');
  });
});
