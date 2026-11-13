/**
 * The text box under a comment thread, shared by "add" and "edit". Plain text only. A colleague is mentioned
 * by choosing them in the list: "@Name " goes into the text and their id into the mentions; a name deleted
 * from the text drops the mention.
 */
import { useId, useState } from 'react';
import { Button } from '@/components/ui';
import { Select } from '@/components/ui/Select';
import { MAX_COMMENT_BODY } from '@/modules/accounting/services/comments/commentText';
import type { Mentionable } from './commentsApi';

interface Props {
  label: string;
  initial?: string;
  initialMentions?: string[];
  people: Mentionable[];
  submitLabel: string;
  busy: boolean;
  error: string;
  onSubmit: (body: string, mentions: string[]) => void;
  onCancel?: () => void;
}

export function CommentComposer({ label, initial = '', initialMentions = [], people, submitLabel, busy, error, onSubmit, onCancel }: Props) {
  const [text, setText] = useState(initial);
  const [picked, setPicked] = useState<string[]>(initialMentions);
  const inputId = useId();
  const length = Array.from(text).length;
  const over = length > MAX_COMMENT_BODY;
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? '';
  // A mention stays only while its "@Name" is still in the text.
  const mentions = picked.filter((id) => nameOf(id) === '' || text.includes(`@${nameOf(id)}`));

  function pick(id: string) {
    const name = nameOf(id);
    setText((t) => `${t}${t === '' || /\s$/.test(t) ? '' : ' '}@${name} `);
    setPicked((p) => (p.includes(id) ? p : [...p, id]));
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (!busy && !over && text.trim() !== '') onSubmit(text, mentions); }}
      className="space-y-2"
    >
      <label htmlFor={inputId} className="block text-sm font-medium text-[var(--ff-text-primary)]">{label}</label>
      <textarea
        id={inputId}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="w-full resize-y rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] p-2 text-sm text-[var(--ff-text-primary)] ff-focus-ring"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {people.length > 0 ? (
          <Select
            label="Mention a colleague"
            labelClassName="sr-only"
            size="sm"
            className="w-48 max-w-full"
            placeholder="Mention…"
            options={people.map((p) => ({ value: p.id, label: p.name }))}
            value={null}
            onChange={(id) => { if (id) pick(id); }}
          />
        ) : <span />}
        <span className={`text-xs tabular-nums ${over ? 'text-red-600 dark:text-red-400' : 'text-[var(--ff-text-secondary)]'}`}>
          {length} / {MAX_COMMENT_BODY}
        </span>
      </div>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || over || text.trim() === ''}>{busy ? 'Saving…' : submitLabel}</Button>
        {onCancel && <Button type="button" size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}
