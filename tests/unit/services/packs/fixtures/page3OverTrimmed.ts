/**
 * Packs whose page 3 (Highlights) printed inside its sheet both before #1158 and on master, where master kept FEWER of
 * the page's explanatory notes than pre-#1158 did: the adversary's 184 (28 by one note, 156 by two), every sixth,
 * with the notes each kept. For `packPage3NotesExact.test.ts`: the KPI block is modelled at its exact height now, so
 * the page keeps what it printed.
 */
import type { Shape } from './packGridInputs';

export interface OverTrimmed { shape: Shape; preNotes: number; masterNotes: number }

export const OVER_TRIMMED: OverTrimmed[] = [
  { shape: {tr: 'demo', budget: true, prior: true, negative: true, loss: false, k: 1000, plug: 0.0, sg: [1, 1, -1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: true, prior: true, negative: true, loss: true, k: 1000, plug: 0.05, sg: [1, 1, -1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: true, prior: false, negative: true, loss: true, k: 1000, plug: 0.0, sg: [1, 1, -1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: false, prior: true, negative: true, loss: false, k: 1000, plug: 0.05, sg: [1, 1, -1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: false, prior: false, negative: true, loss: false, k: 1000, plug: 0.0, sg: [1, 1, -1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: false, prior: false, negative: true, loss: true, k: 1000, plug: 0.05, sg: [1, 1, -1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: true, prior: false, negative: true, loss: false, k: 1000, plug: 0.0, sg: [-1, 1, -1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: false, prior: true, negative: true, loss: true, k: 1000, plug: 0.0, sg: [-1, 1, -1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: true, prior: true, negative: true, loss: false, k: 1000, plug: 0.0, sg: [1, -1, -1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: true, prior: true, negative: false, loss: false, k: 1000, plug: 0.05, sg: [1, -1, -1, 1]}, preNotes: 10, masterNotes: 9 },
  { shape: {tr: 'demo', budget: true, prior: false, negative: true, loss: false, k: 1000, plug: 0.0, sg: [1, -1, -1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: false, prior: true, negative: true, loss: true, k: 1000, plug: 0.0, sg: [1, -1, -1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: false, prior: true, negative: false, loss: true, k: 1000, plug: 0.0, sg: [1, -1, -1, 1]}, preNotes: 10, masterNotes: 9 },
  { shape: {tr: 'demo', budget: false, prior: false, negative: true, loss: true, k: 1000, plug: 0.0, sg: [1, -1, -1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: true, prior: false, negative: true, loss: false, k: 1000, plug: 0.0, sg: [-1, 1, 1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: false, prior: true, negative: true, loss: true, k: 1000, plug: 0.0, sg: [-1, 1, 1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: true, prior: true, negative: true, loss: true, k: 30000, plug: 0.0, sg: [-1, -1, 1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: true, prior: false, negative: true, loss: true, k: 30000, plug: 0.05, sg: [-1, -1, 1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: false, prior: false, negative: true, loss: true, k: 30000, plug: 0.0, sg: [-1, -1, 1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: true, prior: true, negative: true, loss: true, k: 1000, plug: 0.0, sg: [1, -1, 1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: true, prior: true, negative: false, loss: true, k: 1000, plug: 0.05, sg: [1, -1, 1, 1]}, preNotes: 10, masterNotes: 9 },
  { shape: {tr: 'demo', budget: false, prior: true, negative: true, loss: false, k: 1000, plug: 0.0, sg: [1, -1, 1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: false, prior: true, negative: false, loss: false, k: 1000, plug: 0.05, sg: [1, -1, 1, 1]}, preNotes: 10, masterNotes: 9 },
  { shape: {tr: 'demo', budget: false, prior: false, negative: true, loss: true, k: 1000, plug: 0.0, sg: [1, -1, 1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: true, prior: false, negative: true, loss: true, k: 30000, plug: 0.0, sg: [-1, -1, -1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: false, prior: true, negative: true, loss: true, k: 30000, plug: 0.05, sg: [-1, -1, -1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: true, prior: true, negative: true, loss: false, k: 1000, plug: 0.0, sg: [1, 1, 1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: true, prior: true, negative: true, loss: true, k: 1000, plug: 0.05, sg: [1, 1, 1, -1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: true, prior: false, negative: true, loss: true, k: 1000, plug: 0.05, sg: [1, 1, 1, 1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: false, prior: true, negative: true, loss: true, k: 1000, plug: 0.0, sg: [1, 1, 1, -1]}, preNotes: 8, masterNotes: 6 },
  { shape: {tr: 'demo', budget: false, prior: false, negative: true, loss: true, k: 1000, plug: 0.0, sg: [1, 1, 1, 1]}, preNotes: 8, masterNotes: 6 },
];
