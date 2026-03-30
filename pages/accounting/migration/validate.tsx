import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, AlertCircle, Loader2, ShieldCheck, PartyPopper } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface ValidationCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

interface ValidationResult {
  sessionId: string;
  checks: ValidationCheck[];
  allPassed: boolean;
}

export default function ValidatePage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCompleting, setIsCompleting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState('');

  const loadSession = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/migration/session');
      const json = await res.json();
      if (!res.ok || !json.data) {
        setError('No active migration session found');
        return;
      }
      setSessionId(json.data.id);
      if (json.data.status === 'completed') setCompleted(true);
      return json.data.id as string;
    } catch {
      setError('Failed to load session');
    }
    return null;
  }, []);

  const runValidation = useCallback(async (sid: string) => {
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/migration/validate?sessionId=${sid}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Validation failed');
      setValidation(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation failed');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSession().then(sid => {
      if (sid) runValidation(sid);
      else setIsLoading(false);
    });
  }, [loadSession, runValidation]);

  const completeMigration = async () => {
    if (!sessionId) return;
    setIsCompleting(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/migration/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, action: 'complete' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to complete migration');
      setCompleted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete migration');
    } finally {
      setIsCompleting(false);
    }
  };

  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href="/accounting/migration" className="flex items-center gap-2 text-blue-600 hover:text-blue-800 mb-6 text-sm">
          <ArrowLeft className="h-4 w-4" /> Back to Migration Hub
        </Link>
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 rounded-lg bg-teal-500/10">
            <ShieldCheck className="h-6 w-6 text-teal-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Validation & Go-Live</h1>
            <p className="text-sm text-[var(--ff-text-secondary)]">Verify your migration data before activating ISAFlow</p>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}

        {completed ? (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-8 text-center">
            <PartyPopper className="h-12 w-12 text-teal-400 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-[var(--ff-text-primary)] mb-2">Migration Complete!</h2>
            <p className="text-[var(--ff-text-secondary)] mb-6">Your data has been successfully migrated to ISAFlow.</p>
            <div className="flex justify-center gap-3">
              <Link href="/accounting" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
                Go to Dashboard
              </Link>
              <Link href="/accounting/chart-of-accounts" className="px-4 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] rounded-lg hover:bg-[var(--ff-bg-primary)] text-sm">
                View Chart of Accounts
              </Link>
            </div>
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
            <span className="ml-2 text-[var(--ff-text-secondary)]">Running validation checks...</span>
          </div>
        ) : validation ? (
          <div className="space-y-4">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between">
                <h2 className="font-semibold text-[var(--ff-text-primary)]">Validation Checks</h2>
                <button
                  onClick={() => sessionId && runValidation(sessionId)}
                  className="text-xs text-blue-500 hover:text-blue-400"
                >
                  Re-run
                </button>
              </div>
              <div className="divide-y divide-[var(--ff-border-light)]">
                {validation.checks.map(check => (
                  <div key={check.id} className="flex items-start gap-3 px-5 py-4">
                    {check.passed
                      ? <CheckCircle2 className="h-5 w-5 text-teal-400 mt-0.5 shrink-0" />
                      : <AlertCircle className="h-5 w-5 text-red-400 mt-0.5 shrink-0" />
                    }
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--ff-text-primary)]">{check.label}</p>
                      {check.detail && <p className="text-xs text-[var(--ff-text-secondary)] mt-0.5">{check.detail}</p>}
                    </div>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${check.passed ? 'bg-teal-500/20 text-teal-400' : 'bg-red-500/20 text-red-400'}`}>
                      {check.passed ? 'Pass' : 'Fail'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {!validation.allPassed && (
              <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm text-amber-400">
                <p className="font-medium mb-1">Some checks failed</p>
                <p>Please resolve the issues above before completing your migration. Return to the relevant steps to fix them.</p>
              </div>
            )}

            <div className="flex justify-end">
              <button
                onClick={completeMigration}
                disabled={isCompleting || !validation.allPassed}
                className="flex items-center gap-2 px-6 py-2.5 bg-teal-600 text-white rounded-lg hover:bg-teal-500 disabled:opacity-50 font-medium"
              >
                {isCompleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Complete Migration
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </AppLayout>
  );
}
