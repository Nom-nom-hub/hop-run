/**
 * hop's script picker.
 *
 * A bespoke list, not a generic multiselect: projects are grouped, every
 * row shows the command it will run, the ones hop would pick by itself are
 * marked, and the whole thing is driven by raw key presses so the feel is
 * exactly what we want.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { GLYPH, ROLE, toneForType } from './palette.js';
import {
  allRows,
  chosenScripts,
  groupRows,
  initialSelection,
  moveCursor,
  rowKey,
  toggle,
  toggleAll,
  visibleRows,
  type PickerProject,
} from './picker-state.js';

export type { PickerProject } from './picker-state.js';

export interface PickerProps {
  projects: PickerProject[];
  /** Called with the chosen script names, in the order they were picked. */
  onSubmit(chosen: Map<string, string[]>): void;
  /** Called when the user aborts with Escape or Ctrl+C. */
  onCancel(): void;
}

export function Picker({ projects, onSubmit, onCancel }: PickerProps): React.ReactElement {
  const { isRawModeSupported } = useStdin();
  const rows = useMemo(() => allRows(projects), [projects]);
  const [cursor, setCursor] = useState(0);
  const [selection, setSelection] = useState(() => initialSelection(projects));
  const [filter, setFilter] = useState<string | null>(null);

  const visible = useMemo(() => visibleRows(rows, projects, filter ?? ''), [rows, projects, filter]);
  const groups = useMemo(() => groupRows(visible, projects), [visible, projects]);

  // The cursor is an index into the *visible* rows; keep it inside them.
  const active = Math.min(cursor, Math.max(0, visible.length - 1));
  const activeRow = visible[active];

  const submit = useCallback(() => {
    onSubmit(chosenScripts(selection, rows, projects));
  }, [onSubmit, selection, rows, projects]);

  // Without raw mode there are no key presses to listen for, so the picker
  // would sit there forever. It is only mounted on a real terminal, but the
  // guard keeps a piped stdin from hanging the process.
  useInput(
    (input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.ctrl && input === 'c') {
      onCancel();
      return;
    }
    if (key.return) {
      submit();
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((text) => (text === null ? null : text.slice(0, -1)));
      return;
    }
    if (key.upArrow) {
      setCursor((position) => moveCursor(position, 'up', visible.length));
      return;
    }
    if (key.downArrow) {
      setCursor((position) => moveCursor(position, 'down', visible.length));
      return;
    }
    if (key.leftArrow) {
      setCursor((position) => moveCursor(position, 'first', visible.length));
      return;
    }
    if (key.rightArrow) {
      setCursor((position) => moveCursor(position, 'last', visible.length));
      return;
    }
    if (input === ' ') {
      if (activeRow !== undefined) {
        setSelection((previous) => toggle(previous, activeRow.projectIndex, activeRow.script));
      }
      return;
    }
    if (input === 'a') {
      setSelection((previous) => toggleAll(previous, visible));
      return;
    }
    if (input === '/') {
      setFilter('');
      return;
    }
    // Anything else types into the filter.
    if (input !== '' && !key.ctrl && !key.meta) {
      setFilter((text) => (text === null ? input : text + input));
      setCursor(0);
    }
    },
    { isActive: isRawModeSupported },
  );

  const selectedCount = selection.size;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={ROLE.brand} bold>
          {GLYPH.mark} hop
        </Text>
        <Text color={ROLE.muted}> · </Text>
        <Text bold>{projects.length}</Text>
        <Text color={ROLE.muted}> projects detected</Text>
      </Box>

      {filter !== null ? (
        <Box marginBottom={1}>
          <Text color={ROLE.warn}>/</Text>
          <Text>{filter}</Text>
          <Text color={ROLE.muted}>▏</Text>
        </Box>
      ) : null}

      {groups.map((group) => {
        const tone = toneForType(group.project.type);
        const changed = group.project.changed;
        return (
          <Box key={group.project.name} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={tone} bold>
                {group.project.name}
              </Text>
              <Text color={ROLE.muted}> · </Text>
              <Text color={ROLE.muted}>{group.project.type}</Text>
              {changed !== undefined ? (
                <>
                  <Text color={ROLE.muted}> · </Text>
                  <Text color={ROLE.warn}>{changed} changed</Text>
                </>
              ) : null}
            </Box>

            {group.rows.map((row) => {
              const isActive = activeRow === row;
              const isSelected = selection.has(rowKey(row.projectIndex, row.script));
              const isSuggested = group.project.suggested === row.script;
              return (
                <Box key={rowKey(row.projectIndex, row.script)}>
                  <Text color={isActive ? ROLE.brand : ROLE.muted}>{isActive ? GLYPH.cursor : ' '} </Text>
                  <Text color={isSelected ? ROLE.ok : ROLE.muted}>{isSelected ? GLYPH.checked : GLYPH.unchecked} </Text>
                  <Text bold={isActive} color={isActive ? ROLE.text : undefined}>
                    {row.script}
                  </Text>
                  {isSuggested ? <Text color={ROLE.muted}> {GLYPH.dotSmall} suggested</Text> : null}
                  <Text color={ROLE.muted}>  {group.project.commands[row.script] ?? ''}</Text>
                </Box>
              );
            })}
          </Box>
        );
      })}

      {visible.length === 0 ? (
        <Box>
          <Text color={ROLE.warn}>no script matches “{filter}”</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={ROLE.muted}>↑/↓ move</Text>
        <Text color={ROLE.muted}>{GLYPH.dotSmall} </Text>
        <Text color={ROLE.muted}>space select</Text>
        <Text color={ROLE.muted}>{GLYPH.dotSmall} </Text>
        <Text color={ROLE.muted}>a all</Text>
        <Text color={ROLE.muted}>{GLYPH.dotSmall} </Text>
        <Text color={ROLE.muted}>/ filter</Text>
        <Text color={ROLE.muted}>{GLYPH.dotSmall} </Text>
        <Text color={ROLE.muted}>enter run</Text>
        <Text color={ROLE.muted}>{GLYPH.dotSmall} </Text>
        <Text color={ROLE.muted}>esc cancel</Text>
        <Text color={ROLE.muted}>{GLYPH.dotSmall} </Text>
        <Text color={ROLE.ok} bold>
          {selectedCount} selected
        </Text>
      </Box>
    </Box>
  );
}
