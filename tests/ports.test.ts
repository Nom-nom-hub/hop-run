import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findFreePort,
  isPortFree,
  parsePort,
  planPort,
  portFromEnvContent,
  preferredPort,
  readDotenvPort,
  readFlagPort,
  rewriteFlagPort,
} from '../src/ports.js';

/** Base for port hunting: below the Windows ephemeral range, so it stays quiet. */
const BASE_PORT = 21_000;

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

/** Picks a free port that nothing holds. */
async function pickFreePort(start = BASE_PORT): Promise<number> {
  const port = await findFreePort(start);
  if (port === null) {
    throw new Error(`no free port above ${start}`);
  }
  return port;
}

/** Picks two consecutive free ports (for "nothing nearby works" cases). */
async function pickFreePair(start = BASE_PORT): Promise<[number, number]> {
  for (let port = start; port < start + 300; port += 1) {
    if ((await isPortFree(port)) && (await isPortFree(port + 1))) {
      return [port, port + 1];
    }
  }
  throw new Error(`no consecutive free ports above ${start}`);
}

describe('parsePort', () => {
  it('accepts numbers and numeric strings inside 1…65535', () => {
    expect(parsePort(3000)).toBe(3000);
    expect(parsePort('3000')).toBe(3000);
    expect(parsePort(' 8080 ')).toBe(8080);
    expect(parsePort(1)).toBe(1);
    expect(parsePort('65535')).toBe(65535);
  });

  it('rejects everything else', () => {
    expect(parsePort(0)).toBeUndefined();
    expect(parsePort('0')).toBeUndefined();
    expect(parsePort(65_536)).toBeUndefined();
    expect(parsePort('99999')).toBeUndefined();
    expect(parsePort('abc')).toBeUndefined();
    expect(parsePort('')).toBeUndefined();
    expect(parsePort('30.5')).toBeUndefined();
    expect(parsePort(3000.5)).toBeUndefined();
    expect(parsePort(undefined)).toBeUndefined();
    expect(parsePort(null)).toBeUndefined();
  });
});

describe('isPortFree', () => {
  it('reports a held port as taken and frees it again afterwards', async () => {
    const held = await holdPort();

    expect(await isPortFree(held.port)).toBe(false);
    await held.close();
    expect(await isPortFree(held.port)).toBe(true);
  });

  it('reports an unused port as free', async () => {
    const port = await pickFreePort();
    expect(await isPortFree(port)).toBe(true);
  });
});

describe('findFreePort', () => {
  it('returns the requested port when it is free', async () => {
    const free = await pickFreePort();
    expect(await findFreePort(free)).toBe(free);
  });

  it('steps over a taken port', async () => {
    const [blocked, next] = await pickFreePair();
    const held = await holdPort(blocked);

    try {
      expect(await findFreePort(blocked)).toBe(next);
    } finally {
      await held.close();
    }
  });

  it('never returns a port a sibling already reserved', async () => {
    const free = await pickFreePort();
    const reserved = new Set([free]);

    expect(await findFreePort(free, { reserved })).toBeGreaterThan(free);
  });

  it('gives up once the search limit is exhausted', async () => {
    const free = await pickFreePort();
    const reserved = new Set([free]);

    expect(await findFreePort(free, { reserved, limit: 1 })).toBeNull();
  });
});

describe('portFromEnvContent', () => {
  it('reads plain, quoted and exported entries', () => {
    expect(portFromEnvContent('PORT=3000')).toBe(3000);
    expect(portFromEnvContent('PORT="3000"')).toBe(3000);
    expect(portFromEnvContent("PORT='4000'")).toBe(4000);
    expect(portFromEnvContent('export PORT=5000')).toBe(5000);
    expect(portFromEnvContent('port=6000')).toBe(6000);
  });

  it('skips comments, blanks and unrelated keys', () => {
    expect(portFromEnvContent('# PORT=1\n\nHOST=localhost\nPORT=8080')).toBe(8080);
    expect(portFromEnvContent('PORTX=1\nPORT=9090 # web')).toBe(9090);
    expect(portFromEnvContent('FROM_PORT=1')).toBeUndefined();
    expect(portFromEnvContent('')).toBeUndefined();
  });

  it('keeps looking when an early entry is not a valid port', () => {
    expect(portFromEnvContent('PORT=abc\nPORT=7000')).toBe(7000);
    expect(portFromEnvContent('PORT=')).toBeUndefined();
  });
});

describe('readDotenvPort', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hop-dotenv-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads .env and falls back to .env.local', async () => {
    await writeFile(path.join(root, '.env.local'), 'PORT=4001\n', 'utf8');
    expect(readDotenvPort(root)).toBe(4001);

    await writeFile(path.join(root, '.env'), 'PORT=4000\n', 'utf8');
    expect(readDotenvPort(root)).toBe(4000);
  });

  it('skips env files that do not declare a port', async () => {
    await writeFile(path.join(root, '.env'), 'HOST=localhost\n', 'utf8');
    await writeFile(path.join(root, '.env.development'), 'PORT=4002\n', 'utf8');

    expect(readDotenvPort(root)).toBe(4002);
  });

  it('returns undefined without env files', () => {
    expect(readDotenvPort(root)).toBeUndefined();
  });
});

describe('readFlagPort / rewriteFlagPort', () => {
  it('finds --port in both spellings', () => {
    expect(readFlagPort('next dev --port 3000')).toBe(3000);
    expect(readFlagPort('vite --port=4000 --host')).toBe(4000);
    expect(readFlagPort('node server.js')).toBeUndefined();
    expect(readFlagPort('-p 3000')).toBeUndefined(); // too ambiguous to touch
    expect(readFlagPort('serve --port 99999')).toBeUndefined();
  });

  it('rewrites only the matching flag', () => {
    expect(rewriteFlagPort('vite --port 3000', 3000, 3001)).toBe('vite --port 3001');
    expect(rewriteFlagPort('vite --port=3000', 3000, 3001)).toBe('vite --port=3001');
    expect(rewriteFlagPort('vite --port 3000 --port 3000', 3000, 3001)).toBe('vite --port 3001 --port 3000');
    expect(rewriteFlagPort('vite --port 43000', 3000, 3001)).toBe('vite --port 43000');
  });
});

describe('preferredPort', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hop-pref-'));
    await writeFile(path.join(root, '.env'), 'PORT=7000\n', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('prefers an explicit flag over the environment and .env', () => {
    expect(preferredPort({ env: { PORT: '8000' }, dir: root, command: 'next dev --port 9000' })).toEqual({
      port: 9000,
      source: 'flag',
    });
  });

  it('prefers the environment over .env (case-insensitively)', () => {
    expect(preferredPort({ env: { port: '8000' }, dir: root, command: 'node server.js' })).toEqual({
      port: 8000,
      source: 'env',
    });
  });

  it('falls back to .env', () => {
    expect(preferredPort({ env: {}, dir: root, command: 'node server.js' })).toEqual({ port: 7000, source: 'dotenv' });
  });

  it('reports nothing when no port is configured anywhere', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'hop-bare-'));
    try {
      expect(preferredPort({ env: {}, dir: bare, command: 'go run .' })).toBeUndefined();
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe('planPort', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hop-plan-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns undefined when the command has no port preference', async () => {
    expect(await planPort({ env: {}, dir: root, command: 'go run .' })).toBeUndefined();
  });

  it('keeps a free port untouched', async () => {
    const free = await pickFreePort();
    const reserved = new Set<number>();

    const plan = await planPort({ env: { PORT: String(free) }, dir: root, command: 'node server.js', reserved });

    expect(plan).toMatchObject({ port: free, target: free, changed: false, exhausted: false, source: 'env' });
    expect(reserved.has(free)).toBe(true);
  });

  it('moves to the next free port when the preferred one is taken', async () => {
    const held = await holdPort();
    const reserved = new Set<number>();

    try {
      const plan = await planPort({
        env: { PORT: String(held.port) },
        dir: root,
        command: 'node server.js',
        reserved,
      });

      expect(plan?.changed).toBe(true);
      expect(plan?.exhausted).toBe(false);
      expect(plan?.port).toBe(held.port);
      expect(plan?.target).toBeGreaterThan(held.port);
      expect(reserved.has(plan?.target ?? 0)).toBe(true);
    } finally {
      await held.close();
    }
  });

  it('treats a port reserved by a sibling as taken', async () => {
    const free = await pickFreePort();
    const reserved = new Set<number>();

    const first = await planPort({ env: { PORT: String(free) }, dir: root, command: 'node a.js', reserved });
    const second = await planPort({ env: { PORT: String(free) }, dir: root, command: 'node b.js', reserved });

    expect(first?.target).toBe(free);
    expect(second?.changed).toBe(true);
    expect(second?.target).not.toBe(free);
  });

  it('reports exhaustion when nothing nearby is usable', async () => {
    const [blocked, neighbour] = await pickFreePair();
    const first = await holdPort(blocked);
    const second = await holdPort(neighbour);

    try {
      const plan = await planPort({
        env: { PORT: String(blocked) },
        dir: root,
        command: 'node server.js',
        limit: 1,
      });

      expect(plan).toMatchObject({ port: blocked, target: blocked, changed: false, exhausted: true });
    } finally {
      await first.close();
      await second.close();
    }
  });
});
