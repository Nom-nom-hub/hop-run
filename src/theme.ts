/**
 * hop's visual language.
 *
 * Every screen — help, project list, run header, summary — draws from this
 * module, so the colours, glyphs and spacing stay consistent. The rules:
 *
 * - colour carries meaning, never decoration: identity for a project,
 *   green/red/yellow for the outcome;
 * - secondary information is dimmed, never coloured;
 * - widths are measured in *visible* columns, because ANSI codes take space
 *   on the wire but none on the screen.
 */
import pc from 'picocolors';

export type Style = (text: string) => string;

/** Semantic styles. Everything in the CLI picks from here. */
export const STYLE = {
  /** hop itself. */
  brand: pc.cyan,
  /** A project that finished successfully. */
  ok: pc.green,
  /** A project that failed. */
  fail: pc.red,
  /** Something that needs attention but is not fatal. */
  warn: pc.yellow,
  /** Secondary information: paths, commands, hints. */
  muted: pc.dim,
  /** A name or label that should stand out. */
  strong: pc.bold,
  /** No styling at all. */
  plain: (text: string): string => text,
} as const;

/** The glyphs hop uses, in one place so every screen matches. */
export const GLYPH = {
  ok: '✔',
  fail: '✖',
  warn: '⚠',
  info: 'ℹ',
  dot: '·',
  /** A small separator. */
  dotSmall: '·',
  /** A tree branch that is followed by more items. */
  branch: '├',
  /** The last item of a tree. */
  last: '└',
  /** A horizontal rule. */
  rule: '─',
  /** The hop mark. */
  mark: '↗',
  /** A leading marker for a list entry. */
  bullet: '▸',
  /** A selected checkbox. */
  checked: '◉',
  /** An unselected checkbox. */
  unchecked: '○',
  /** The cursor in the picker. */
  cursor: '❯',
  /** A filled status dot. */
  status: '●',
  /** An empty status dot. */
  ring: '○',
  /** The frames of the loading spinner. */
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
} as const;

/** A small square used to tag the ecosystem of a project. */
export const CHIP = '▪' as const;

const ANSI = /\[[0-9;]*m/g;

/** Length of `text` as it appears on screen — ANSI codes do not count. */
export function visibleLength(text: string): number {
  return text.replace(ANSI, '').length;
}

/** Pads `text` to `width` *visible* columns. */
export function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

/** The widest visible length of the given texts. */
export function widest(texts: readonly string[]): number {
  return texts.reduce((max, text) => Math.max(max, visibleLength(text)), 0);
}

/** A dim horizontal rule, `width` columns wide. */
export function rule(width: number): string {
  return STYLE.muted(GLYPH.rule.repeat(Math.max(1, width)));
}

/**
 * The wordmark: a mark and the name, on one line.
 *
 * `detail` is optional secondary text after the name; it is already styled by
 * the caller, so it is not dimmed here.
 */
export function wordmark(detail?: string): string {
  const mark = STYLE.brand(GLYPH.mark);
  const name = STYLE.strong(STYLE.brand('hop'));
  return detail === undefined ? `${mark} ${name}` : `${mark} ${name} ${STYLE.muted(GLYPH.dot)} ${detail}`;
}

/** A section title: bold label with a dim rule underneath. */
export function section(title: string, width: number): string {
  return `${STYLE.strong(title)}\n${rule(width)}`;
}

/**
 * A tree entry: `├` for an item that is followed by more, `└` for the last.
 */
export function branch(label: string, isLast: boolean): string {
  return `${STYLE.muted(isLast ? GLYPH.last : GLYPH.branch)} ${label}`;
}

/** A tag marking the ecosystem of a project, e.g. `▪ node`. */
export function chip(text: string, style: Style): string {
  return `${style(CHIP)} ${STYLE.muted(text)}`;
}

/**
 * Style for a project type.
 *
 * Each type gets its own colour so the ecosystem is readable at a glance.
 * The styles are separate closures rather than direct references to the
 * picocolors helpers: on a terminal without colour support those helpers
 * all collapse into one no-op, and the types would become
 * indistinguishable.
 */
const TYPE_STYLES: Record<string, Style> = {
  node: (text: string) => pc.green(text),
  docker: (text: string) => pc.blue(text),
  python: (text: string) => pc.yellow(text),
  go: (text: string) => pc.cyan(text),
};

export function styleForType(type: string): Style {
  return TYPE_STYLES[type] ?? STYLE.muted;
}

/** Truncates `text` to `max` visible columns, adding an ellipsis. */
export function truncate(text: string, max: number): string {
  if (max <= 1 || visibleLength(text) <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
