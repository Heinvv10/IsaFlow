/**
 * Shared dashboard stats hook — deduplicates the /api/accounting/dashboard-stats fetch
 * so all dashboard widgets share a single network request.
 */

import { useEffect, useState, useRef } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DashboardData = Record<string, any>;

interface DashboardStatsState {
  data: DashboardData | null;
  loading: boolean;
  error: string | null;
}

// Module-level cache so all widget instances share one in-flight request
let cachedPromise: Promise<DashboardData | null> | null = null;
let cachedData: DashboardData | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

function fetchStats(): Promise<DashboardData | null> {
  const now = Date.now();
  if (cachedData && now - cacheTimestamp < CACHE_TTL_MS) {
    return Promise.resolve(cachedData);
  }
  if (cachedPromise) return cachedPromise;

  cachedPromise = apiFetch('/api/accounting/dashboard-stats')
    .then(async (res) => {
      const json = (await res.json()) as { data?: DashboardData };
      cachedData = json.data ?? null;
      cacheTimestamp = Date.now();
      cachedPromise = null;
      return cachedData;
    })
    .catch((err) => {
      cachedPromise = null;
      log.error('Dashboard stats fetch failed', { error: err }, 'dashboard-hook');
      throw err;
    });

  return cachedPromise;
}

export function useDashboardStats(): DashboardStatsState {
  const [state, setState] = useState<DashboardStatsState>({
    data: cachedData,
    loading: !cachedData,
    error: null,
  });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (cachedData && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
      setState({ data: cachedData, loading: false, error: null });
      return;
    }

    fetchStats()
      .then((data) => {
        if (mounted.current) setState({ data, loading: false, error: null });
      })
      .catch(() => {
        if (mounted.current) setState({ data: null, loading: false, error: 'Unable to load dashboard data' });
      });

    return () => { mounted.current = false; };
  }, []);

  return state;
}
