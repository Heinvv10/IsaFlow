/**
 * Comments on an invoice, a bill or a bank line (master plan wave 5, M14). In-app only: a mention shows in the
 * colleague's bell; nothing is emailed. Everyone who can open the record reads the thread; owners, admins and
 * managers (the write roles) add to it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { canWrite } from '@/lib/auth/writeRoles';
import { useAuth } from '@/contexts/AuthContext';
import { useCompany } from '@/contexts/CompanyContext';
import { CommentComposer } from './CommentComposer';
import { CommentItem } from './CommentItem';
import { addComment, readComments, type CommentRecordType, type CommentsRead } from './commentsApi';

export function CommentsPanel({ recordType, recordId }: { recordType: CommentRecordType; recordId: string }) {
  const { user } = useAuth();
  const { companyRole } = useCompany();
  const [read, setRead] = useState<CommentsRead | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [postError, setPostError] = useState('');
  const [composerKey, setComposerKey] = useState(0);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  // After a post or a delete the focus goes to the add box, not to the page.
  useEffect(() => { if (focusTick > 0) composer.current?.focus(); }, [focusTick]);
  const seq = useRef(0);

  // A response for a record the panel has left (or an older request) is dropped.
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const out = await readComments(recordType, recordId);
      if (mine === seq.current) { setRead(out); setLoadError(''); }
    } catch (err) {
      log.warn('Comments read failed', { recordType, error: err }, 'comments');
      if (mine === seq.current) setLoadError(apiErrorMessage(err, 'Could not load the comments - try again'));
    }
  }, [recordType, recordId]);

  useEffect(() => {
    setRead(null);
    void load();
    return () => { seq.current += 1; };
  }, [load]);

  async function post(body: string, mentions: string[]) {
    setBusy(true);
    setPostError('');
    try {
      await addComment(recordType, recordId, body, mentions);
      setComposerKey((k) => k + 1);
      await load();
      setFocusTick((t) => t + 1);
    } catch (err) {
      log.warn('Comment post failed', { recordType, error: err }, 'comments');
      setPostError(apiErrorMessage(err, 'Could not post the comment - try again'));
    } finally {
      setBusy(false);
    }
  }

  const people = read?.mentionable ?? [];
  return (
    <section aria-labelledby={`comments-${recordId}`} className="space-y-3" data-testid="comments-panel">
      <h3 id={`comments-${recordId}`} className="text-sm font-semibold text-[var(--ff-text-primary)]">Comments</h3>
      {loadError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}
      {!read && !loadError && <p className="text-sm text-[var(--ff-text-secondary)]">Loading comments…</p>}
      {read && read.olderHidden > 0 && (
        <p className="text-xs text-[var(--ff-text-secondary)]">{read.olderHidden} older comments are not shown.</p>
      )}
      {read && read.comments.length === 0 && <p className="text-sm text-[var(--ff-text-secondary)]">No comments yet.</p>}
      {read && read.comments.length > 0 && (
        <ul className="space-y-2">
          {read.comments.map((c) => (
            <CommentItem key={c.id} comment={c} mine={c.authorId === user?.id && canWrite(companyRole)} people={people} onChanged={(deleted) => { void load().then(() => { if (deleted) setFocusTick((t) => t + 1); }); }} />
          ))}
        </ul>
      )}
      {read && canWrite(companyRole) && (
        <CommentComposer key={composerKey} textareaRef={(el) => { composer.current = el; }} label="Add a comment" people={people} submitLabel="Comment" busy={busy}
          error={postError} onSubmit={(body, mentions) => void post(body, mentions)} />
      )}
    </section>
  );
}
