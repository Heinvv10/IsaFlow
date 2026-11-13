/**
 * Whether what was typed into the palette is a question for Ask IsaFlow, and where its row goes (wave 5 M11).
 * A wh-question or a trailing "?" is a question whatever follows, so its row comes first. A longer phrase that only
 * matches an intent ("profit last month", "profit and loss") may as well be a page search, so its row comes last:
 * Enter still opens the page. One word ("vat") is a page search, no row.
 */
import { parseQuestion } from '@/modules/accounting/services/ask/askIntents';

const QUESTION_WORD = /^(who|whom|what|whats|how|when|which|why|where|is|are|do|does|did|can|could|show me|tell me)\b/i;

export function askRowPlacement(typed: string): 'first' | 'last' | null {
  const t = typed.trim();
  if (t.length < 4) return null;
  if (QUESTION_WORD.test(t) || t.endsWith('?')) return 'first';
  const words = t.split(/\s+/).length;
  return words >= 2 && parseQuestion(t).kind !== 'none' ? 'last' : null;
}
