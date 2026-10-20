import { describe, expect, it } from 'vitest';
import {
  branch,
  GLYPH,
  padTo,
  rule,
  section,
  STYLE,
  styleForType,
  truncate,
  visibleLength,
  widest,
  wordmark,
} from '../src/theme.js';

const ANSI = /\[[0-9;]*m/g;

/** The text as it would appear on screen. */
const plain = (text: string): string => text.replace(ANSI, '');

describe('visibleLength', () => {
  it('ignores ANSI escape codes', () => {
    expect(visibleLength(STYLE.ok('done'))).toBe(4);
    expect(visibleLength(STYLE.strong(STYLE.muted('nested')))).toBe(6);
  });

  it('counts plain text as-is', () => {
    expect(visibleLength('hello')).toBe(5);
    expect(visibleLength('')).toBe(0);
  });
});

describe('padTo', () => {
  it('pads to the requested visible width', () => {
    expect(visibleLength(padTo('ab', 6))).toBe(6);
    expect(visibleLength(padTo(STYLE.brand('abc'), 8))).toBe(8);
  });

  it('leaves text that is already wide enough alone', () => {
    expect(padTo('abcdef', 3)).toBe('abcdef');
    expect(visibleLength(padTo('abcdef', 3))).toBe(6);
  });

  it('keeps the styled text intact', () => {
    const styled = STYLE.brand('ab');
    expect(padTo(styled, 4)).toBe(`${styled}  `);
  });
});

describe('widest', () => {
  it('measures visible width, not byte length', () => {
    expect(widest([STYLE.brand('abc'), 'abcdef'])).toBe(6);
    expect(widest([])).toBe(0);
  });
});

describe('truncate', () => {
  it('cuts long text and marks it with an ellipsis', () => {
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
    expect(visibleLength(truncate('abcdefgh', 5))).toBe(5);
  });

  it('leaves short text alone', () => {
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate('abc', 3)).toBe('abc');
  });
});

describe('wordmark', () => {
  it('renders the hop name', () => {
    expect(plain(wordmark())).toBe(`${GLYPH.mark} hop`);
  });

  it('appends the detail after a separator', () => {
    expect(plain(wordmark('3 projects found'))).toBe(`${GLYPH.mark} hop · 3 projects found`);
  });
});

describe('section', () => {
  it('draws a title above a rule', () => {
    const lines = plain(section('Usage', 10)).split('\n');
    expect(lines[0]).toBe('Usage');
    expect(lines[1]).toBe(GLYPH.rule.repeat(10));
  });
});

describe('branch', () => {
  it('uses the branch glyph for every item but the last', () => {
    expect(plain(branch('x', false))).toBe(`${GLYPH.branch} x`);
    expect(plain(branch('x', true))).toBe(`${GLYPH.last} x`);
  });
});

describe('rule', () => {
  it('is never empty', () => {
    expect(plain(rule(0))).toBe(GLYPH.rule);
    expect(visibleLength(rule(20))).toBe(20);
  });
});

describe('styleForType', () => {
  it('gives every known type a style of its own', () => {
    // The styles must be distinguishable by identity, not by their output:
    // a terminal without colour support makes every one of them a no-op.
    const styles = ['node', 'docker', 'python', 'go'].map((type) => styleForType(type));
    const distinct = new Set(styles.map((style) => style.toString()));
    expect(distinct.size).toBe(4);
  });

  it('falls back for an unknown type', () => {
    expect(plain(styleForType('rust')('x'))).toBe('x');
  });
});
