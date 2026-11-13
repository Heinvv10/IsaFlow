/**
 * "Ask IsaFlow" panel inside the command palette (wave 5 M11). One question box; the answer comes from
 * GET /api/accounting/ask (fixed patterns, read-only services, no model). Nothing here computes a figure.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { apiJson, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { rand, type AskAnswer } from '@/modules/accounting/services/ask/askTypes';
import { INTENT_EXAMPLES } from '@/modules/accounting/services/ask/askIntents';

export function AskPanel({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const ask = async (q: string): Promise<void> => {
    const mine = ++latest.current;
    setBusy(true); setError('');
    try {
      const a = await apiJson(`/api/accounting/ask?q=${encodeURIComponent(q)}`, { cache: 'no-store' }, 'Could not answer that - try again');
      if (latest.current === mine) setAnswer(a);
    } catch (err) {
      log.warn('Ask IsaFlow failed', { err }, 'AskPanel');
      if (latest.current === mine) { setAnswer(null); setError(apiErrorMessage(err, 'Could not answer that - try again')); }
    } finally {
      if (latest.current === mine) setBusy(false);
    }
  };
  const submit = (e: FormEvent): void => { e.preventDefault(); if (question.trim()) void ask(question.trim()); };
  const suggestions = answer && !answer.understood ? answer.suggestions : [];

  return (
    <div data-testid="ask-panel" className="flex flex-col overflow-y-auto">
      <form onSubmit={submit} className="flex items-center gap-3 px-4 border-b border-line">
        <input ref={input} type="text" aria-label="Ask IsaFlow a question" value={question} onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && !question) { e.stopPropagation(); onBack(); } }}
          placeholder="Ask, e.g. who owes me money?" maxLength={300}
          className="flex-1 py-4 text-base bg-transparent outline-none text-ink placeholder:text-ink-muted" />
        <button type="submit" disabled={busy || !question.trim()} className="px-3 py-1.5 text-sm rounded-lg bg-brand-700 text-white disabled:opacity-50 dark:bg-teal-500 dark:text-gray-900">
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>
      <div className="px-4 py-3 text-sm text-ink" role="status" aria-live="polite" data-testid="ask-answer">
        {!answer && !error && !busy && (
          <p className="text-ink-muted">Answers come from your books with fixed question patterns, not a model. Try: {INTENT_EXAMPLES.slice(0, 3).map((i) => i.example).join(' · ')}</p>
        )}
        {error && <p role="alert">{error}</p>}
        {answer && (
          <>
            <p className="font-medium" data-testid="ask-text">{answer.text}</p>
            {answer.lines.length > 0 && (
              <ul className="mt-2 space-y-1 text-ink-muted">
                {answer.lines.map((l) => <li key={l.label} className="flex justify-between gap-4"><span className="truncate">{l.label}</span><span className="tabular-nums">{rand(l.value)}</span></li>)}
              </ul>
            )}
            {suggestions.length > 0 && (
              <ul className="mt-2 space-y-1">
                {suggestions.map((s) => <li key={s}><button type="button" className="text-left underline text-ink-muted hover:text-ink" onClick={() => { setQuestion(s); void ask(s); }}>{s}</button></li>)}
              </ul>
            )}
            {answer.link && <Link href={answer.link.href} onClick={onClose} className="mt-3 inline-block underline text-teal-700 dark:text-teal-400">{answer.link.label}</Link>}
          </>
        )}
      </div>
      <button type="button" onClick={onBack} className="self-start px-4 pb-3 text-xs text-ink-muted hover:text-ink">Back to search</button>
    </div>
  );
}
