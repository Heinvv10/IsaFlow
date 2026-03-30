/**
 * useKeyboardShortcuts
 *
 * Registers a list of ShortcutConfig entries as global keydown listeners.
 *
 * Behaviour:
 * - Non-modifier shortcuts ('?', 'j', 'k', sequence keys) are suppressed when
 *   focus is inside an <input>, <textarea>, <select>, or [contenteditable].
 * - Modifier shortcuts (ctrl+k, ctrl+n, etc.) fire regardless of focus target.
 * - Two-key sequences ('g d'): the first key starts a 1-second timer; pressing
 *   the second key within that window fires the action.
 * - Shortcuts with `enabled === false` are silently skipped.
 * - Listener is cleaned up on unmount / when the shortcuts array changes.
 */

import { useEffect, useRef } from 'react';
import type { ShortcutConfig } from '@/lib/keyboard-shortcuts';
import { parseShortcut, matchesShortcut } from '@/lib/keyboard-shortcuts';

const SEQUENCE_TIMEOUT_MS = 1000;

// Elements that capture text input — non-modifier shortcuts are blocked here
function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useKeyboardShortcuts(shortcuts: ShortcutConfig[]): void {
  // We use a ref so the handler always sees the latest shortcuts list without
  // needing to re-attach the listener every render.
  const shortcutsRef = useRef<ShortcutConfig[]>(shortcuts);
  useEffect(() => {
    shortcutsRef.current = shortcuts;
  }, [shortcuts]);

  // Sequence tracking: first key pressed + when
  const sequenceStateRef = useRef<{ key: string; at: number } | null>(null);
  const sequenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const inTextField = isTextTarget(event.target);

      for (const config of shortcutsRef.current) {
        if (config.enabled === false) continue;

        const parsed = parseShortcut(config.key);

        // ── Sequence shortcut (e.g. 'g d') ──────────────────────────────
        if (parsed.isSequence) {
          // Sequences never fire while typing in a text field
          if (inTextField) continue;

          const [firstKey, secondKey] = parsed.keys;
          const now = Date.now();
          const eventKey = event.key.toLowerCase();

          const state = sequenceStateRef.current;
          if (state && state.key === firstKey && now - state.at <= SEQUENCE_TIMEOUT_MS) {
            // We are in a sequence and this event is the second key
            if (eventKey === secondKey) {
              event.preventDefault();
              // Clear sequence state
              if (sequenceTimerRef.current) {
                clearTimeout(sequenceTimerRef.current);
                sequenceTimerRef.current = null;
              }
              sequenceStateRef.current = null;
              config.action();
            }
            // Whether it matched or not, we consumed the sequence state for
            // any matching first key — break to avoid double-action
            continue;
          }

          // Check if this is the first key of any sequence
          if (eventKey === firstKey) {
            // Don't preventDefault here — the first key ('g') may be typed
            // in a non-sequence context; only suppress if we are confident
            sequenceStateRef.current = { key: firstKey, at: now };

            if (sequenceTimerRef.current) clearTimeout(sequenceTimerRef.current);
            sequenceTimerRef.current = setTimeout(() => {
              sequenceStateRef.current = null;
              sequenceTimerRef.current = null;
            }, SEQUENCE_TIMEOUT_MS);
          }

          continue;
        }

        // ── Single / modifier shortcut ───────────────────────────────────
        const hasModifier = parsed.ctrl || parsed.meta || parsed.alt;

        // Non-modifier shortcuts are blocked when typing
        if (!hasModifier && inTextField) continue;

        if (matchesShortcut(event, parsed)) {
          event.preventDefault();
          config.action();
          // Stop after the first match to avoid multiple actions for the same key
          break;
        }
      }
    };

    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      if (sequenceTimerRef.current) {
        clearTimeout(sequenceTimerRef.current);
        sequenceTimerRef.current = null;
      }
      sequenceStateRef.current = null;
    };
  }, []); // Empty deps — handler always reads the latest shortcuts via ref
}
