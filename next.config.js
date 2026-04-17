/** @type {import('next').NextConfig} */

const cspDev = "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.isaflow.co.za https://*.gravatar.com; font-src 'self' data:; connect-src 'self' https://api.anthropic.com https://*.sageone.co.za https://*.isaflow.co.za https://*.cloudflare.com https://cloudflareinsights.com http://localhost:3101 http://localhost:3004; frame-src 'self' https://signum.brighttech.co.za; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests";
const cspProd = "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.isaflow.co.za https://*.gravatar.com; font-src 'self' data:; connect-src 'self' https://api.anthropic.com https://*.sageone.co.za https://*.isaflow.co.za https://*.cloudflare.com https://cloudflareinsights.com https://static.cloudflareinsights.com; frame-src 'self' https://signum.brighttech.co.za; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests";

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  output: 'standalone',
  productionBrowserSourceMaps: process.env.SENTRY_ENABLED === 'true',

  eslint: {
    ignoreDuringBuilds: true,
  },

  experimental: {
    optimizePackageImports: ['lucide-react', 'recharts'],
  },

  // Backward-compatibility redirects for deleted shim pages
  async redirects() {
    return [
      { source: '/accounting/audit-trail', destination: '/accounting/reports/audit-trail', permanent: true },
      { source: '/accounting/bank-rules', destination: '/accounting/bank-reconciliation/rules', permanent: true },
      { source: '/accounting/data-import', destination: '/accounting/sage-migration', permanent: true },
      { source: '/accounting/vat-return', destination: '/accounting/reports/vat-return', permanent: true },
      { source: '/accounting/reports/customer', destination: '/accounting/reports/customer-reports', permanent: true },
      { source: '/accounting/reports/supplier', destination: '/accounting/reports/supplier-reports', permanent: true },
      { source: '/accounting/reports/trial-balance', destination: '/accounting/trial-balance', permanent: true },
      { source: '/accounting/balance-sheet', destination: '/accounting/reports/balance-sheet', permanent: true },
      { source: '/accounting/income-statement', destination: '/accounting/reports/income-statement', permanent: true },
      { source: '/accounting/quotes', destination: '/accounting/customer-quotes', permanent: false },
      { source: '/accounting/sales-orders', destination: '/accounting/customer-sales-orders', permanent: false },
      { source: '/accounting/sars/vat-adjustments', destination: '/accounting/vat-adjustments', permanent: true },
      // Nav menu roots — ensure clicking a top-level menu label never 404s
      { source: '/accounting/banking', destination: '/accounting/bank-accounts', permanent: false },
      { source: '/accounting/vat', destination: '/accounting/reports/vat-return', permanent: false },
      { source: '/payroll', destination: '/payroll/employees', permanent: false },
      { source: '/payroll/dashboard', destination: '/payroll/employees', permanent: false },
      { source: '/payroll/runs', destination: '/payroll/employees', permanent: false },
    ];
  },

  // Security headers
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
          { key: 'Content-Security-Policy', value: process.env.NODE_ENV === 'production' ? cspProd : cspDev },
        ],
      },
    ];
  },

  // Webpack config
  webpack: (config, { isServer, dev }) => {
    // Prevent corrupted on-disk chunk cache that causes "Cannot find module" errors.
    // Using memory cache in all modes avoids stale pack files between builds.
    config.cache = { type: 'memory' };
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
        async_hooks: false,
      };
    }
    return config;
  },
};

const { withSentryConfig } = require('@sentry/nextjs');

module.exports = withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  url: process.env.SENTRY_URL,
  silent: !process.env.CI,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },
  hideSourceMaps: true,
  disableLogger: true,
});
