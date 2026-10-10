/**
 * Loads entity change history from GET /api/accounting/entity-changes, newest
 * first, one page at a time (`loadMore` follows nextCursor). `apiFetch`
 * resolves on a 4xx, so every response goes through assertOk; a 403 (a role
 * that may not read this history) is shown as its message, never as "no
 * changes".
 */
import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import type { EntityChangePage, EntityChangeView, EntityType } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';

export interface EntityChangesQuery {
  entityType?: EntityType;
  entityId?: string;
}

const FAILED = 'Could not load the change history - try again';

async function fetchPage(query: EntityChangesQuery, before: string | null): Promise<EntityChangePage> {
  const params = new URLSearchParams();
  if (query.entityType) params.set('entityType', query.entityType);
  if (query.entityId) params.set('entityId', query.entityId);
  if (before) params.set('before', before);
  const res = await apiFetch(`/api/accounting/entity-changes?${params.toString()}`);
  await assertOk(res, FAILED);
  const data = ((await res.json()) as { data?: EntityChangePage }).data;
  if (!data || !Array.isArray(data.items)) throw new Error(FAILED);
  return data;
}

export function useEntityChanges(query: EntityChangesQuery) {
  const { entityType, entityId } = query;
  const [items, setItems] = useState<EntityChangeView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (before: string | null) => {
    setLoading(true);
    try {
      const page = await fetchPage({ entityType, entityId }, before);
      setItems((prev) => (before ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setError('');
    } catch (err) {
      if (!before) setItems([]);
      setError(apiErrorMessage(err, FAILED));
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  useEffect(() => { void load(null); }, [load]);

  /** Replaces one change in place (after a reveal). */
  const replace = useCallback((change: EntityChangeView) => {
    setItems((prev) => prev.map((c) => (c.id === change.id ? change : c)));
  }, []);

  return {
    items, loading, error, replace,
    hasMore: cursor !== null,
    loadMore: () => { if (cursor) void load(cursor); },
    reload: () => { void load(null); },
  };
}
