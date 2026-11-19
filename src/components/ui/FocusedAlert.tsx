/**
 * An error alert that moves into view and takes focus when its message appears or changes (UI review #1620 M1): after
 * a failed save the message sits above the form, under the sticky header, and a keyboard or screen-reader user would
 * otherwise stay on the button with no sign of what went wrong.
 */
import { useEffect, useRef } from 'react';

export function FocusedAlert({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!message || !ref.current) return;
    ref.current.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    ref.current.focus({ preventScroll: true });
  }, [message]);
  if (!message) return null;
  return (
    <div ref={ref} role="alert" tabIndex={-1}
      className="scroll-mt-32 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-400 text-sm outline-none focus:ring-2 focus:ring-red-500/40">
      {message}
    </div>
  );
}
