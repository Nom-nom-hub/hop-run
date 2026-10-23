/**
 * The static screens: the help text and the project list.
 *
 * Both are drawn with Ink so they share the picker's typography — the same
 * wordmark, the same rules, the same type colours.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { GLYPH, ROLE, toneForType } from './palette.js';

/** One project as the list screen shows it. */
export interface ListProject {
  name: string;
  type: string;
  /** The path relative to the scan root. */
  path: string;
  scripts: Record<string, string>;
}

export interface ListScreenProps {
  root: string;
  projects: ListProject[];
  /** True when the commands are run through the package manager. */
  npmMode: boolean;
}

export interface HelpProps {
  /** How many levels the scanner reaches below the root. */
  maxDepth: number;
}

interface UsageRow {
  command: string;
  description: string;
}

const USAGE: UsageRow[] = [
  { command: 'hop', description: 'Pick scripts interactively (space toggle · enter run)' },
  { command: 'hop <script>', description: 'Run every matching script everywhere (e.g. hop dev)' },
  { command: 'hop <script> --npm', description: 'Node scripts via their package manager (pre/post hooks run)' },
  { command: 'hop <script> --no-wait', description: 'Start everything at once (skip dependency waits)' },
  { command: 'hop --depth <levels>', description: 'Scan deeper than the default (e.g. hop --depth 5)' },
  { command: 'hop --list, -l', description: 'List detected projects and their scripts' },
  { command: 'hop --help, -h', description: 'Show this help' },
  { command: 'hop --version, -v', description: 'Print the version' },
];

interface DetectionRow {
  kind: string;
  fingerprint: string;
  description: string;
}

const DETECTION: DetectionRow[] = [
  { kind: 'node', fingerprint: 'package.json', description: 'the "scripts" object' },
  { kind: 'docker', fingerprint: 'Dockerfile / compose', description: 'docker build · docker compose up/down' },
  { kind: 'python', fingerprint: 'requirements / pyproject', description: 'python main.py · pip install' },
  { kind: 'go', fingerprint: 'go.mod / *.go', description: 'go run . · go test ./...' },
];

/** A titled section with a rule underneath. */
function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      <Text color={ROLE.muted}>{GLYPH.rule.repeat(46)}</Text>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
}

export function Help({ maxDepth }: HelpProps): React.ReactElement {
  const usageWidth = Math.max(...USAGE.map((row) => row.command.length));
  const kindWidth = Math.max(...DETECTION.map((row) => row.kind.length));
  const fingerprintWidth = Math.max(...DETECTION.map((row) => row.fingerprint.length));

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={ROLE.brand} bold>
          {GLYPH.mark} hop
        </Text>
        <Text color={ROLE.muted}> · zero-config project runner</Text>
      </Box>

      <Section title="Usage">
        {USAGE.map((row) => (
          <Box key={row.command}>
            <Text>  </Text>
            <Text color={ROLE.brand}>{row.command.padEnd(usageWidth)}</Text>
            <Text>  </Text>
            <Text>{row.description}</Text>
          </Box>
        ))}
      </Section>

      <Section title="Detection">
        <Box flexDirection="column">
          <Text>
            <Text>  </Text>
            Scans the current directory and up to <Text bold>{String(maxDepth)}</Text> levels below it,
            skipping
          </Text>
          <Text>  node_modules, .git, dist, build, venv and dot-directories.</Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {DETECTION.map((row) => (
            <Box key={row.kind}>
              <Text>  </Text>
              <Text color={toneForType(row.kind)}>{row.kind.padEnd(kindWidth)}</Text>
              <Text> </Text>
              <Text color={ROLE.muted}>{row.fingerprint.padEnd(fingerprintWidth)}</Text>
              <Text>  </Text>
              <Text>{row.description}</Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text>  </Text>
            Output from every script streams with a <Text color={ROLE.muted}>[folder]</Text> tag;
          </Text>
          <Text>
            <Text>  </Text>
            <Text bold>Ctrl+C</Text> stops every child process hop started.
          </Text>
        </Box>
      </Section>

      <Section title="Smart startup">
        <Box flexDirection="column">
          <Text>
            <Text>  </Text>
            A busy port is swapped for the next free one: hop checks{' '}
            <Text color={ROLE.muted}>--port</Text>, <Text color={ROLE.muted}>$PORT</Text> and{' '}
            <Text color={ROLE.muted}>.env</Text>, then hands the child the new{' '}
            <Text color={ROLE.muted}>PORT</Text>.
          </Text>
          <Text>
            <Text>  </Text>
            Scripts that reference a sibling's port{' '}
            <Text color={ROLE.muted}>(e.g. localhost:4000 or a compose service)</Text> wait for it to answer, up
            to 30 s,
          </Text>
          <Text>
            <Text>  </Text>
            before they start — add <Text color={ROLE.muted}>{'"hop": { "waitFor": [5432] }'}</Text> to pin it.
          </Text>
          <Text>
            <Text>  </Text>
            In a git repository, projects with uncommitted changes are pre-selected.
          </Text>
        </Box>
      </Section>
    </Box>
  );
}

export function ListScreen({ root, projects, npmMode }: ListScreenProps): React.ReactElement {
  const nameWidth = Math.max(...projects.map((project) => project.name.length), 0);
  const allScripts = [...new Set(projects.flatMap((project) => Object.keys(project.scripts)))].sort();

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={ROLE.brand} bold>
          {GLYPH.mark} hop
        </Text>
        <Text color={ROLE.muted}> · </Text>
        <Text bold>{projects.length}</Text>
        <Text color={ROLE.muted}> projects found</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={ROLE.muted}>scripts</Text>
        <Text>  </Text>
        {allScripts.map((script, index) => (
          <React.Fragment key={script}>
            {index > 0 ? <Text color={ROLE.muted}> {GLYPH.dotSmall} </Text> : null}
            <Text color={ROLE.brand}>{script}</Text>
          </React.Fragment>
        ))}
      </Box>

      {projects.map((project) => {
        const tone = toneForType(project.type);
        const scripts = Object.entries(project.scripts);
        const scriptWidth = Math.max(...scripts.map(([name]) => name.length), 0);
        return (
          <Box key={project.name} flexDirection="column" marginTop={1}>
            <Box>
              <Text color={tone} bold>
                {project.name.padEnd(nameWidth)}
              </Text>
              <Text>  </Text>
              <Text color={tone}>{GLYPH.status}</Text>
              <Text> </Text>
              <Text color={ROLE.muted}>{project.type}</Text>
              <Text color={ROLE.muted}> {GLYPH.dotSmall} </Text>
              <Text color={ROLE.muted}>{project.path}</Text>
            </Box>

            {scripts.map(([name, command], index) => {
              const isLast = index === scripts.length - 1;
              const shown = npmMode && project.type === 'node' ? `npm run ${name}` : command;
              return (
                <Box key={name}>
                  {/* The tree hangs two columns in, so the script names line
                      up with each other and not with the project name. */}
                  <Text color={ROLE.muted}>{'  '}{isLast ? GLYPH.last : GLYPH.branch} </Text>
                  <Text bold>{name.padEnd(scriptWidth)}</Text>
                  <Text>  </Text>
                  <Text color={ROLE.muted}>{shown}</Text>
                </Box>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}
