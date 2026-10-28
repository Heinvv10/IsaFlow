import Image from 'next/image';
import type { ReactNode } from 'react';

interface FigureProps {
  caption?: ReactNode;
  children: ReactNode;
}

/** Wraps any content (image, chart, table) with an optional caption. */
export function Figure({ caption, children }: FigureProps) {
  return (
    <figure className="not-prose my-10">
      {children}
      {caption && <figcaption className="mt-3 text-center text-sm text-slate-600">{caption}</figcaption>}
    </figure>
  );
}

interface ScreenshotProps {
  src: string;
  alt: string;
  caption?: string;
  /** Intrinsic size; defaults to 1600x900. Pass the real size for non-16:9 screenshots. */
  width?: number;
  height?: number;
}

/** A product screenshot via next/image (WebP, responsive srcset, lazy). */
export function Screenshot({ src, alt, caption, width = 1600, height = 900 }: ScreenshotProps) {
  if (!src || !src.startsWith('/')) throw new Error(`Invalid <Screenshot src="${src}">: use a site path such as /blog/<slug>/shot.webp`);
  if (!alt) throw new Error(`Invalid <Screenshot src="${src}">: alt is required`);
  return (
    <Figure caption={caption}>
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-lg shadow-slate-900/5">
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          sizes="(min-width: 768px) 768px, 100vw"
          style={{ width: '100%', height: 'auto' }}
        />
      </div>
    </Figure>
  );
}
