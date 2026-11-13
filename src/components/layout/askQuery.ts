/**
 * Whether what was typed into the palette is a question for Ask IsaFlow, and where its row goes (wave 5 M11).
 * A wh-question or a trailing "?" is a question whatever follows, so its row comes first; is/are/do/does/did/can/could need at
 * least two more words that parse as a question, and get no row at all otherwise ("do not" must not open Ask). A longer phrase that only
 * matches an intent ("profit last month", "profit and loss") may as well be a page search, so its row comes last:
 * Enter still opens the page. One word ("vat") is a page search, no row.
 */
import { parseQuestion } from '@/modules/accounting/services/ask/askIntents';

const STRONG_WORD = /^(who|whom|what|whats|how|when|which|why|where|show me|tell me)\b/i;
/** Auxiliary verbs also start page searches ("do not", "is"), so they only count with a real question after them. */
const AUX_WORD = /^(is|are|do|does|did|can|could)\b/i;

export function askRowPlacement(typed: string): 'first' | 'last' | null {
  const t = typed.trim();
  if (t.length < 4) return null;
  const words = t.split(/\s+/).length;
  if (STRONG_WORD.test(t) || t.endsWith('?')) return 'first';
  if (AUX_WORD.test(t)) return words >= 3 && parseQuestion(t).kind !== 'none' ? 'first' : null;
  return words >= 2 && parseQuestion(t).kind !== 'none' ? 'last' : null;
}
