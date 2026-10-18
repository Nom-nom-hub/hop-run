import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectPackageManager,
  packageManagerCommand,
  runScripts,
  type PortRedirect,
  type RunSpec,
} from '../src/executor.js';
import { findFreePort } from '../src/ports.js';

const ANSI = /\u001b\[[0-9;]*m/g;

interface Capture {
  text(): string;
  stream: { write(chunk: string): boolean };
}

function createCapture(): Capture {
  let buffer = '';
  return {
    text: () => buffer.replace(ANSI, ''),
    stream: {
      write(chunk: string): boolean {
        buffer += chunk;
        return true;
      },
    },
  };
}

interface HeldPort {
  port: number;
  close(): Promise<void>;
}

/** Starts a throwaway TCP server (0 = let the OS choose). */
function holdPort(port = 0): Promise<HeldPort> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1' }, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      resolve({
        port: bound,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

async function pickFreePort(start = 23_000): Promise<number> {
  const port = await findFreePort(start);
  if (port === null) {
    throw new Error(`no free port above ${start}`);
  }
  return port;
}

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return condition();
}

/** Cross-platform liveness probe (signal 0 works on Windows too). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A node script that spawns a grandchild, records its pid and then idles. */
const SPAWNER_SOURCE = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  "fs.writeFileSync(path.join(__dirname, 'grandchild.pid'), String(child.pid));",
  'setInterval(() => {}, 1000);',
  '',
].join('\n');

/** A node script that starts listening on `process.env.PORT` (or argv) after 250 ms. */
const LATE_SERVER_SOURCE = [
  "const net = require('node:net');",
  'const port = Number(process.env.PORT ?? process.argv[2]);',
  'setTimeout(() => {',
  '  const server = net.createServer(() => {});',
  "  server.listen(port, '127.0.0.1', () => console.log('listening on ' + port));",
  '}, 250);',
  'setInterval(() => {}, 1000);',
  '',
].join('\n');

const cwdCommand = 'node -e "console.log(process.cwd())"';

/** Writes an executable fixture tool into a `node_modules/.bin` style folder. */
async function writeFixtureTool(binDir: string, name: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  if (process.platform === 'win32') {
    await writeFile(path.join(binDir, `${name}.cmd`), '@echo off\r\necho FIXTURE_OK\r\n', 'utf8');
  } else {
    await writeFile(path.join(binDir, name), '#!/bin/sh\necho FIXTURE_OK\n', { encoding: 'utf8', mode: 0o755 });
  }
}

describe('runScripts', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hop-exec-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('runs a command with the target directory as cwd and prefixes its output', async () => {
    const capture = createCapture();
    const spec: RunSpec = {
      name: 'frontend',
      dir: root,
      script: 'cwd',
      command: cwdCommand,
    };

    const { results, interrupted } = await runScripts([spec], {
      stream: capture.stream,
      registerSignalHandlers: false,
    });

    expect(interrupted).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'frontend', script: 'cwd', code: 0, ok: true });
    expect(results[0]?.durationMs).toBeGreaterThanOrEqual(0);

    const line = capture
      .text()
      .split('\n')
      .find((candidate) => candidate.startsWith('[frontend] ') && candidate.includes(root.slice(0, 4)));
    expect(line).toBeDefined();
    expect(line?.toLowerCase()).toContain(path.resolve(root).toLowerCase());
  });

  it('streams several targets concurrently with aligned [name] tags', async () => {
    const capture = createCapture();

    const { results } = await runScripts(
      [
        { name: 'api', dir: root, script: 'hello', command: 'node -e "console.log(\'hi from api\')"' },
        { name: 'frontend', dir: root, script: 'hello', command: 'node -e "console.log(\'hi from frontend\')"' },
      ],
      { stream: capture.stream, registerSignalHandlers: false },
    );

    const output = capture.text();
    expect(output).toContain(`[${'api'.padEnd(8)}] hi from api`);
    expect(output).toContain('[frontend] hi from frontend');
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it('prefixes stderr lines just like stdout', async () => {
    const capture = createCapture();

    await runScripts([{ name: 'logs', dir: root, script: 'boom', command: 'node -e "console.error(\'kaboom\')"' }], {
      stream: capture.stream,
      registerSignalHandlers: false,
    });

    expect(capture.text()).toContain('[logs] kaboom');
  });

  it('propagates non-zero exit codes', async () => {
    const capture = createCapture();

    const { results } = await runScripts(
      [{ name: 'failing', dir: root, script: 'die', command: 'node -e "process.exit(3)"' }],
      { stream: capture.stream, registerSignalHandlers: false },
    );

    expect(results[0]).toMatchObject({ code: 3, ok: false });
  });

  it('captures a raw thrown error as exit 1 with its stderr', async () => {
    const capture = createCapture();

    const { results } = await runScripts(
      [{ name: 'crash', dir: root, script: 'boom', command: 'node -e "throw new Error(\'raw boom\')"' }],
      { stream: capture.stream, registerSignalHandlers: false },
    );

    expect(results[0]).toMatchObject({ code: 1, ok: false });
    expect(capture.text()).toContain('[crash]');
    expect(capture.text()).toContain('raw boom');
    expect(capture.text()).toContain('exit 1');
  });

  it('captures an unexpected exit status verbatim', async () => {
    const capture = createCapture();

    const { results } = await runScripts(
      [{ name: 'odd', dir: root, script: 'die', command: 'node -e "process.exit(42)"' }],
      { stream: capture.stream, registerSignalHandlers: false },
    );

    expect(results[0]).toMatchObject({ code: 42, ok: false });
    expect(capture.text()).toContain('exit 42');
  });

  it('kills the whole tree — grandchildren included — when interrupted', async () => {
    const capture = createCapture();
    const pidFile = path.join(root, 'grandchild.pid');
    await writeFile(path.join(root, 'spawner.js'), SPAWNER_SOURCE, 'utf8');

    const run = runScripts([{ name: 'tree', dir: root, script: 'dev', command: 'node spawner.js' }], {
      stream: capture.stream,
      registerSignalHandlers: true,
      killTimeoutMs: 5_000,
    });

    expect(await waitUntil(() => existsSync(pidFile), 8_000)).toBe(true);
    const grandchild = Number(await readFile(pidFile, 'utf8'));
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(isAlive(grandchild)).toBe(true);

    process.emit('SIGINT', 'SIGINT');
    const { interrupted } = await run;

    expect(interrupted).toBe(true);
    expect(await waitUntil(() => !isAlive(grandchild), 5_000)).toBe(true);
    expect(capture.text()).toContain('received SIGINT');
  });

  it('flushes a final line that has no trailing newline', async () => {
    const capture = createCapture();

    await runScripts(
      [{ name: 'partial', dir: root, script: 'print', command: 'node -e "process.stdout.write(\'no newline\')"' }],
      { stream: capture.stream, registerSignalHandlers: false },
    );

    expect(capture.text()).toContain('[partial] no newline');
  });

  it('passes extra environment variables to the children', async () => {
    const capture = createCapture();

    await runScripts([{ name: 'env', dir: root, script: 'env', command: 'node -e "console.log(process.env.HOP_TEST)"' }], {
      stream: capture.stream,
      registerSignalHandlers: false,
      env: { HOP_TEST: 'injected' },
    });

    expect(capture.text()).toContain('[env] injected');
  });

  it('reports spawn failures (missing cwd) instead of throwing', async () => {
    const capture = createCapture();

    const { results } = await runScripts(
      [{ name: 'broken', dir: path.join(root, 'does-not-exist'), script: 'dev', command: 'node -e "1"' }],
      { stream: capture.stream, registerSignalHandlers: false },
    );

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toBeTruthy();
    expect(capture.text()).toContain('failed to start');
  });

  it('puts the project node_modules/.bin on PATH for node targets', async () => {
    const capture = createCapture();
    await writeFixtureTool(path.join(root, 'node_modules', '.bin'), 'fixture-tool');

    const { results } = await runScripts(
      [{ name: 'app', dir: root, script: 'tool', command: 'fixture-tool', type: 'node' }],
      { stream: capture.stream, registerSignalHandlers: false },
    );

    expect(capture.text()).toContain('[app] FIXTURE_OK');
    expect(results[0]?.ok).toBe(true);
  });

  it('also resolves binaries hoisted into an ancestor node_modules/.bin', async () => {
    const capture = createCapture();
    const nested = path.join(root, 'packages', 'web');
    await mkdir(nested, { recursive: true });
    await writeFixtureTool(path.join(root, 'node_modules', '.bin'), 'hoisted-tool');

    const { results } = await runScripts(
      [{ name: 'web', dir: nested, script: 'tool', command: 'hoisted-tool', type: 'node' }],
      { stream: capture.stream, registerSignalHandlers: false },
    );

    expect(capture.text()).toContain('[web] FIXTURE_OK');
    expect(results[0]?.ok).toBe(true);
  });

  it('does not inject node_modules/.bin for non-node targets', async () => {
    const capture = createCapture();
    await writeFixtureTool(path.join(root, 'node_modules', '.bin'), 'fixture-tool');

    const { results } = await runScripts(
      [{ name: 'app', dir: root, script: 'tool', command: 'fixture-tool' }],
      { stream: capture.stream, registerSignalHandlers: false },
    );

    expect(results[0]?.ok).toBe(false);
  });

  it('exposes npm lifecycle variables to node targets', async () => {
    const capture = createCapture();

    await runScripts(
      [{ name: 'app', dir: root, script: 'dev', command: 'node -e "console.log(process.env.npm_lifecycle_event)"', type: 'node' }],
      { stream: capture.stream, registerSignalHandlers: false },
    );

    expect(capture.text()).toContain('[app] dev');
  });

  it('returns an empty summary for an empty spec list', async () => {
    const capture = createCapture();

    const summary = await runScripts([], { stream: capture.stream, registerSignalHandlers: false });

    expect(summary).toEqual({ results: [], interrupted: false, signal: null });
    expect(capture.text()).toBe('');
  });

  it('only installs signal handlers when asked', async () => {
    const capture = createCapture();
    const before = process.listenerCount('SIGINT');

    await runScripts([{ name: 'noop', dir: root, script: 'ok', command: 'node -e "0"' }], {
      stream: capture.stream,
      registerSignalHandlers: false,
    });
    expect(process.listenerCount('SIGINT')).toBe(before);

    await runScripts([{ name: 'noop', dir: root, script: 'ok', command: 'node -e "0"' }], {
      stream: capture.stream,
      registerSignalHandlers: true,
    });
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('kills every child process when hop is interrupted', async () => {
    const capture = createCapture();
    const startedAt = Date.now();

    const run = runScripts(
      [
        { name: 'server', dir: root, script: 'dev', command: 'node -e "setInterval(() => {}, 1000)"' },
        { name: 'worker', dir: root, script: 'dev', command: 'node -e "setInterval(() => {}, 1000)"' },
      ],
      { stream: capture.stream, registerSignalHandlers: true, killTimeoutMs: 5_000 },
    );

    // Let both children boot, then emulate Ctrl+C reaching hop.
    setTimeout(() => process.emit('SIGINT', 'SIGINT'), 300);

    const { interrupted, signal, results } = await run;
    const elapsed = Date.now() - startedAt;

    expect(interrupted).toBe(true);
    expect(signal).toBe('SIGINT');
    expect(results).toHaveLength(2);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(capture.text()).toContain('received SIGINT');
    // Stopped by the SIGTERM pass, well before the 5s force-kill timer.
    expect(elapsed).toBeLessThan(4_000);
  });
});

describe('port conflict resolution', () => {
  let root: string;
  let savedPort: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hop-ports-'));
    savedPort = process.env.PORT;
    delete process.env.PORT; // keep the ambient environment out of the fixtures
  });

  afterEach(async () => {
    if (savedPort !== undefined) {
      process.env.PORT = savedPort;
    } else {
      delete process.env.PORT;
    }
    await rm(root, { recursive: true, force: true });
  });

  const printPort = 'node -e "console.log(\'port=\' + process.env.PORT)"';

  it('moves a blocked port and reports the swap through onPortRedirect', async () => {
    const held = await holdPort();
    const redirects: PortRedirect[] = [];
    const capture = createCapture();
    await writeFile(path.join(root, '.env'), `PORT=${held.port}\n`, 'utf8');

    try {
      const { results } = await runScripts(
        [{ name: 'backend', dir: root, script: 'dev', command: printPort, type: 'node' }],
        {
          stream: capture.stream,
          registerSignalHandlers: false,
          hooks: { onPortRedirect: (redirect) => redirects.push(redirect) },
        },
      );

      expect(redirects).toHaveLength(1);
      const redirect = redirects[0];
      expect(redirect).toMatchObject({ name: 'backend', script: 'dev', from: held.port, source: 'dotenv' });
      expect(redirect?.to).toBeGreaterThan(held.port);
      expect(capture.text()).toContain(`port=${redirect?.to}`);
      expect(results[0]?.ok).toBe(true);
    } finally {
      await held.close();
    }
  });

  it('leaves a free port alone', async () => {
    const free = await pickFreePort();
    const redirects: PortRedirect[] = [];
    const capture = createCapture();
    await writeFile(path.join(root, '.env'), `PORT=${free}\n`, 'utf8');

    const { results } = await runScripts([{ name: 'backend', dir: root, script: 'dev', command: printPort, type: 'node' }], {
      stream: capture.stream,
      registerSignalHandlers: false,
      hooks: { onPortRedirect: (redirect) => redirects.push(redirect) },
    });

    expect(redirects).toHaveLength(0);
    expect(capture.text()).toContain(`port=${free}`);
    expect(results[0]?.ok).toBe(true);
  });

  it('never hands the same port to two targets', async () => {
    const free = await pickFreePort();
    const redirects: PortRedirect[] = [];
    const capture = createCapture();
    await writeFile(path.join(root, '.env'), `PORT=${free}\n`, 'utf8');

    const { results } = await runScripts(
      [
        { name: 'a', dir: root, script: 'dev', command: printPort, type: 'node' },
        { name: 'b', dir: root, script: 'dev', command: printPort, type: 'node' },
      ],
      {
        stream: capture.stream,
        registerSignalHandlers: false,
        hooks: { onPortRedirect: (redirect) => redirects.push(redirect) },
      },
    );

    expect(redirects).toHaveLength(1);
    expect(redirects[0]).toMatchObject({ name: 'b', from: free });
    expect(redirects[0]?.to).not.toBe(free);
    expect(capture.text()).toContain(`[a] port=${free}`);
    expect(capture.text()).toContain(`[b] port=${redirects[0]?.to}`);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it('rewrites a blocked --port flag inside the command itself', async () => {
    const held = await holdPort();
    const redirects: PortRedirect[] = [];
    const capture = createCapture();
    await writeFile(path.join(root, 'argv.js'), "console.log('argv=' + process.argv.slice(2).join(','));\n", 'utf8');

    try {
      await runScripts([{ name: 'web', dir: root, script: 'dev', command: `node argv.js --port ${held.port}`, type: 'node' }], {
        stream: capture.stream,
        registerSignalHandlers: false,
        hooks: { onPortRedirect: (redirect) => redirects.push(redirect) },
      });

      expect(redirects).toHaveLength(1);
      expect(redirects[0]).toMatchObject({ from: held.port, source: 'flag' });
      expect(capture.text()).toContain(`argv=--port,${redirects[0]?.to}`);
    } finally {
      await held.close();
    }
  });
});

describe('dependency handshakes', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hop-gate-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('holds a dependent back until its service is listening', async () => {
    const capture = createCapture();
    const port = await pickFreePort(24_000);
    const apiDir = path.join(root, 'api');
    const frontendDir = path.join(root, 'frontend');
    await mkdir(apiDir, { recursive: true });
    await mkdir(frontendDir, { recursive: true });
    await writeFile(path.join(frontendDir, '.env'), `VITE_API_URL=http://localhost:${port}\n`, 'utf8');
    await writeFile(path.join(apiDir, 'api.js'), LATE_SERVER_SOURCE, 'utf8');

    const events: string[] = [];
    const run = runScripts(
      [
        { name: 'api', dir: apiDir, script: 'dev', command: `node api.js --port ${port}`, type: 'node' },
        { name: 'frontend', dir: frontendDir, script: 'dev', command: 'node -e "console.log(\'frontend started\')"', type: 'node' },
      ],
      {
        stream: capture.stream,
        registerSignalHandlers: true,
        healthIntervalMs: 25,
        healthTimeoutMs: 10_000,
        hooks: {
          onWaitStart: (gate) => events.push(`start:${gate.name}`),
          onWaitEnd: (gate, outcome) => events.push(`end:${gate.name}:${outcome}`),
        },
      },
    );

    expect(await waitUntil(() => capture.text().includes('frontend started'), 10_000)).toBe(true);
    process.emit('SIGINT', 'SIGINT');
    const { interrupted, results } = await run;

    expect(interrupted).toBe(true);
    expect(events).toEqual(['start:frontend', 'end:frontend:ready']);
    const text = capture.text();
    expect(text).toContain(`listening on ${port}`);
    expect(text.indexOf(`listening on ${port}`)).toBeLessThan(text.indexOf('frontend started'));
    expect(results.find((result) => result.name === 'api')).toMatchObject({ ok: false });
  });

  it('waits for a docker service published by a compose file', async () => {
    const capture = createCapture();
    const port = await pickFreePort(24_500);
    const databaseDir = path.join(root, 'database');
    const apiDir = path.join(root, 'api');
    await mkdir(databaseDir, { recursive: true });
    await mkdir(apiDir, { recursive: true });
    await writeFile(
      path.join(databaseDir, 'docker-compose.yml'),
      `services:\n  db:\n    image: postgres\n    ports:\n      - "${port}:5432"\n`,
      'utf8',
    );
    await writeFile(path.join(databaseDir, 'fake-db.js'), LATE_SERVER_SOURCE, 'utf8');
    await writeFile(path.join(apiDir, '.env'), `DATABASE_URL=postgres://user:pass@localhost:${port}/app\n`, 'utf8');

    let waitingFor: string[] = [];
    const run = runScripts(
      [
        { name: 'database', dir: databaseDir, script: 'up', command: `node fake-db.js ${port}`, type: 'docker' },
        { name: 'api', dir: apiDir, script: 'dev', command: 'node -e "console.log(\'api started\')"', type: 'node' },
      ],
      {
        stream: capture.stream,
        registerSignalHandlers: true,
        healthIntervalMs: 25,
        healthTimeoutMs: 10_000,
        hooks: {
          onWaitStart: (gate) => {
            waitingFor = gate.dependencies.map((dependency) => dependency.name);
          },
        },
      },
    );

    expect(await waitUntil(() => capture.text().includes('api started'), 10_000)).toBe(true);
    process.emit('SIGINT', 'SIGINT');
    await run;

    expect(waitingFor).toEqual(['database']);
    const text = capture.text();
    expect(text).toContain(`listening on ${port}`);
    expect(text.indexOf(`listening on ${port}`)).toBeLessThan(text.indexOf('api started'));
  });

  it('releases a dependent that never arrives after the timeout, without failing it', async () => {
    const capture = createCapture();
    const deadPort = await pickFreePort(25_000);
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'frontend', hop: { waitFor: [deadPort] } }),
      'utf8',
    );

    const outcomes: string[] = [];
    const startedAt = Date.now();
    const { results } = await runScripts(
      [{ name: 'frontend', dir: root, script: 'dev', command: 'node -e "console.log(\'started anyway\')"', type: 'node' }],
      {
        stream: capture.stream,
        registerSignalHandlers: false,
        healthTimeoutMs: 200,
        healthIntervalMs: 25,
        hooks: { onWaitEnd: (_gate, outcome) => outcomes.push(outcome) },
      },
    );

    expect(outcomes).toEqual(['timeout']);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);
    expect(capture.text()).toContain('started anyway');
    expect(results[0]?.ok).toBe(true); // a missing dependency is advice, not a failure
  });

  it('skips handshakes entirely with waitForDependencies: false', async () => {
    const capture = createCapture();
    const deadPort = await pickFreePort(25_500);
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'frontend', hop: { waitFor: [deadPort] } }),
      'utf8',
    );

    const events: string[] = [];
    const { results } = await runScripts(
      [{ name: 'frontend', dir: root, script: 'dev', command: 'node -e "console.log(\'started anyway\')"', type: 'node' }],
      {
        stream: capture.stream,
        registerSignalHandlers: false,
        waitForDependencies: false,
        hooks: { onWaitStart: (gate) => events.push(gate.name) },
      },
    );

    expect(events).toEqual([]);
    expect(capture.text()).toContain('started anyway');
    expect(results[0]?.ok).toBe(true);
  });

  it('does not start a waiting dependent when hop is interrupted', async () => {
    const capture = createCapture();
    const deadPort = await pickFreePort(26_000);
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'frontend', hop: { waitFor: [deadPort] } }),
      'utf8',
    );

    const outcomes: string[] = [];
    const startedAt = Date.now();
    const run = runScripts(
      [{ name: 'frontend', dir: root, script: 'dev', command: 'node -e "console.log(\'never starts\')"', type: 'node' }],
      {
        stream: capture.stream,
        registerSignalHandlers: true,
        healthTimeoutMs: 30_000, // would hold the run for half a minute if abort did not work
        healthIntervalMs: 25,
        hooks: { onWaitEnd: (_gate, outcome) => outcomes.push(outcome) },
      },
    );
    setTimeout(() => process.emit('SIGINT', 'SIGINT'), 250);

    const { interrupted, results } = await run;

    expect(interrupted).toBe(true);
    expect(outcomes).toEqual(['aborted']);
    expect(results[0]?.error).toBe('not started (interrupted)');
    expect(capture.text()).not.toContain('never starts');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe('detectPackageManager', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hop-pm-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('falls back to npm without a lockfile', () => {
    expect(detectPackageManager(root)).toBe('npm');
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ] as const)('detects %s as %s', async (lockfile, expected) => {
    await writeFile(path.join(root, lockfile), '', 'utf8');
    expect(detectPackageManager(root)).toBe(expected);
  });

  it('picks up the lockfile of a monorepo ancestor', async () => {
    await writeFile(path.join(root, 'pnpm-lock.yaml'), '', 'utf8');
    const nested = path.join(root, 'packages', 'web');
    await mkdir(nested, { recursive: true });

    expect(detectPackageManager(nested)).toBe('pnpm');
  });

  it('prefers the nearest lockfile when nested projects use different managers', async () => {
    await writeFile(path.join(root, 'yarn.lock'), '', 'utf8');
    const nested = path.join(root, 'tools', 'cli');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, 'package-lock.json'), '', 'utf8');

    expect(detectPackageManager(nested)).toBe('npm');
  });
});

describe('packageManagerCommand', () => {
  it('builds a run command per manager', () => {
    expect(packageManagerCommand('npm', 'dev')).toBe('npm run dev');
    expect(packageManagerCommand('pnpm', 'build')).toBe('pnpm run build');
    expect(packageManagerCommand('yarn', 'test')).toBe('yarn run test');
    expect(packageManagerCommand('bun', 'start')).toBe('bun run start');
  });

  it('quotes script names that need it', () => {
    expect(packageManagerCommand('npm', 'my script')).toBe('npm run "my script"');
  });
});
