[![hop logo](https://nom-nom-hub.github.io/hop-run/favicon.svg)](https://nom-nom-hub.github.io/hop-run/)

# hop-run

[![npm](https://img.shields.io/npm/v/hop-run)](https://www.npmjs.com/package/hop-run)
[![CI](https://github.com/Nom-nom-hub/hop-run/actions/workflows/ci.yml/badge.svg)](https://github.com/Nom-nom-hub/hop-run/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![website](https://img.shields.io/badge/website-hop--run-22d3ee)](https://nom-nom-hub.github.io/hop-run/)

Zero-config CLI that finds runnable projects in subdirectories and runs their
scripts concurrently — no `cd` required.

**Site:** [nom-nom-hub.github.io/hop-run](https://nom-nom-hub.github.io/hop-run/) — what hop does, and where it sits next to Turborepo, Docker Compose and friends.

```text
my-monorepo/
├── frontend/        package.json        -> dev, build
├── backend/         package.json        -> dev, start
└── database/        docker-compose.yml  -> up, down
```

Then, from the repo root:

```text
$ hop
  ↗ hop · 3 projects detected

  backend · node
  ❯ ◉ dev   node -e "console.log('api listening on :8080')"
    ○ start node dist/index.js

  database · docker
    ◉ up     docker compose up
    ○ down   docker compose down

  frontend · node · 2 changed
    ◉ dev   vite
    ○ build vite build

  ↑/↓ move· space select· a all· / filter· enter run· esc cancel· 3 selected
```

Press <kbd>space</kbd> to pick scripts, <kbd>/</kbd> to filter and
<kbd>enter</kbd> to run. The run itself is a live board — one row per
project, updated in place:

```text
  ↗ hop · 2 of 3 projects · running

  ● backend  dev   running
  ● database up    waiting for database :5432
  ● frontend dev   running

  [backend] api listening on :8080
  [frontend] ready on http://localhost:3000

  ✔ 3/3 scripts succeeded · 2.6s
```

## Install

```bash
npm install -g hop-run   # installs the `hop` command
npx hop-run              # or run it once without installing anything
```

Requires **Node.js 22.12 or newer**; works on Windows, macOS and Linux.

## Usage

```bash
hop                 # interactive picker: projects as groups, scripts as items
hop dev             # run every script named "dev" found while scanning
hop dev --npm       # same, but through npm/pnpm/yarn/bun (pre/post hooks run)
hop dev --no-wait   # start everything at once, skip dependency handshakes
hop --depth 5       # scan five levels below the current directory
hop --list          # print detected projects and their scripts
hop --help
hop --version
```

In the picker: `↑`/`↓` move, `space` toggles a script (or the whole project row —
select-all), `enter` runs the selection, `ctrl+c` cancels without starting
anything.

In a git repository, projects with uncommitted changes are **pre-selected**
(their `dev`/`serve`/`start`/`run` script, plus a `· 3 changed` marker), so
`hop` + `enter` is enough to run what you are working on.

## Detection

Scans the current directory **and up to 3 levels below it**, skipping
`node_modules`, `.git`, `dist`, `build`, `venv`, other common output folders and
dot-directories. Use `--depth <levels>` to reach further:

```bash
hop --depth 5          # scan five levels below the current directory
```

| Environment | Fingerprint files                   | Scripts exposed                              |
| ----------- | ----------------------------------- | -------------------------------------------- |
| Node.js     | `package.json`                      | every key of the `scripts` object            |
| Docker      | `Dockerfile` / `Containerfile`      | `build` → `docker build .`                   |
| Docker      | `docker-compose.yml` / `compose.yml`| `up` → `docker compose up`, `down`           |
| Python      | `requirements.txt`, `pyproject.toml`| `install` → `pip install …`                  |
| Python      | `main.py`                           | `run` → `python main.py`                     |
| Go          | `go.mod`                            | `run` → `go run .`, `test` → `go test ./...` |
| Go          | `*.go` (no `go.mod`)                | `run` → `go run main.go`                     |

Details:

- Several fingerprints in one folder are merged into a single target. Key
  collisions are namespaced, e.g. a `build` script from `package.json` stays
  `build` while the Dockerfile one becomes `docker:build`.
- Duplicate folder names are qualified with their path (`apps/api` vs
  `services/api`).
- A directory's name is used as the output tag and as the project name.

### Go projects

hop understands the two shapes a Go project comes in.

**A module** — a directory with a `go.mod`. The module's own commands work
from its root, so hop offers `go test ./...`, and `go run .` when the root is
itself a program:

```
myapp/
  go.mod
  main.go        → hop sees: run → go run ., test → go test ./...
```

**A module whose programs live in `cmd/`** — the root is not a program, so
hop does not offer a `run` there; each program below it is a project of its
own, and runs inside the module:

```
myapp/
  go.mod
  cmd/api/       → hop sees: run → go run .
  cmd/worker/    → hop sees: run → go run .
```

**A program without a module** — `go run .` refuses to start without a
`go.mod`, so hop names the files instead:

```
myapp/
  main.go        → hop sees: run → go run main.go
```

A `vendor/` directory is skipped: it holds third-party sources, not projects.

## How node scripts run

By default hop executes the script's command **directly** in the project
directory. To keep local CLI tools working, it sets up the same environment
`npm run` would:

- every `node_modules/.bin` between the project and the filesystem root is
  prepended to `PATH` (nearest first), so hoisted monorepos work and `vite`,
  `tsc`, `vitest`, … resolve without a global install;
- `npm_lifecycle_event` / `npm_lifecycle_script` are set to the script name and
  command.

With `--npm` hop instead runs `<pm> run <script>` and lets the package manager
do the work, which additionally runs `pre*`/`post*` hooks and exports
`npm_config_*` variables. The manager is detected from the nearest lockfile
(`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lock` → bun, otherwise npm),
walking up through ancestors so monorepo packages follow the root. Other
ecosystems (docker/python/go) always run their raw command.

```bash
hop dev            # raw:   node -e "…"      (fast, no hooks)
hop dev --npm      # npm run dev             (hooks + npm env)
hop --list --npm   # shows the npm-style commands that would run
```

## Smart startup

### Port conflicts are resolved before they happen

Before spawning a target, hop works out which port it wants to listen on —
in this order: an explicit `--port 3000` / `--port=3000` flag, `$PORT`, then
`PORT=` in the project's `.env` / `.env.local` / `.env.development`.

If that port is already taken, hop walks upward until it finds a free one,
rewrites the `--port` flag when the command had one, and hands the child the new
port through `PORT` (real environment variables beat `.env` in every mainstream
framework, so injecting `PORT` is enough to move an app that reads it from a
file):

```text
[hop] ⚠ port 8080 was blocked · redirecting [backend] to port 8081
[backend] server bound 127.0.0.1:8081
```

Ports are also reserved per run, so two projects that want `3000` never collide:
the first keeps it, the rest are moved aside. Docker targets are never rewritten
— hop only reads the host ports published by their compose file and keeps other
projects away from them.

### Dependencies are awaited, not raced

When a project clearly talks to a sibling service — `localhost:4000` in an
`.env` file, a bundler proxy config, a fetch in a script command, or a port a
sibling publishes — hop holds that script back until the port actually accepts
connections:

```text
[hop] waiting for database :5432 before starting api
[database] database system is ready to accept connections
[hop] ✔ database :5432 is up · 1.4s · starting api
[api] api started on :4000
```

- On a TTY the wait shows an animated `@clack/prompts` spinner; as soon as any
  child produces output (or a second project starts waiting) hop switches to
  plain `[hop]` lines so the spinner never fights the log.
- The wait is capped at **30 s**; on timeout hop warns and starts the project
  anyway — a dependency gate is advice, never a hard failure.
- `Ctrl+C` during a wait aborts it immediately instead of holding the run.
- `--no-wait` disables the handshake entirely.

Explicit config (checked before any heuristic, and honoured even when hop is not
the one starting the service) lives in `package.json`:

```json
{
  "hop": { "waitFor": [5432, "localhost:6379", "http://127.0.0.1:8080/health"] }
}
```

## Output & signal handling

- Every line of child stdout/stderr is streamed with an aligned, colored
  `[folder]` tag.
- Children are spawned with `FORCE_COLOR=1` (unless `NO_COLOR`/`FORCE_COLOR`
  are already set), so most tools keep their colors even though hop pipes them.
- `Ctrl+C` stops **all** children: `SIGTERM` (process-group kill on POSIX,
  `taskkill /T /F` on Windows), then a hard kill after 5s if anything survives.
  A second `Ctrl+C` forces the hard kill immediately.
- Exit code is `0` when all selected scripts succeed, `1` when any fails, `130`
  when interrupted.

## Development

```bash
npm install
npm run dev        # run the CLI from TypeScript (tsx)
npm test           # vitest
npm run typecheck
npm run build      # emits dist/ used by the "hop" bin
npm link           # optional: install the global `hop` command locally
```

Project layout:

```text
src/
├── index.ts     # entry point, commander parsing, output styling
├── theme.ts     # the visual language: styles, glyphs, width-aware layout
├── scanner.ts   # directory crawl + fingerprinting (ProjectTarget[])
├── executor.ts  # concurrent child processes + prefixed output + kill logic
├── ports.ts     # port probing, conflict resolution, PORT/--port/.env parsing
├── health.ts    # TCP health checks + dependency discovery (env/compose/scripts)
├── json.ts      # JSON parsing that tolerates a UTF-8 byte order mark
├── git.ts       # `git status --porcelain` → absolute paths → dirty targets
└── ui/          # the Ink interface
    ├── App.tsx        # the shell: picker, run board, summary
    ├── Picker.tsx     # the script picker
    ├── picker-state.ts  # its logic, kept pure so it can be tested
    ├── RunBoard.tsx   # the live board of running projects
    ├── Summary.tsx    # the closing summary
    ├── Screens.tsx    # the help and project list
    ├── controller.ts  # the store between the executor and React
    ├── palette.ts     # colours and roles
    └── render.tsx     # mounting, and the terminal check
tests/
├── scanner.test.ts
├── executor.test.ts
├── ports.test.ts
├── health.test.ts
├── git.test.ts
├── theme.test.ts
├── ui.test.ts
├── cli.test.ts
└── interactive.test.ts
```

The interface is built with [Ink](https://github.com/vadimdemedes/ink), so
it is React: `ink` and `react` draw it, `picocolors` styles the plain-text
fallback and `commander` parses the flags. Process handling stays plain
`node:child_process`.

When the output is not a terminal — a pipe, a file, a CI log — hop cannot
draw an interface, so it falls back to plain, line-oriented text. The
behaviour is the same; only the presentation changes.

## Known limits

- Child stdio is piped for prefixing, so fully interactive programs run through
  `hop` (e.g. `npm init`) may not receive a TTY on stdin.
- The interface needs a real terminal. Piped output, files and CI logs get the
  plain-text version instead, and `hop` without a script prints the project
  list rather than opening a picker.
- Symlinked directories are not followed (avoids cycles).
- The scan reaches 3 levels below the current directory by default; `--depth`
  raises it. A Go module deeper than that is out of reach.
- A Go module whose root is not a program has no `run` script — the programs
  under `cmd/` are the ones to run.
- No workspace-manager awareness (pnpm/turbo/nx); hop goes by fingerprints on
  disk only.
- By default only the selected script's command runs; use `--npm` to honour
  `pre*`/`post*` hooks via the project's package manager.
- Port detection only sees `--port`, `$PORT` and `PORT=` in `.env*`. A port that
  is hard-coded elsewhere (config files, `-p` short flags) cannot be swapped —
  hop leaves it alone rather than guessing wrong. A port that *is* detected is
  checked on every local address (`127.0.0.1`, `0.0.0.0` and `::`), so a server
  bound to a wildcard is never mistaken for a free port.
- Dependency waiting is heuristic: ports referenced by a project are only
  awaited when a *selected* sibling exposes them, unless they are listed in
  `hop.waitFor`. Compose publishing is read from the short `ports:` list syntax.
  Only real URLs count — a port that is merely mentioned in a comment is
  ignored.
- A monorepo root whose script orchestrates the whole workspace (`turbo dev`,
  `nx dev`, `pnpm -r dev`) is skipped when there are packages below it, so
  nothing is started twice.

## License

MIT © 2026 [Teck](https://github.com/Nom-nom-hub). See [LICENSE](LICENSE).
