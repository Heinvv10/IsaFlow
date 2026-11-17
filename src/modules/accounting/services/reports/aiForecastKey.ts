/**
 * Whether the AI cash flow forecast can run: the Anthropic key is set. The same test cashFlowForecastAiService
 * makes before it calls the API (`process.env.ANTHROPIC_API_KEY`, empty = not set). The Cash Flow Forecast page's
 * getServerSideProps uses it to show "AI forecast unavailable" instead of a request that would fail. No imports:
 * safe in a page module.
 */
export function aiForecastConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
