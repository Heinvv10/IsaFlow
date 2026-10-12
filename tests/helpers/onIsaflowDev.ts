/**
 * Whether DATABASE_URL opens isaflow_dev: the one database holding the real
 * tenants (ISAFlow Demo, Brightsphere, Sample Trading) and the posted history
 * a few report suites assert on. Anywhere else, including the disposable
 * databases of the CI integration gate (scripts/ci/integration/run.sh), those
 * suites skip; each says so in a `ci-integration-skip:` comment, which the
 * gate prints, and this says so on stderr for a run by hand.
 */
export function onIsaflowDev(url: string | undefined = process.env.DATABASE_URL): boolean {
  const onDev = !!url && URL.canParse(url) && new URL(url).pathname.replace(/^\//, '') === 'isaflow_dev';
  if (!onDev) {
    process.stderr.write("[skip] DATABASE_URL does not name isaflow_dev: this suite reads dev's real tenants "
      + 'and posted history, so it skips.\n');
  }
  return onDev;
}
