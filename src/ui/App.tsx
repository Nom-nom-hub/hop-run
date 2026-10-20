/**
 * The application shell.
 *
 * Ink owns the terminal while the interface is up, so the run view is a
 * single live surface: a board of projects at the top, the child output
 * underneath, and a summary once everything has settled.
 */
import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp } from 'ink';
import { Picker, type PickerProject } from './Picker.js';
import { RunBoard } from './RunBoard.js';
import { Summary, type SummaryRow } from './Summary.js';
import type { RunController, RunState } from './controller.js';
import { GLYPH, ROLE } from './palette.js';

export type AppView = 'picker' | 'running' | 'done';

/** The state before any controller is attached. */
const EMPTY_STATE: RunState = { rows: [], finished: false, logs: [] };

export interface AppProps {
  /** The view to show. */
  view: AppView;
  /** The projects the picker offers. */
  projects: PickerProject[];
  /** The controller the run view reads from. */
  controller?: RunController;
  /** Called when the picker is submitted. */
  onPick(chosen: Map<string, string[]>): void;
  /** Called when the picker is cancelled. */
  onCancel(): void;
  /** The summary rows, once the run is over. */
  summary?: SummaryRow[];
  /** The total time the run took. */
  totalMs?: number;
  /** True when hop was interrupted. */
  interrupted?: boolean;
}

export function App({
  view,
  projects,
  controller,
  onPick,
  onCancel,
  summary = [],
  totalMs = 0,
  interrupted = false,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [now, setNow] = useState(Date.now());

  // A heartbeat, so the running durations keep counting.
  useEffect(() => {
    if (view !== 'running') {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 120);
    return () => clearInterval(timer);
  }, [view]);

  const state = useSyncExternalStore(
    controller?.subscribe ?? (() => () => undefined),
    () => controller?.getState() ?? EMPTY_STATE,
    () => controller?.getState() ?? EMPTY_STATE,
  );

  const rows = useMemo(
    () => state.rows.map((row) => ({ ...row })),
    // `now` is in the dependency list so the durations refresh.
    [state.rows, now],
  );

  // The summary is derived from the board, so it is always in step with it.
  const derived = useMemo<SummaryRow[]>(
    () =>
      rows.map((row) => ({
        name: row.name,
        script: row.script,
        ok: row.phase === 'done',
        reason: row.reason,
        durationMs: row.durationMs ?? 0,
      })),
    [rows],
  );

  if (view === 'picker') {
    return <Picker projects={projects} onSubmit={onPick} onCancel={onCancel} />;
  }

  if (view === 'done') {
    return (
      <Box flexDirection="column">
        <Summary rows={summary.length > 0 ? summary : derived} totalMs={totalMs} interrupted={interrupted} />
      </Box>
    );
  }

  const settled = rows.filter((row) => row.phase === 'done' || row.phase === 'failed').length;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={ROLE.brand} bold>
          {GLYPH.mark} hop
        </Text>
        <Text color={ROLE.muted}> · </Text>
        <Text bold>{settled}</Text>
        <Text color={ROLE.muted}> of </Text>
        <Text bold>{rows.length}</Text>
        <Text color={ROLE.muted}> projects </Text>
        {state.finished ? (
          <Text color={ROLE.muted}>{GLYPH.dotSmall} finished</Text>
        ) : (
          <Text color={ROLE.brand}>{GLYPH.dotSmall} running</Text>
        )}
      </Box>

      <RunBoard rows={rows} finished={state.finished} totalMs={state.totalMs} logs={state.logs} />

      {state.finished ? (
        <Box marginTop={1}>
          <Summary rows={derived} totalMs={state.totalMs ?? totalMs} interrupted={interrupted} />
        </Box>
      ) : null}
    </Box>
  );
}
