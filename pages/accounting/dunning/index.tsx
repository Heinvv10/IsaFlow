/**
 * Legacy /accounting/dunning route — superseded by PRD-06 Phase 5.
 *
 * The old dunning_communications stack was retired when the
 * dunning_templates + dunning_sends engine shipped. This page exists
 * only to redirect bookmarks and any stale nav links to the current
 * surface. Safe to delete once external bookmarks are confirmed dead.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/router';

export default function LegacyDunningRedirect() {
  const router = useRouter();
  useEffect(() => {
    void router.replace('/accounting/ar/dunning/runs');
  }, [router]);
  return null;
}
