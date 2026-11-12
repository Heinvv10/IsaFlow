/** River hero and South Africa band media. Files live in public/landing/river and public/landing/sa. */
export const HERO_MEDIA = {
  intro: '/landing/river/hero-intro.mp4', // 10.5 s, plays once, night to day
  loop: '/landing/river/hero-loop.mp4', // 6.5 s, seamless; first frame equals the intro's last
  posterNight: '/landing/river/hero-poster-night.webp', // intro frame 0
  posterDay: '/landing/river/hero-poster-day.webp', // loop frame 0
  mobile: '/landing/river/hero-mobile.webp', // 520x1080 portrait still
} as const;

/** The hero art and the landmark footage are illustrative (Hein, 12 Nov); shown in every mode. */
export const ILLUSTRATIVE_CAPTION = 'Illustrative footage';

export interface LandmarkClip {
  place: string;
  alt: string;
  src: string;
  poster: string;
}

/** Played in this order; the last clip ends on the Union Buildings. */
export const LANDMARK_CLIPS: LandmarkClip[] = [
  {
    place: 'Cape Town',
    alt: 'Table Mountain above the Cape Town harbour at sunrise',
    src: '/landing/sa/landmark-capetown.mp4',
    poster: '/landing/sa/landmark-capetown-poster.webp',
  },
  {
    place: 'Johannesburg',
    alt: 'A tall telecommunications tower above the Johannesburg skyline',
    src: '/landing/sa/landmark-joburg.mp4',
    poster: '/landing/sa/landmark-joburg-poster.webp',
  },
  {
    place: 'Pretoria',
    alt: 'The Union Buildings in Pretoria',
    src: '/landing/sa/landmark-pretoria.mp4',
    poster: '/landing/sa/landmark-pretoria-poster.webp',
  },
];
