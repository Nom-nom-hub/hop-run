/**
 * The visual language of hop's terminal interface.
 *
 * Two layers live here:
 *
 * - `PALETTE` — the raw colour choices, as Ink understands them;
 * - `ROLE` — the semantic roles every screen picks from, so "a project that
 *   failed" always looks the same, wherever it is drawn.
 *
 * The glyphs are shared with the plain-text path, so both draw the same
 * shapes. Ink measures text in *visible* columns, so every width
 * calculation in the UI can use plain string lengths — no ANSI stripping
 * needed.
 */
import { GLYPH } from '../theme.js';

export { GLYPH };

/** The raw colours, chosen to stay legible on light and dark terminals. */
export const PALETTE = {
  brand: 'cyan',
  ok: 'green',
  fail: 'red',
  warn: 'yellow',
  info: 'blue',
  violet: 'magenta',
  muted: 'gray',
  text: 'white',
} as const;

/** A colour name Ink understands, or undefined for "no colour". */
export type Tone = (typeof PALETTE)[keyof typeof PALETTE];

/** The semantic roles the interface uses. */
export const ROLE = {
  /** hop itself. */
  brand: PALETTE.brand,
  /** Something finished successfully. */
  ok: PALETTE.ok,
  /** Something failed. */
  fail: PALETTE.fail,
  /** Something needs attention. */
  warn: PALETTE.warn,
  /** A neutral announcement. */
  info: PALETTE.info,
  /** Secondary information: paths, hints, counts. */
  muted: PALETTE.muted,
  /** Ordinary body text. */
  text: PALETTE.text,
} as const;

/** The tone a project type is drawn in. */
export function toneForType(type: string): Tone {
  switch (type) {
    case 'node':
      return PALETTE.ok;
    case 'docker':
      return PALETTE.info;
    case 'python':
      return PALETTE.warn;
    case 'go':
      return PALETTE.brand;
    default:
      return PALETTE.muted;
  }
}
