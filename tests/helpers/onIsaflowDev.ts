/**
 * Whether DATABASE_URL opens isaflow_dev: the one database holding the real
 * tenants (ISAFlow Demo, Brightsphere, Sample Trading) and the posted history
 * a few report suites assert on. Anywhere else, including the disposable
 * databases of the CI integration gate (scripts/ci/integration/run.sh), those
 * suites skip; each says so in a `ci-integration-skip:` comment, which the
 * gate prints.
 */
export function onIsaflowDev(url: string | undefined = process.env.DATABASE_URL): boolean {
  if (!url || !URL.canParse(url)) return false;
  return new URL(url).pathname.replace(/^\//, '') === 'isaflow_dev';
}
