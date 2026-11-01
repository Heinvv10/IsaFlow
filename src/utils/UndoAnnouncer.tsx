/**
 * The polite live region for undoable toasts, mounted once in _app. A screen reader reads a live region's CHANGES, and
 * a region that arrives with its text in it is no change: a toast cannot be its own. The keyed span makes the same
 * sentence twice in a row a change too. The words leave when the offer does, or a reader walking the page finds them
 * after it has gone.
 */

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

interface Said { n: number; text: string }

let say: Dispatch<SetStateAction<Said>> | null = null;
let count = 0;

/** Says `text`. The returned function takes it back, unless a newer offer has spoken since. */
export function announceUndo(text: string): () => void {
  const n = ++count;
  say?.({ n, text });
  return () => say?.((prev) => (prev.n === n ? { n, text: '' } : prev));
}

export function UndoAnnouncer() {
  const [said, setSaid] = useState<Said>({ n: 0, text: '' });
  useEffect(() => {
    say = setSaid;
    return () => { say = null; };
  }, []);
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {said.text && <span key={said.n}>{said.text}</span>}
    </div>
  );
}
