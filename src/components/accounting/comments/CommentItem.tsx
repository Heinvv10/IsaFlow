/**
 * One comment. The body is rendered as TEXT (React escapes it; there is no dangerouslySetInnerHTML), with line
 * breaks kept. The author's own comments offer Edit and Delete; Delete asks once.
 */
import { useState } from 'react';
import { Button } from '@/components/ui';
import { apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { formatDisplayDateTime } from '@/utils/dateFormat';
import { CommentComposer } from './CommentComposer';
import { removeComment, saveComment, type Mentionable, type RecordComment } from './commentsApi';

interface Props {
  comment: RecordComment;
  mine: boolean;
  people: Mentionable[];
  onChanged: () => void;
}

const LINK_BTN = 'text-xs font-medium text-teal-700 hover:underline dark:text-teal-300 ff-focus-ring rounded';

export function CommentItem({ comment, mine, people, onChanged }: Props) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(action: () => Promise<unknown>, failure: string) {
    setBusy(true);
    setError('');
    try {
      await action();
      setMode('view');
      onChanged();
    } catch (err) {
      log.warn('Comment change failed', { error: err }, 'comments');
      setError(apiErrorMessage(err, failure));
    } finally {
      setBusy(false);
    }
  }

  const mentioned = comment.mentions.map((id) => people.find((p) => p.id === id)?.name).filter((n): n is string => !!n);

  return (
    <li className="rounded-lg border border-[var(--ff-border-light)] p-2.5" data-testid="comment-item">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-[var(--ff-text-secondary)]">
        <span className="min-w-0 break-words font-medium text-[var(--ff-text-primary)]">{comment.authorName ?? 'A colleague'}</span>
        <span>{formatDisplayDateTime(comment.createdAt)}{comment.editedAt ? ' (edited)' : ''}</span>
      </div>
      {mode === 'edit' ? (
        <div className="mt-2">
          <CommentComposer label="Edit your comment" initial={comment.body} initialMentions={comment.mentions} people={people}
            submitLabel="Save" busy={busy} error={error} onCancel={() => { setMode('view'); setError(''); }}
            onSubmit={(body, mentions) => void run(() => saveComment(comment.id, body, mentions), 'Could not save the comment - try again')} />
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--ff-text-primary)]" data-testid="comment-body">{comment.body}</p>
      )}
      {mentioned.length > 0 && mode !== 'edit' && (
        <p className="mt-1 text-xs text-[var(--ff-text-secondary)]">Mentioned: {mentioned.join(', ')}</p>
      )}
      {mine && mode === 'view' && (
        <div className="mt-1.5 flex gap-3">
          <button type="button" className={LINK_BTN} onClick={() => setMode('edit')}>Edit</button>
          <button type="button" className={LINK_BTN} onClick={() => setMode('confirm')}>Delete</button>
        </div>
      )}
      {mode === 'confirm' && (
        <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Confirm delete">
          <span className="text-sm text-[var(--ff-text-primary)]">Delete this comment?</span>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => removeComment(comment.id), 'Could not delete the comment - try again')}>
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => { setMode('view'); setError(''); }}>Keep</Button>
        </div>
      )}
      {mode !== 'edit' && error && <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </li>
  );
}
