/**
 * The picker's logic, kept apart from its drawing.
 *
 * Everything here is pure: given the projects, the filter and the selection,
 * it says which rows are visible, how they are grouped and what the user
 * chose. The React component is a thin shell over these functions, which
 * keeps the behaviour testable without a terminal.
 */

/** One project as the picker sees it. */
export interface PickerProject {
  name: string;
  type: string;
  scripts: string[];
  commands: Record<string, string>;
  changed?: number;
  suggested?: string;
}

/** One row of the list. */
export interface Row {
  /** Index into the project list. */
  projectIndex: number;
  script: string;
}

/** A project together with the rows that belong to it. */
export interface Group {
  project: PickerProject;
  rows: Row[];
}

/** The selection: a set of `projectIndex:script` keys. */
export type Selection = ReadonlySet<string>;

/** The key that identifies one row. */
export function rowKey(projectIndex: number, script: string): string {
  return `${projectIndex}:${script}`;
}

/** Every row, in project order. */
export function allRows(projects: PickerProject[]): Row[] {
  return projects.flatMap((project, projectIndex) => project.scripts.map((script) => ({ projectIndex, script })));
}

/** The rows that survive the filter. */
export function visibleRows(rows: Row[], projects: PickerProject[], filter: string): Row[] {
  const needle = filter.trim().toLowerCase();
  if (needle === '') {
    return rows;
  }
  return rows.filter(
    (row) =>
      projects[row.projectIndex]!.name.toLowerCase().includes(needle) ||
      row.script.toLowerCase().includes(needle),
  );
}

/** The visible rows, grouped by project, keeping the project order. */
export function groupRows(rows: Row[], projects: PickerProject[]): Group[] {
  const groups: Group[] = [];
  for (const row of rows) {
    const project = projects[row.projectIndex]!;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.project === project) {
      last.rows.push(row);
    } else {
      groups.push({ project, rows: [row] });
    }
  }
  return groups;
}

/** Adds or removes one row from the selection. */
export function toggle(selection: Selection, projectIndex: number, script: string): Selection {
  const next = new Set(selection);
  const key = rowKey(projectIndex, script);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

/**
 * Selects every visible row, or clears them when they are all selected
 * already.
 */
export function toggleAll(selection: Selection, rows: Row[]): Selection {
  const next = new Set(selection);
  const allOn = rows.every((row) => next.has(rowKey(row.projectIndex, row.script)));
  for (const row of rows) {
    const key = rowKey(row.projectIndex, row.script);
    if (allOn) {
      next.delete(key);
    } else {
      next.add(key);
    }
  }
  return next;
}

/** The selection the picker starts with: the suggested script of every project that has one. */
export function initialSelection(projects: PickerProject[]): Selection {
  const selection = new Set<string>();
  projects.forEach((project, projectIndex) => {
    if (project.suggested !== undefined) {
      selection.add(rowKey(projectIndex, project.suggested));
    }
  });
  return selection;
}

/**
 * What the user chose: the selected scripts of every project, in the order
 * the projects were listed.
 */
export function chosenScripts(selection: Selection, rows: Row[], projects: PickerProject[]): Map<string, string[]> {
  const chosen = new Map<string, string[]>();
  for (const row of rows) {
    if (!selection.has(rowKey(row.projectIndex, row.script))) {
      continue;
    }
    const name = projects[row.projectIndex]!.name;
    chosen.set(name, [...(chosen.get(name) ?? []), row.script]);
  }
  return chosen;
}

/**
 * The next cursor position, given a key press.
 *
 * Returns `-1` when the key does not move the cursor.
 */
export function moveCursor(cursor: number, direction: 'up' | 'down' | 'first' | 'last', count: number): number {
  switch (direction) {
    case 'up':
      return Math.max(0, cursor - 1);
    case 'down':
      return Math.min(Math.max(0, count - 1), cursor + 1);
    case 'first':
      return 0;
    case 'last':
      return Math.max(0, count - 1);
    default:
      return cursor;
  }
}
