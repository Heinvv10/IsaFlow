// pages/accounting/afs/[documentId]/compliance.tsx
// Compliance dashboard: PIS score, compliance check results, CIPC filing guide, active alerts.

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { AlertTriangle, XCircle, FileCheck, ShieldCheck, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { useRouter } from 'next/router';
import type { PisScore, ComplianceResult, CipcFilingGuide, AfsComplianceAlert } from '@/modules/accounting/services/afs/afsTypes';
import { ScoreRing, IssueList, CipcGuideSection, AlertsSection } from './compliance-sections';

export default function CompliancePage() {
  const router = useRouter();
  const documentId = typeof router.query.documentId === 'string' ? router.query.documentId : '';

  const [pisScore, setPisScore] = useState<PisScore | null>(null);
  const [complianceResult, setComplianceResult] = useState<ComplianceResult | null>(null);
  const [cipcGuide, setCipcGuide] = useState<CipcFilingGuide | null>(null);
  const [alerts, setAlerts] = useState<AfsComplianceAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningCheck, setRunningCheck] = useState(false);
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    setError('');
    try {
      const [pisRes, guideRes, alertsRes] = await Promise.all([
        apiFetch(`/api/accounting/afs/${documentId}/pis-score`, { credentials: 'include' }),
        apiFetch(`/api/accounting/afs/${documentId}/cipc-filing-guide`, { credentials: 'include' }),
        apiFetch('/api/accounting/compliance-alerts', { credentials: 'include' }),
      ]);
      const [pisJson, guideJson, alertsJson] = await Promise.all([
        pisRes.json() as Promise<{ data?: PisScore; error?: { message?: string } }>,
        guideRes.json() as Promise<{ data?: CipcFilingGuide; error?: { message?: string } }>,
        alertsRes.json() as Promise<{ data?: { alerts?: AfsComplianceAlert[] }; error?: { message?: string } }>,
      ]);
      if (!pisRes.ok) throw new Error(pisJson.error?.message ?? 'Failed to load PIS score');
      if (!guideRes.ok) throw new Error(guideJson.error?.message ?? 'Failed to load CIPC guide');
      if (pisJson.data) setPisScore(pisJson.data);
      if (guideJson.data) setCipcGuide(guideJson.data);
      if (alertsRes.ok && alertsJson.data?.alerts) {
        setAlerts(
          (alertsJson.data.alerts as AfsComplianceAlert[]).filter(
            a => a.alertType?.startsWith('pis_') || a.alertType?.startsWith('afs_')
          )
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load compliance data');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => { void loadData(); }, [loadData]);

  async function handleRunCheck() {
    if (!documentId) return;
    setRunningCheck(true);
    try {
      const res = await apiFetch(`/api/accounting/afs/${documentId}/compliance-check`, {
        method: 'POST', credentials: 'include',
      });
      const json = await res.json() as { data?: ComplianceResult; error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? 'Compliance check failed');
      if (json.data) setComplianceResult(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compliance check failed');
    } finally {
      setRunningCheck(false);
    }
  }

  async function handleDismissAlert(alertId: string) {
    try {
      await apiFetch('/api/accounting/compliance-alerts', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId }),
      });
      setAlerts(prev => prev.filter(a => a.id !== alertId));
    } catch { /* non-critical */ }
  }

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="flex items-center gap-2 mb-1 text-sm text-gray-500">
          <Link href="/accounting/afs" className="hover:text-gray-800">AFS</Link>
          <ChevronRight className="w-3 h-3" />
          <Link href={`/accounting/afs/${documentId}`} className="hover:text-gray-800">Document</Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-gray-800 font-medium">Compliance</span>
        </div>
        <h1 className="text-2xl font-black text-gray-900 mb-6">IFRS Compliance</h1>

        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 flex gap-3 items-start">
            <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {loading && (
          <div className="animate-pulse space-y-6">
            {[1, 2, 3].map(i => <div key={i} className="h-32 bg-gray-100 rounded-xl" />)}
          </div>
        )}

        {!loading && (
          <div className="space-y-8">
            {/* PIS Score Card */}
            {pisScore && (
              <section className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
                <div className="flex items-center gap-2 mb-4">
                  <ShieldCheck className="w-5 h-5 text-indigo-600" />
                  <h2 className="text-lg font-bold text-gray-900">Public Interest Score</h2>
                </div>
                <div className="flex items-start gap-8">
                  <div>
                    <ScoreRing score={Math.round(pisScore.total)} />
                    <p className="text-xs text-gray-500 mt-1">Total PIS</p>
                  </div>
                  <div className="flex-1 grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-gray-500">Framework</p>
                      <p className="font-semibold text-gray-900">
                        {pisScore.requiredFramework === 'full_ifrs' ? 'Full IFRS' : 'IFRS for SMEs'}
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-500">Audit Level</p>
                      <p className="font-semibold text-gray-900">
                        {pisScore.requiredAudit === 'mandatory_audit' ? 'Mandatory Audit' :
                         pisScore.requiredAudit === 'independent_review' ? 'Independent Review' : 'Voluntary'}
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-500">Turnover points</p>
                      <p className="font-mono text-gray-900">{pisScore.turnoverPoints.toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Liability points</p>
                      <p className="font-mono text-gray-900">{pisScore.liabilityPoints.toFixed(2)}</p>
                    </div>
                  </div>
                </div>
                {pisScore.dataUnavailable.length > 0 && (
                  <div className="mt-4 flex gap-2 items-center text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>Score is partial — data unavailable: <strong>{pisScore.dataUnavailable.join(', ')}</strong></span>
                  </div>
                )}
              </section>
            )}

            {/* Compliance Check */}
            <section className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <FileCheck className="w-5 h-5 text-indigo-600" />
                  <h2 className="text-lg font-bold text-gray-900">Compliance Check</h2>
                </div>
                <button
                  onClick={() => { void handleRunCheck(); }}
                  disabled={runningCheck}
                  className="text-sm font-semibold px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60 transition-colors"
                >
                  {runningCheck ? 'Running…' : 'Run Check'}
                </button>
              </div>
              {!complianceResult && !runningCheck && (
                <p className="text-sm text-gray-500">Click Run Check to analyse this document for IFRS compliance issues.</p>
              )}
              {complianceResult && (
                <div>
                  <div className="flex items-center gap-6 mb-6">
                    <ScoreRing score={complianceResult.score} />
                    <div className="flex gap-4 text-sm">
                      <div className="text-center">
                        <p className="text-2xl font-black text-red-600">{complianceResult.blockerCount}</p>
                        <p className="text-gray-500">Blockers</p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-black text-amber-500">{complianceResult.warningCount}</p>
                        <p className="text-gray-500">Warnings</p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-black text-green-600">{complianceResult.passedCount}</p>
                        <p className="text-gray-500">Passed</p>
                      </div>
                    </div>
                  </div>
                  <IssueList result={complianceResult} />
                </div>
              )}
            </section>

            {cipcGuide && <CipcGuideSection guide={cipcGuide} />}
            <AlertsSection alerts={alerts} onDismiss={(id) => { void handleDismissAlert(id); }} />
          </div>
        )}
      </div>
    </AppLayout>
  );
}
