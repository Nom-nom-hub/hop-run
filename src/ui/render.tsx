/**
 * Rendering the interface.
 *
 * Ink needs a real terminal: it takes over the screen, listens for key
 * presses and repaints. When the output is a pipe, a file or a CI log, that
 * is impossible — so the static screens fall back to plain text, and the
 * interactive ones fall back to a single-shot prompt.
 */
import { render, type Instance } from 'ink';
import React from 'react';

/** True when the process is attached to a terminal that can be drawn on. */
export function isInteractive(): boolean {
  if (process.env.CI !== undefined && process.env.CI !== '') {
    return false;
  }
  if (process.env.HOP_NO_UI !== undefined && process.env.HOP_NO_UI !== '') {
    return false;
  }
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

/** Renders an element and waits for it to finish. */
export async function renderOnce(element: React.ReactElement): Promise<void> {
  const instance: Instance = render(element, { exitOnCtrlC: false });
  await instance.waitUntilExit();
}

/** Renders an element and returns the instance, so it can be unmounted. */
export function mount(element: React.ReactElement): Instance {
  return render(element, { exitOnCtrlC: false });
}
