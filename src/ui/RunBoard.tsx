/**
 * The run dashboard.
 *
 * While the scripts run, this shows one row per project: what it is doing
 * right now, which port it ended up on and how long it took. The rows are
 * updated in place, so the board reads as a single live surface instead of
 * a log that scrolls past.
 */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { GLYPH, ROLE } from './palette.js';

/** What a project is doing at the moment. */
export type Phase = 'waiting' | 'starting' | 'running' | 'done' | 'failed';

export interface RunRow {
  /** Display name of the project. */
  name: string;
  /** The script that was selected. */
  script: string;
  /** The command it runs. */
  command: string;
  /** The current phase. */
  phase: Phase;
  /** The port it listens on, once known. */
  port?: number;
  /** Why it failed, if it did. */
  reason?: string;
  /** How long it has been running. */
  durationMs?: number;
  /** The dependency it is waiting for. */
  waitingFor?: string;
}

export interface RunBoardProps {
  rows: RunRow[];
  /** True once every row has settled. */
  finished: boolean;
  /** The total time the run took. */
  totalMs?: number;
  /** The child output, newest last. */
  logs?: string[];
  /** How many log lines to keep on screen. */
  logLines?: number;
}

const SPINNER = GLYPH.spinner;

/** The glyph and colour for a phase. */
function phaseLook(phase: Phase): { glyph: string; color: string } {
  switch (phase) {
    case 'waiting':
      return { glyph: GLYPH.ring, color: ROLE.warn };
    case 'starting':
      return { glyph: SPINNER[0]!, color: ROLE.info };
    case 'running':
      return { glyph: GLYPH.status, color: ROLE.brand };
    case 'done':
      return { glyph: GLYPH.ok, color: ROLE.ok };
    case 'failed':
      return { glyph: GLYPH.fail, color: ROLE.fail };
    default:
      return { glyph: GLYPH.ring, color: ROLE.muted };
  }
}

/** "1.2s" / "340ms" / "1m 04s" */
export function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function RunBoard({ rows, finished, totalMs, logs = [], logLines = 12 }: RunBoardProps): React.ReactElement {
  const [tick, setTick] = useState(0);

  // A clock so the spinner keeps moving.
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 80);
    return () => clearInterval(timer);
  }, []);

  const nameWidth = Math.max(...rows.map((row) => row.name.length), 0);
  const scriptWidth = Math.max(...rows.map((row) => row.script.length), 0);
  const spinner = SPINNER[tick % SPINNER.length]!;
  const shown = logs.slice(-logLines);

  return (
    <Box flexDirection="column">
      {rows.map((row) => {
        const look = phaseLook(row.phase);
        const glyph = row.phase === 'starting' ? spinner : look.glyph;
        return (
          <Box key={`${row.name}:${row.script}`}>
            <Text color={look.color}>{glyph} </Text>
            <Text bold color={row.phase === 'done' || row.phase === 'failed' ? ROLE.text : undefined}>
              {row.name.padEnd(nameWidth)}
            </Text>
            <Text> </Text>
            <Text color={ROLE.muted}>{row.script.padEnd(scriptWidth)}</Text>
            <Text> </Text>

            {row.phase === 'waiting' ? (
              <Text color={ROLE.warn}>waiting for {row.waitingFor ?? 'dependency'}</Text>
            ) : null}
            {row.phase === 'starting' ? (
              <Text color={ROLE.info}>starting…</Text>
            ) : null}
            {row.phase === 'running' ? (
              <Text color={ROLE.brand}>running</Text>
            ) : null}
            {row.phase === 'done' ? (
              <Text color={ROLE.ok}>
                done{row.durationMs !== undefined ? ` ${GLYPH.dotSmall} ${formatMs(row.durationMs)}` : ''}
              </Text>
            ) : null}
            {row.phase === 'failed' ? (
              <Text color={ROLE.fail}>
                {row.reason ?? 'failed'}
                {row.durationMs !== undefined ? ` ${GLYPH.dotSmall} ${formatMs(row.durationMs)}` : ''}
              </Text>
            ) : null}

            {row.port !== undefined ? (
              <Text color={ROLE.muted}> {GLYPH.dotSmall} :{row.port}</Text>
            ) : null}
          </Box>
        );
      })}

      {shown.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {shown.map((line, index) => (
            <Text key={index} color={ROLE.muted}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      {finished ? (
        <Box marginTop={1}>
          <Text color={ROLE.muted}>{GLYPH.rule.repeat(40)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
