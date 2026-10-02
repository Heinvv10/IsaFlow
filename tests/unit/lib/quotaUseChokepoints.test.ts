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
      sendMail.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ESOCKET', syscall: 'connect' }));
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

    // vLLM (OpenAI-compatible) documents no not-processed status: its 529 is a 5xx like any other.
    it.each([[400, 0], [429, 0], [408, 1], [503, 1], [529, 1]])('after a provider %i answer, records %i AI use', async (status, ai) => {
      fetchMock.mockResolvedValue({ ok: false, status, text: async () => 'no' });
      expect(await used(async () => {
        expect(await callVlmChat(VLM, 'sys', [])).toBeNull();
      })).toEqual({ ai, send: 0 });
    });

    it('records one AI use when the call times out or is aborted: the provider may have done the work', async () => {
      fetchMock.mockRejectedValue(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      expect(await used(async () => {
        expect(await callVlmChat(VLM, 'sys', [])).toBeNull();
      })).toEqual({ ai: 1, send: 0 });
    });

    it('records nothing when the provider could not be reached at all', async () => {
      fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
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

    it('records nothing when the provider refuses the request (4xx)', async () => {
      createMessage.mockRejectedValue(Object.assign(new Error('400 bad request'), { status: 400 }));
      expect(await used(() => generateNoteNarrative(...NOTE))).toEqual({ ai: 0, send: 0 });
    });

    it('records nothing on an Anthropic 529 (overloaded): the request was turned away', async () => {
      createMessage.mockRejectedValue(Object.assign(new Error('529 overloaded'), { status: 529 }));
      expect(await used(() => generateNoteNarrative(...NOTE))).toEqual({ ai: 0, send: 0 });
    });

    it('records one AI use on any other 5xx: it may come after the work', async () => {
      createMessage.mockRejectedValue(Object.assign(new Error('500 api_error'), { status: 500 }));
      expect(await used(() => generateNoteNarrative(...NOTE))).toEqual({ ai: 1, send: 0 });
    });

    it('records nothing when the provider could not be reached', async () => {
      createMessage.mockRejectedValue(Object.assign(new Error('Connection error.'), { cause: { code: 'ENOTFOUND' } }));
      expect(await used(() => generateNoteNarrative(...NOTE))).toEqual({ ai: 0, send: 0 });
    });

    it('records one AI use when the call times out', async () => {
      createMessage.mockRejectedValue(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }));
      expect(await used(() => generateNoteNarrative(...NOTE))).toEqual({ ai: 1, send: 0 });
    });
  });

  it('the Anthropic rule differs from the general one only at 529', async () => {
    const { markAnthropicUsedForStatus, markAnthropicUsedUnlessNoWork, markQuotaUsedForStatus } = await import('@/lib/quotaUse');
    for (const status of [400, 408, 429, 500, 502, 503, 504, 529]) {
      const general = await used(async () => markQuotaUsedForStatus('ai', status));
      const anthropic = await used(async () => markAnthropicUsedForStatus(status));
      const thrown = await used(async () => markAnthropicUsedUnlessNoWork(Object.assign(new Error('x'), { status })));
      expect({ status, anthropic, thrown }).toEqual({ status, anthropic: status === 529 ? { ai: 0, send: 0 } : general, thrown: anthropic });
    }
    // A thrown error with no status keeps the timeout rule: it counts.
    expect(await used(async () => markAnthropicUsedUnlessNoWork(new Error('Request timed out.')))).toEqual({ ai: 1, send: 0 });
  });

  it('use recorded outside any request is dropped, not an error', () => {
    expect(() => markQuotaUsed('ai')).not.toThrow();
  });
});
