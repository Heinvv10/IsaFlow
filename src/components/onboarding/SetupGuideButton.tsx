/**
 * SetupGuideButton — header bar button that opens the setup guide drawer.
 * Shows remaining task count badge. Pulses for new users (first 3 days).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckSquare } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { cn } from '@/utils/cn';
import { SetupGuideDrawer } from './SetupGuideDrawer';
import { TOTAL_TASK_COUNT } from './setupGuideConfig';

// ─── Preference key constants ─────────────────────────────────────────────────

const PREF_MANUAL_KEY = 'setup-guide-manual-done';
const PREF_CREATED_AT_KEY = 'setup-guide-first-seen';
const NEW_USER_PULSE_DAYS = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

interface SetupGuideApiResponse {
  completedTasks: string[];
}

interface PreferencesApiResponse {
  [key: string]: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseManualDone(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed as string[]);
  } catch {
    // malformed — ignore
  }
  return new Set();
}

function isNewUser(firstSeenRaw: string | undefined): boolean {
  if (!firstSeenRaw) return true;
  const firstSeen = new Date(firstSeenRaw);
  if (isNaN(firstSeen.getTime())) return true;
  const daysSince = (Date.now() - firstSeen.getTime()) / (1000 * 60 * 60 * 24);
  return daysSince <= NEW_USER_PULSE_DAYS;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SetupGuideButton() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [autoCompleted, setAutoCompleted] = useState<Set<string>>(new Set());
  const [manualDone, setManualDone] = useState<Set<string>>(new Set());
  const [pulse, setPulse] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState('');
  // The ticks as the person made them, read at send time: a closed-over copy would let two quick ticks write
  // a smaller set. `saveQueue` sends one write after another, so a later write can never land before an earlier one.
  const manualRef = useRef<Set<string>>(new Set());
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  // Load both auto-detected status and manual completions
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [guideRes, prefRes] = await Promise.all([
          apiFetch('/api/accounting/setup-guide'),
          apiFetch('/api/auth/preferences'),
        ]);

        if (cancelled) return;

        // Unknown state must not render as 'every task still to do': hide the guide instead
        if (!guideRes.ok || !prefRes.ok) {
          setLoadFailed(true);
          return;
        }
        {
          const guideJson = (await guideRes.json()) as { data: SetupGuideApiResponse };
          setAutoCompleted(new Set(guideJson.data.completedTasks));
        }

        {
          const prefJson = (await prefRes.json()) as { data: PreferencesApiResponse };
          const prefs = prefJson.data;
          manualRef.current = parseManualDone(prefs[PREF_MANUAL_KEY]);
          setManualDone(manualRef.current);
          setPulse(isNewUser(prefs[PREF_CREATED_AT_KEY]));

          // Record first-seen timestamp if not already set
          if (!prefs[PREF_CREATED_AT_KEY]) {
            // Pure telemetry: a missed write only means the new-user pulse restarts next visit
            apiFetch('/api/auth/preferences', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                preferences: { [PREF_CREATED_AT_KEY]: new Date().toISOString() },
              }),
            }).then((r) => assertOk(r, 'Could not record the first visit')).catch((err: unknown) => log.warn('setup guide first-seen write failed', { err }));
          }
        }
      } catch (err) {
        log.warn('setup guide load failed', { err });
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, []);

  const completedTasks = new Set([...autoCompleted, ...manualDone]);
  const remainingCount = TOTAL_TASK_COUNT - completedTasks.size;

  const handleMarkDone = useCallback((taskId: string): Promise<void> => {
    manualRef.current = new Set(manualRef.current).add(taskId);
    setManualDone(manualRef.current);
    setSaveError('');
    const save = async () => {
      try {
        const res = await apiFetch('/api/auth/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preferences: { [PREF_MANUAL_KEY]: JSON.stringify([...manualRef.current]) } }),
        });
        await assertOk(res, 'Could not save that task - try again');
      } catch (err) {
        // Not saved: take back only THIS tick so the guide never shows a task done that will be undone on reload
        const rest = new Set(manualRef.current); rest.delete(taskId);
        manualRef.current = rest;
        setManualDone(rest);
        setSaveError(apiErrorMessage(err, 'Could not save that task - try again'));
      }
    };
    saveQueue.current = saveQueue.current.then(save);
    return saveQueue.current;
  }, []);

  if (!loaded || loadFailed) return null;

  return (
    <>
      <button
        onClick={() => setDrawerOpen(true)}
        className={cn(
          'relative p-2 rounded-lg transition-colors',
          'text-gray-400 hover:text-gray-900 dark:hover:text-white',
          'hover:bg-gray-100 dark:hover:bg-gray-700/50',
          pulse && remainingCount > 0 && 'animate-pulse',
        )}
        title="Setup guide"
        aria-label={`Setup guide — ${remainingCount} tasks remaining`}
      >
        <CheckSquare className="w-4 h-4" />

        {/* Remaining count badge */}
        {remainingCount > 0 && (
          <span
            aria-hidden="true"
            className={cn(
              'absolute -top-0.5 -right-0.5',
              'min-w-[16px] h-4 px-1',
              'bg-brand-600 text-white text-[10px] font-bold rounded-full',
              'flex items-center justify-center leading-none',
            )}
          >
            {remainingCount > 99 ? '99+' : remainingCount}
          </span>
        )}
      </button>

      {saveError && (
        <div role="alert" className="fixed bottom-4 right-4 z-[60] rounded-lg bg-red-600 px-3 py-2 text-sm text-white shadow-lg">
          {saveError}
        </div>
      )}
      <SetupGuideDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        completedTasks={completedTasks}
        onMarkDone={(id) => { void handleMarkDone(id); }}
      />
    </>
  );
}
