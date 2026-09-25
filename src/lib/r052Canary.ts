// R-052 canary: never merged. A balance query filtering is_active trips only
// the is-active-filters gate, which GitHub's CI job does not run.
export const r052Canary = `SELECT SUM(balance) FROM gl_accounts WHERE is_active = true`;
