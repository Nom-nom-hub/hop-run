/**
 * The summary shown once every script has settled.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { formatMs } from './RunBoard.js';
import { GLYPH, ROLE } from './palette.js';

export interface SummaryRow {
  name: string;
  script: string;
  ok: boolean;
  reason?: string;
  durationMs: number;
}

export interface SummaryProps {
  rows: SummaryRow[];
  totalMs: number;
  /** True when hop was interrupted. */
  interrupted?: boolean;
}

export function Summary({ rows, totalMs, interrupted = false }: SummaryProps): React.ReactElement {
  const succeeded = rows.filter((row) => row.ok).length;
  const failed = rows.length - succeeded;
  const allOk = failed === 0;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={allOk ? ROLE.ok : ROLE.fail} bold>
          {allOk ? GLYPH.ok : GLYPH.fail}
        </Text>
        <Text> </Text>
        <Text bold color={allOk ? ROLE.ok : ROLE.fail}>
          {succeeded}/{rows.length}
        </Text>
        <Text color={ROLE.muted}> scripts </Text>
        <Text color={allOk ? ROLE.ok : ROLE.fail}>{allOk ? 'succeeded' : 'failed'}</Text>
        <Text color={ROLE.muted}> {GLYPH.dotSmall} {formatMs(totalMs)}</Text>
      </Box>

      {failed > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {rows
            .filter((row) => !row.ok)
            .map((row) => (
              <Box key={`${row.name}:${row.script}`}>
                <Text color={ROLE.fail}>  {GLYPH.fail} </Text>
                <Text>{row.name} {row.script}</Text>
                {row.reason !== undefined ? <Text color={ROLE.muted}> ({row.reason})</Text> : null}
              </Box>
            ))}
        </Box>
      ) : null}

      {interrupted ? (
        <Box marginTop={1}>
          <Text color={ROLE.warn}>{GLYPH.warn} interrupted</Text>
        </Box>
      ) : null}
    </Box>
  );
}
