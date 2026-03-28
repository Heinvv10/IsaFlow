import { Html, Head, Main, NextScript } from 'next/document';

/**
 * Custom Document component
 * Sets base HTML structure, language, and font configuration
 */
export default function Document() {
  return (
    <Html lang="en" className="h-full">
      <Head>
        <meta name="application-name" content="IsaFlow" />
        <meta name="theme-color" content="#14b8a6" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="IsaFlow" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
      </Head>
      <body className="h-full antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
