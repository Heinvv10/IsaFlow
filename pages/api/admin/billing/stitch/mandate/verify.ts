// Back-compat shim — pentest H10. These are tenant self-service routes (manage
// own billing mandate), not platform admin routes. Canonical path is now
// /api/billing/stitch/mandate/verify; this file is kept for clients that
// haven't migrated yet. Remove after all call sites are updated.
export { default } from '../../../../billing/stitch/mandate/verify';
