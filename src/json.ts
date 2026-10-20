/**
 * UTF-8 byte order mark, decoded to U+FEFF.
 *
 * Node does not strip it when decoding a file as UTF-8, and `JSON.parse`
 * rejects it, so a `package.json` written by PowerShell 5.1
 * (`Set-Content -Encoding utf8`) or by several older Windows editors would
 * make the whole project invisible to hop.
 */
const BOM = '﻿';

/** Removes a leading UTF-8 byte order mark, if there is one. */
export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * Parses JSON text that may be prefixed with a UTF-8 byte order mark.
 * Throws on invalid JSON, exactly like `JSON.parse`.
 */
export function parseJsonText(text: string): unknown {
  return JSON.parse(stripBom(text)) as unknown;
}
