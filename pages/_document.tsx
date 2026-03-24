import { Html, Head, Main, NextScript } from 'next/document';

/**
 * Custom Document component
 * Sets base HTML structure, language, and font preloading
 */
export default function Document() {
  return (
    <Html lang="en" className="h-full">
      <Head>
        {/* Inter font from Google Fonts */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <meta name="application-name" content="FibreFlow Accounting" />
      </Head>
      <body className="h-full antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
