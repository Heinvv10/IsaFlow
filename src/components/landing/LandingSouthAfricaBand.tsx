import { useEffect, useRef, useState } from 'react';
import { LANDMARK_CLIPS } from './riverMedia';
import { useInView, useRiverVideoAllowed } from './useRiverMotion';

const FACTS = [
  {
    title: 'SARS-ready returns',
    body: 'VAT201 and EMP201 prepared for you to file on eFiling. EMP501 and IRP5/IT3(a) prepared for you to submit through e@syFile Employer.',
  },
  {
    title: 'South African payroll rules',
    body: 'Payroll calculates PAYE, UIF and SDL, produces payslips, and prepares EMP201 and IRP5 data.',
  },
  { title: 'POPIA and local hosting', body: null },
  {
    title: 'Rand pricing, Pretoria head office',
    body: 'Prices are in rand and include 15% VAT. Our head office is in Pretoria, South Africa.',
  },
] as const;

const PLACES_CAPTION = 'Cape Town, Johannesburg and Pretoria.';
const LAST_CLIP = LANDMARK_CLIPS.length - 1;

function PosterStrip() {
  return (
    <div className="flex gap-4 overflow-x-auto snap-x snap-mandatory sm:grid sm:grid-cols-3 sm:overflow-visible">
      {LANDMARK_CLIPS.map((clip) => (
        <figure key={clip.place} className="min-w-[80%] snap-center sm:min-w-0">
          <img
            src={clip.poster}
            alt={clip.alt}
            width={1280}
            height={720}
            loading="lazy"
            decoding="async"
            className="aspect-video w-full rounded-xl object-cover"
          />
          <figcaption className="mt-2 text-sm text-white/80">{clip.place}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/**
 * "Built in South Africa" band, placed before pricing. Dark in both themes. On a wide screen with
 * motion allowed the three landmark clips play in order once each time the band comes into view;
 * nothing downloads before the band is near. Everyone else, and the server HTML, get the poster
 * strip. The film stage keeps a poster visible until a clip actually plays, so the frame is never empty.
 */
export function LandingSouthAfricaBand() {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const current = useRef(0);
  const started = useRef(false);
  const finished = useRef(false);
  const [visible, setVisible] = useState(0);
  const [hasFrame, setHasFrame] = useState(false);
  const [filmFailed, setFilmFailed] = useState(false);

  const videoAllowed = useRiverVideoAllowed();
  const filmAllowed = videoAllowed && !filmFailed;
  // Observe the poster strip (and later the film stage) so we only swap markup once a poster or
  // src can be shown. Server HTML and the first client render stay on the poster strip.
  const near = useInView(stageRef, { rootMargin: '600px 0px', threshold: 0, once: true }, filmAllowed);
  const inView = useInView(stageRef, { rootMargin: '0px', threshold: 0.5 }, filmAllowed);
  const showFilm = filmAllowed && near;

  useEffect(() => {
    if (!showFilm) return;
    const clips = videoRefs.current;
    const playClip = (i: number) => {
      const v = clips[i];
      if (!v) return;
      v.muted = true;
      void v.play().catch(() => setFilmFailed(true));
    };
    if (inView && (!started.current || finished.current)) {
      clips.forEach((v) => { if (v) v.currentTime = 0; });
      started.current = true;
      finished.current = false;
      current.current = 0;
      setVisible(0); // otherwise Pretoria's first frame shows until Cape Town fires `playing`
      setHasFrame(false); // keep the Cape Town poster up until a frame actually paints
      playClip(0);
    } else if (inView) {
      playClip(current.current);
    } else {
      clips[current.current]?.pause();
    }
  }, [near, inView, showFilm]);

  const onClipEnded = (i: number) => {
    if (i >= LAST_CLIP) {
      finished.current = true; // the Union Buildings frame stays on screen
      return;
    }
    // The ended clip keeps its last frame on top until the next one fires `playing`.
    current.current = i + 1;
    const next = videoRefs.current[i + 1];
    if (!next) return;
    next.muted = true;
    void next.play().catch(() => setFilmFailed(true));
  };

  return (
    <section
      id="south-africa"
      data-surface="dark"
      aria-labelledby="south-africa-title"
      className="bg-river-deep py-20 lg:py-28 text-white"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="text-sm font-semibold uppercase tracking-widest text-river-shallows">South African by design</p>
            <h2 id="south-africa-title" className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
              Built in South Africa, for South African books
            </h2>
            <p className="mt-5 text-lg text-white/85">
              IsaFlow is built around South African VAT, payroll tax and reporting rules, with rand pricing and a head
              office in Pretoria.
            </p>
            <dl className="mt-10 grid gap-8 sm:grid-cols-2">
              {FACTS.map((f) => (
                <div key={f.title}>
                  <dt className="text-base font-semibold text-white">{f.title}</dt>
                  <dd className="mt-2 text-sm leading-relaxed text-white/80">
                    {f.body ?? (
                      <>
                        Our application and database servers are hosted in South Africa, and we handle personal
                        information under POPIA, as set out in our{' '}
                        <a href="/privacy" className="underline text-river-shallows">privacy policy</a>.
                      </>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div ref={stageRef}>
            {showFilm ? (
              <figure>
                <div className="relative aspect-video overflow-hidden rounded-2xl bg-river-deep ring-1 ring-white/10">
                  <img
                    src={LANDMARK_CLIPS[visible].poster}
                    alt={LANDMARK_CLIPS[visible].alt}
                    width={1280}
                    height={720}
                    decoding="async"
                    className={`absolute inset-0 h-full w-full object-cover ${hasFrame ? 'invisible' : ''}`}
                  />
                  {LANDMARK_CLIPS.map((clip, i) => (
                    <video
                      key={clip.place}
                      ref={(el) => { videoRefs.current[i] = el; }}
                      muted
                      playsInline
                      preload="none"
                      poster={clip.poster}
                      src={clip.src}
                      width={1920}
                      height={1080}
                      aria-label={clip.alt}
                      onPlaying={() => {
                        setVisible(i);
                        setHasFrame(true);
                      }}
                      onEnded={() => onClipEnded(i)}
                      onError={() => setFilmFailed(true)}
                      className={`absolute inset-0 h-full w-full object-cover ${i === visible && hasFrame ? '' : 'invisible'}`}
                    />
                  ))}
                </div>
                <figcaption className="mt-3 text-sm text-white/80">{PLACES_CAPTION}</figcaption>
              </figure>
            ) : (
              <PosterStrip />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
