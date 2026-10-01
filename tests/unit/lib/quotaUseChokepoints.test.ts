/**
 * R-175: usage is recorded where the bounded work happens, not in each route.
 *
 * Three shared clients record it: the email sender (a mail server accepted a
 * message), the VLM client and the AFS note writer (a provider answered).
 * Each must record use on success and nothing on any failure, because the
 * request gets back whatever it charged and did not use.
 *
 * `als.run` with a `quotaCharges` list stands in for a withAuth request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMail, createMessage } = vi.hoisted(() => ({ sendMail: vi.fn(), createMessage: vi.fn() }));
vi.mock('nodemailer', () => {
  const createTransport = () => ({ sendMail });
  return { default: { createTransport }, createTransport };
});
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: createMessage }; } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { als, type RequestContext } from '@/lib/als';
import { markQuotaUsed } from '@/lib/quotaUse';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { callVlmChat } from '@/modules/accounting/services/bank/vlmCore';
import { generateNoteNarrative } from '@/modules/accounting/services/afs/noteAiService';

const fetchMock = vi.fn();
const VLM = { baseUrl: 'http://vlm.test', model: 'm', apiKey: 'k', timeout: 1000 };
const NOTE = [
  'ppe' as never, { title: 'PPE', blocks: [] } as never, '{tables}', { name: 'Co', framework: 'ifrs_smes', fiscalYear: 2025 } as never,
] as const;

/** Runs `work` inside a request that charged 5 of each kind; returns what it used. */
async function used(work: () => Promise<unknown>): Promise<{ ai: number; send: number }> {
  const ctx: RequestContext = {
    client: {} as RequestContext['client'], userId: 'u', claims: {},
    quotaCharges: [
      { kind: 'ai', key: 'ai:x:co:c:day', charged: 5, used: 0 },
      { kind: 'send', key: 'send:x:co:c:day', charged: 5, used: 0 },
    ],
  };
  await als.run(ctx, work).catch(() => undefined);
  return { ai: ctx.quotaCharges![0]!.used, send: ctx.quotaCharges![1]!.used };
}

describe('where usage-quota use is recorded (R-175)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('SMTP_HOST', 'mail.test');
    vi.stubEnv('SMTP_USER', 'u');
    vi.stubEnv('SMTP_PASS', 'p');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('sendEmail', () => {
    const mail = { to: 'a@b.co', subject: 's', html: '<p>h</p>' };

    it('records one send per message the mail server accepts', async () => {
      sendMail.mockResolvedValue({ messageId: 'mid' });
      expect(await used(async () => {
        expect((await sendEmail(mail)).success).toBe(true);
        expect((await sendEmail(mail)).success).toBe(true);
      })).toEqual({ ai: 0, send: 2 });
    });

    it('records nothing when the mail server refuses or is down', async () => {
      sendMail.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await used(async () => {
        expect((await sendEmail(mail)).success).toBe(false);
      })).toEqual({ ai: 0, send: 0 });
    });

    it('records nothing when SMTP is not configured', async () => {
      vi.stubEnv('SMTP_HOST', '');
      expect(await used(async () => {
        expect((await sendEmail(mail)).success).toBe(false);
      })).toEqual({ ai: 0, send: 0 });
      expect(sendMail).not.toHaveBeenCalled();
    });
  });

  describe('callVlmChat', () => {
    it('records one AI use when the provider answers', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) });
      expect(await used(async () => {
        expect(await callVlmChat(VLM, 'sys', [])).toBe('{}');
      })).toEqual({ ai: 1, send: 0 });
    });

    it('records nothing on a provider error status', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'overloaded' });
      expect(await used(async () => {
        expect(await callVlmChat(VLM, 'sys', [])).toBeNull();
      })).toEqual({ ai: 0, send: 0 });
    });

    it('records nothing when the provider call throws or times out', async () => {
      fetchMock.mockRejectedValue(new Error('This operation was aborted'));
      expect(await used(async () => {
        expect(await callVlmChat(VLM, 'sys', [])).toBeNull();
      })).toEqual({ ai: 0, send: 0 });
    });
  });

  describe('generateNoteNarrative', () => {
    it('records one AI use when the provider answers', async () => {
      createMessage.mockResolvedValue({ content: [{ type: 'text', text: 'narrative' }] });
      expect(await used(async () => {
        expect(await generateNoteNarrative(...NOTE)).toBe('narrative');
      })).toEqual({ ai: 1, send: 0 });
    });

    it('records nothing when the provider call fails', async () => {
      createMessage.mockRejectedValue(new Error('529 overloaded'));
      expect(await used(() => generateNoteNarrative(...NOTE))).toEqual({ ai: 0, send: 0 });
    });
  });

  it('use recorded outside any request is dropped, not an error', () => {
    expect(() => markQuotaUsed('ai')).not.toThrow();
  });
});
