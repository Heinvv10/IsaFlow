/**
 * "Ask IsaFlow" answers (wave 5 M11). Each intent calls the read-only service its page uses (and its MCP tool wraps), so
 * the figure is the one the page shows. Nothing here writes, and every call takes the session's company id.
 */
import { parseQuestion, exampleFor, INTENT_EXAMPLES } from './askIntents';
import { aging, balanceSheet, bank, income } from './askFigures';
import { emp201, lastPayRun, vat } from './askTax';
import type { AskAnswer } from './askTypes';

export const NOT_UNDERSTOOD: AskAnswer = {
  understood: false,
  text: 'I can only answer a fixed set of questions, and this is not one of them. Try one of these:',
  figure: null, lines: [], link: null, suggestions: INTENT_EXAMPLES.map((i) => i.example),
};

/** Answers `question` for `companyId`. `today` is the South African date (YYYY-MM-DD). */
export async function answerQuestion(companyId: string, question: string, today: string): Promise<AskAnswer> {
  const parsed = parseQuestion(question);
  if (parsed.kind === 'none') return NOT_UNDERSTOOD;
  if (parsed.kind === 'ambiguous') {
    return { understood: false, text: 'That could mean more than one thing. Which did you mean?', figure: null, lines: [], link: null, suggestions: parsed.examples };
  }
  if (parsed.kind === 'periods') {
    return { understood: false, text: 'I can answer one period at a time. Which did you mean?', figure: null, lines: [], link: null, suggestions: parsed.examples };
  }
  if (parsed.kind === 'leftover') {
    return { understood: false, text: `I can't take "${parsed.words.join(' ')}" into account yet. Here is the plain question:`, figure: null, lines: [], link: null, suggestions: [exampleFor(parsed.id)] };
  }
  if (parsed.kind === 'unsupported') {
    if (parsed.text) return { understood: false, text: parsed.text, figure: null, lines: [], link: null, suggestions: [exampleFor(parsed.id)] };
    return { understood: false, text: `I can't answer ${parsed.said} yet. I can give the plain figure:`, figure: null, lines: [], link: null, suggestions: [exampleFor(parsed.id)] };
  }
  const { intent } = parsed;
  switch (intent.id) {
    case 'owed_to_me': return aging('ar', intent, companyId, today);
    case 'i_owe': return aging('ap', intent, companyId, today);
    case 'cash': case 'bank_to_allocate': return bank(intent, companyId, today);
    case 'profit': case 'revenue': case 'expenses': return income(intent, companyId, today);
    case 'assets': case 'liabilities': return balanceSheet(intent, companyId, today);
    case 'vat': return vat(intent, companyId, today);
    case 'emp201': return emp201(intent, companyId, today);
    case 'last_pay_run': return lastPayRun(intent, companyId, today);
  }
}
