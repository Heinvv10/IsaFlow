/** @type {import('next').NextConfig} */

const cspDev = "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.isaflow.co.za https://*.gravatar.com; font-src 'self' data:; connect-src 'self' https://api.anthropic.com https://*.sageone.co.za https://*.isaflow.co.za https://*.cloudflare.com http://localhost:3101 http://localhost:3004; frame-ancestors 'none'";
const cspProd = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.isaflow.co.za https://*.gravatar.com; font-src 'self' data:; connect-src 'self' https://api.anthropic.com https://*.sageone.co.za https://*.isaflow.co.za https://*.cloudflare.com; frame-ancestors 'none'";

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  output: 'standalone',
  productionBrowserSourceMaps: false,

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
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;
