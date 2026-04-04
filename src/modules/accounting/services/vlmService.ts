/**
 * VLM Service — coordinator and re-export facade
 *
 * Maintains backward-compatibility for all existing imports.
 * Domain logic lives in:
 *   vlmCore.ts           — shared config, helpers, HTTP
 *   vlmInvoiceService.ts — invoice / document extraction
 *   vlmBankService.ts    — bank statement extraction
 *   vlmStatutoryService.ts — statutory document extraction
 *
 * Environment:
 *   VLLM_BASE_URL  — e.g. http://192.168.1.100:8000/v1
 *   VLLM_MODEL     — e.g. Qwen/Qwen3-VL-8B
 *   VLLM_API_KEY   — optional, defaults to "EMPTY"
 *   VLLM_TIMEOUT   — request timeout in ms, defaults to 120000
 */

// Core availability check
export { isVlmAvailable } from './vlmCore';

// Invoice / document extraction
export {
  extractWithVlm,
  extractPdfWithVlm,
} from './vlmInvoiceService';

// Bank statement extraction
export { extractBankStatementWithVlm } from './vlmBankService';

// Statutory document extraction
export { extractStatutoryDocWithVlm } from './vlmStatutoryService';
