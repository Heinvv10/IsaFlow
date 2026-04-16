import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { sql } from '@/lib/neon';

describe('signumIntegrationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SIGNUM_API_URL = 'https://signum.velocityfibre.co.za/api/v1';
    process.env.SIGNUM_API_KEY = 'test-api-key';
    process.env.SIGNUM_WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.SIGNUM_CALLBACK_BASE_URL = 'https://app.isaflow.co.za/accounting/afs/sign';
    process.env.SIGNUM_EXPIRES_IN_DAYS = '14';
  });

  describe('verifySignumWebhookSignature', () => {
    it('returns true for a valid HMAC with sha256= prefix', async () => {
      const { verifySignumWebhookSignature } = await import(
        '@/modules/accounting/services/afs/signumIntegrationService'
      );
      const crypto = await import('crypto');
      const payload = '{"event":"document.signed"}';
      const secret = 'test-webhook-secret';
      const hex = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      expect(verifySignumWebhookSignature(payload, `sha256=${hex}`)).toBe(true);
    });

    it('returns false when sha256= prefix is missing', async () => {
      const { verifySignumWebhookSignature } = await import(
        '@/modules/accounting/services/afs/signumIntegrationService'
      );
      const crypto = await import('crypto');
      const payload = '{"event":"document.signed"}';
      const hex = crypto.createHmac('sha256', 'test-webhook-secret').update(payload).digest('hex');
      expect(verifySignumWebhookSignature(payload, hex)).toBe(false);
    });

    it('returns false for a tampered payload', async () => {
      const { verifySignumWebhookSignature } = await import(
        '@/modules/accounting/services/afs/signumIntegrationService'
      );
      expect(
        verifySignumWebhookSignature('{"event":"document.signed"}', `sha256=${'a'.repeat(64)}`),
      ).toBe(false);
    });

    it('returns false for a null header', async () => {
      const { verifySignumWebhookSignature } = await import(
        '@/modules/accounting/services/afs/signumIntegrationService'
      );
      expect(verifySignumWebhookSignature('payload', null)).toBe(false);
    });

    it('throws when SIGNUM_WEBHOOK_SECRET is not set', async () => {
      delete process.env.SIGNUM_WEBHOOK_SECRET;
      const { verifySignumWebhookSignature } = await import(
        '@/modules/accounting/services/afs/signumIntegrationService'
      );
      expect(() => verifySignumWebhookSignature('payload', 'sha256=abc')).toThrow(
        'SIGNUM_WEBHOOK_SECRET not configured',
      );
    });
  });

  describe('downloadSignedPdf', () => {
    it('returns a Buffer from the Signum download endpoint', async () => {
      const pdfBytes = new Uint8Array([37, 80, 68, 70]); // %PDF
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => pdfBytes.buffer,
      });
      const { downloadSignedPdf } = await import(
        '@/modules/accounting/services/afs/signumIntegrationService'
      );
      const buffer = await downloadSignedPdf('signum-doc-id-1');
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer[0]).toBe(37); // %
    });

    it('throws when Signum returns non-2xx', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      const { downloadSignedPdf } = await import(
        '@/modules/accounting/services/afs/signumIntegrationService'
      );
      await expect(downloadSignedPdf('missing-id')).rejects.toThrow('Signum download failed: 404');
    });
  });

  describe('sendForSigning', () => {
    it('POSTs to /documents/from-html with JSON body and returns signumDocumentId + tokens', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          documentId: 'signum-123',
          signers: [{ email: 'alice@example.com', signingToken: 'tok-abc' }],
        }),
      });

      const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
      mockSql.mockResolvedValue([]);

      const { sendForSigning } = await import(
        '@/modules/accounting/services/afs/signumIntegrationService'
      );
      const result = await sendForSigning(
        'doc-id-1',
        'd27bac33-cdc0-4e58-bf6b-709c1597d41c',
        '<html>AFS content</html>',
        'Annual Financial Statements — Test Co',
        [{ email: 'alice@example.com', name: 'Alice' }],
      );

      expect(result.signumDocumentId).toBe('signum-123');
      expect(result.signingTokens).toHaveLength(1);
      expect(result.signingTokens[0]!.signingToken).toBe('tok-abc');

      // Must call /documents/from-html (JSON), not multipart
      expect(mockFetch).toHaveBeenCalledWith(
        'https://signum.velocityfibre.co.za/api/v1/documents/from-html',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      );

      // Verify request body shape
      const callArgs = mockFetch.mock.calls[0]![1] as { body: string };
      const body = JSON.parse(callArgs.body) as Record<string, unknown>;
      expect(body.html).toBe('<html>AFS content</html>');
      expect(body.senderEmail).toBe('accounts@isaflow.co.za');
      expect(body.callbackBaseUrl).toBe('https://app.isaflow.co.za/accounting/afs/sign');
      expect(body.expiresInDays).toBe(14);
    });

    it('throws when Signum returns non-2xx', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Error',
      });
      const { sendForSigning } = await import(
        '@/modules/accounting/services/afs/signumIntegrationService'
      );
      await expect(
        sendForSigning('doc-id-1', 'comp-id', '<html/>', 'Title', []),
      ).rejects.toThrow('Signum create failed: 500');
    });

    it('throws when SIGNUM_API_URL is not configured', async () => {
      delete process.env.SIGNUM_API_URL;
      const { sendForSigning } = await import(
        '@/modules/accounting/services/afs/signumIntegrationService'
      );
      await expect(
        sendForSigning('doc-id-1', 'comp-id', '<html/>', 'Title', []),
      ).rejects.toThrow('SIGNUM_API_URL');
    });
  });
});
