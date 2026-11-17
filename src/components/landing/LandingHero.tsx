import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { APP_URL } from './landingData';
import { HERO_MEDIA } from './riverMedia';
import { useRiverVideoAllowed } from './useRiverMotion';

const SUPPORTING_LINE =
  'For accounting bureaus and practices running books and payroll for many clients, and for the '
  + 'businesses they look after: invoicing, bank statement import and reconciliation, VAT201 and '
  + 'EMP201 preparation, and payroll with PAYE, UIF and SDL.';

const TRUST_POINTS = [
  'No credit card required',
  'VAT201 and EMP201 prepared for you to file on eFiling',
  'Statement import: CSV, OFX, QFX, QIF, MT940 and PDF',
] as const;

/** Phones: holds through the stacked copy and CTAs, then lets go of the bottom water. */
const MOBILE_SCRIM =
  'linear-gradient(180deg, rgba(7,26,36,0.68) 0%, rgba(7,26,36,0.58) 22%, rgba(7,26,36,0.62) 74%, '
  + 'rgba(7,26,36,0.28) 90%, rgba(7,26,36,0.08) 100%)';

/** Wide screens: left wash behind the copy column, clear from 60% (800px floor) across the river. */
const DESKTOP_SCRIM =
  'linear-gradient(90deg, rgba(7,26,36,0.90) 0%, rgba(7,26,36,0.74) 30%, '
  + 'rgba(7,26,36,0.28) max(48%, 620px), rgba(7,26,36,0) max(60%, 800px))';

/**
 * Ends the desktop wash just below the copy. The copy block is centred 24px below the middle of the
 * hero and its trust line ends about 282px below it, so the offsets are in px from 50%. Change them
 * if the copy block's height changes.
 */
const DESKTOP_SCRIM_MASK =
  'linear-gradient(180deg, #000 0%, #000 calc(50% + 200px), rgba(0,0,0,0.5) calc(50% + 300px), '
  + 'transparent calc(50% + 440px))';

/** Seconds before the intro ends at which the loop starts buffering in full. */
const LOOP_WARM_SECONDS = 3;

/**
 * River hero. Dark in both themes (fixed colours, data-surface="dark"). The still image is in the
 * server HTML; the intro (plays once, night to day) and the seamless loop are added on the client
 * only when useRiverVideoAllowed() says so.
 */
export function LandingHero() {
  const videoAllowed = useRiverVideoAllowed();
  const [failed, setFailed] = useState(false);
  const [phase, setPhase] = useState<'intro' | 'loop'>('intro');
  const [loopWarm, setLoopWarm] = useState(false);
  const introRef = useRef<HTMLVideoElement>(null);
  const loopRef = useRef<HTMLVideoElement>(null);
  const showVideo = videoAllowed && !failed;

  useEffect(() => {
    const v = introRef.current;
    if (!showVideo || !v) return;
    // React's `muted` prop can reach the element after autoplay is evaluated; set it directly.
    v.muted = true;
    void v.play().catch(() => setFailed(true));
  }, [showVideo]);

  // The videos unmount when a visitor narrows the window or turns on reduced motion; when they come
  // back, the intro replays from the start, so the handoff state must start over with it.
  useEffect(() => {
    if (showVideo) return;
    setPhase('intro');
    setLoopWarm(false);
  }, [showVideo]);

  const onIntroTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (!loopWarm && v.duration - v.currentTime <= LOOP_WARM_SECONDS) setLoopWarm(true);
  };

  const onIntroEnded = () => {
    const l = loopRef.current;
    if (!l) return;
    l.muted = true;
    // A refused loop leaves the intro's last frame on screen, which is the right fallback.
    void l.play().catch(() => setLoopWarm(true));
  };

  return (
    <section
      id="hero"
      data-surface="dark"
      data-hero-phase={showVideo ? phase : 'still'}
      className="relative isolate flex min-h-screen items-center overflow-hidden bg-river-deep text-white"
    >
      {/* Still: chosen by the browser from media queries, so it is in the server HTML and a phone
          downloads only the portrait image. The night poster equals the intro's first frame. */}
      <picture>
        <source media="(max-width: 767px)" srcSet={HERO_MEDIA.mobile} width={520} height={1080} />
        <source media="(prefers-reduced-motion: reduce)" srcSet={HERO_MEDIA.posterDay} width={1920} height={1080} />
        <img
          src={HERO_MEDIA.posterNight}
          alt=""
          width={1920}
          height={1080}
          decoding="async"
          className="absolute inset-0 -z-30 h-full w-full object-cover"
        />
      </picture>

      {showVideo && (
        <>
          <video
            ref={loopRef}
            aria-hidden="true"
            muted
            loop
            playsInline
            preload={loopWarm ? 'auto' : 'metadata'}
            src={HERO_MEDIA.loop}
            width={1920}
            height={1080}
            onPlaying={() => setPhase('loop')}
            className="absolute inset-0 -z-20 h-full w-full object-cover"
          />
          <video
            ref={introRef}
            aria-hidden="true"
            autoPlay
            muted
            playsInline
            preload="auto"
            poster={HERO_MEDIA.posterNight}
            src={HERO_MEDIA.intro}
            width={1920}
            height={1080}
            onTimeUpdate={onIntroTimeUpdate}
            onEnded={onIntroEnded}
            onError={() => setFailed(true)}
            className={`absolute inset-0 -z-10 h-full w-full object-cover ${phase === 'loop' ? 'invisible' : ''}`}
          />
        </>
      )}

      {/* Scrim in River Deep. Phones: a vertical wash that holds through the copy and lets go of
          the bottom. Wide screens: a left wash masked to end just below the copy, so the river
          numbers to the right and below stay visible. */}
      <div
        aria-hidden="true"
        data-hero-scrim="mobile"
        className="absolute inset-0 -z-[5] md:hidden"
        style={{ background: MOBILE_SCRIM }}
      />
      <div
        aria-hidden="true"
        data-hero-scrim="desktop"
        className="absolute inset-0 -z-[5] hidden md:block"
        style={{ background: DESKTOP_SCRIM, maskImage: DESKTOP_SCRIM_MASK, WebkitMaskImage: DESKTOP_SCRIM_MASK }}
      />

      <div className="relative mx-auto w-full max-w-7xl px-4 pb-16 pt-28 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight leading-[1.05] text-white">
            Keep the books flowing.
          </h1>
          <p className="mt-6 text-xl sm:text-2xl font-medium text-river-shallows">
            One calm flow from invoice to SARS-ready return.
          </p>
          <p className="mt-5 text-base sm:text-lg leading-relaxed text-white/85">{SUPPORTING_LINE}</p>
          <div className="mt-9 flex flex-col gap-4 sm:flex-row sm:items-center">
            <a
              href={`${APP_URL}/register`}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-river-ember px-7 py-4 text-base font-bold text-river-deep shadow-lg transition-colors hover:bg-river-ember/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              Start 30-day free trial, no card <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
            <a
              href="/pricing#bureau"
              className="inline-flex items-center justify-center rounded-xl border border-white/50 px-7 py-4 text-base font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              For practices and bureaus
            </a>
          </div>
          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-white/80">
            {TRUST_POINTS.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </div>
      </div>
    </section>
  );
}
