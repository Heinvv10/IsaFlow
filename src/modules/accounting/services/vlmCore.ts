/**
 * VLM Core — shared config, helpers, and type utilities
 * Used internally by vlmInvoiceService, vlmBankService, vlmStatutoryService.
 */

import { log } from '@/lib/logger';
import type { ExtractedLineItem, VendorBankDetails } from '@/modules/accounting/types/documentCapture.types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface VlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeout: number;
}

export function getVlmConfig(): VlmConfig | null {
  const baseUrl = process.env.VLLM_BASE_URL;
  if (!baseUrl) return null;
  const apiKey = process.env.VLLM_API_KEY;
  if (!apiKey) throw new Error('VLLM_API_KEY is not configured');
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model: process.env.VLLM_MODEL || 'Qwen/Qwen3-VL-8B',
    apiKey,
    timeout: parseInt(process.env.VLLM_TIMEOUT || '120000', 10),
  };
}

/** Returns true if vLLM is configured */
export function isVlmAvailable(): boolean {
  return !!process.env.VLLM_BASE_URL;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

export async function callVlmChat(
  config: VlmConfig,
  systemPrompt: string,
  userContent: Array<Record<string, unknown>>,
  maxTokens = 4096,
): Promise<string | null> {
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: maxTokens,
    temperature: 0.1,
    stream: false,
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      log.error('vLLM request failed', {
        status: response.status,
        error: errorText.substring(0, 500),
      }, 'vlm-core');
      return null;
    }

    const result = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return result.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('aborted') || msg.includes('AbortError')) {
      log.error('vLLM request timed out', { timeout: config.timeout }, 'vlm-core');
    } else {
      log.error('vLLM request error', { error: msg }, 'vlm-core');
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON cleanup
// ---------------------------------------------------------------------------

export function cleanVlmJson(content: string): string {
  let jsonStr = content.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  if (jsonStr.includes('<think>')) {
    jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  }
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) jsonStr = jsonMatch[0];
  return jsonStr;
}

// ---------------------------------------------------------------------------
// Primitive coercion helpers (exported for use by sub-services)
// ---------------------------------------------------------------------------

export function asString(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s.length > 0 ? s : null;
}

export function asNumber(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

export function asDateString(val: unknown): string | null {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return s;
  }
  return null;
}

export function parseLineItems(val: unknown): ExtractedLineItem[] {
  if (!Array.isArray(val)) return [];
  return val
    .filter((item): item is Record<string, unknown> => item && typeof item === 'object')
    .map((item) => ({
      description: asString(item.description) || 'Unknown item',
      quantity: asNumber(item.quantity),
      unitPrice: asNumber(item.unitPrice) ?? asNumber(item.unit_price),
      total: asNumber(item.total) ?? asNumber(item.lineTotal) ?? asNumber(item.line_total),
      vatAmount: asNumber(item.vatAmount) ?? asNumber(item.vat_amount),
      vatClassification: validateVatClassification(item.vatClassification ?? item.vat_classification),
      glAccountSuggestion: asString(item.glAccountSuggestion) ?? asString(item.gl_account_suggestion),
    }));
}

function validateVatClassification(val: unknown): ExtractedLineItem['vatClassification'] {
  const valid = ['standard', 'zero_rated', 'exempt', 'capital'];
  const s = asString(val);
  return s && valid.includes(s) ? s as ExtractedLineItem['vatClassification'] : null;
}

export function parseBankDetails(val: unknown): VendorBankDetails | null {
  if (!val || typeof val !== 'object') return null;
  const obj = val as Record<string, unknown>;
  const details: VendorBankDetails = {
    bankName: asString(obj.bankName) ?? asString(obj.bank_name),
    accountNumber: asString(obj.accountNumber) ?? asString(obj.account_number),
    branchCode: asString(obj.branchCode) ?? asString(obj.branch_code),
    accountType: asString(obj.accountType) ?? asString(obj.account_type),
  };
  if (details.bankName || details.accountNumber || details.branchCode) return details;
  return null;
}

// ---------------------------------------------------------------------------
// Image content builder
// ---------------------------------------------------------------------------

export function buildImageContent(
  base64: string,
  mimeType: string,
  textPrompt: string,
): Array<Record<string, unknown>> {
  return [
    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
    { type: 'text', text: textPrompt },
  ];
}
