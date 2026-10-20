# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **A new look for the whole CLI.** The visual language now lives in one
  module (`src/theme.ts`) instead of being scattered across the code:
  - the help screen opens with a `↗ hop` wordmark and every section is
    separated by a rule;
  - the project list is drawn as a tree (`├` / `└`) with the ecosystem and the
    path on the project line;
  - the project type has its own colour, so node, docker, python and go are
    readable at a glance;
  - "nothing found" now explains what hop looked for instead of only saying
    that it found nothing;
  - column widths are measured in *visible* characters, so the alignment no
    longer depends on the terminal having colour support.

## [0.1.1] - 2026-10-20

### Fixed

- **Projects with a UTF-8 byte order mark are detected again.** A
  `package.json` written by PowerShell 5.1 (`Set-Content -Encoding utf8`) or
  by several older Windows editors starts with a BOM, which made
  `JSON.parse` throw — hop silently skipped those projects, and the
  `"hop": { "waitFor": [...] }` config was ignored as well.
- **Ports held by a wildcard listener are now detected.** hop probed only
  `127.0.0.1`, so a server bound to `0.0.0.0` or to the IPv6 wildcard `::`
  (what `server.listen(port)` uses by default) was reported as free. The
  child then died with `EADDRINUSE` — exactly the failure hop promises to
  prevent. Every address a child may bind to is probed now.
- **Git file names with non-ASCII characters are matched correctly.** Git
  quotes `café.txt` as `"caf\303\251.txt"` (C-style octal escapes, not JSON);
  the escapes are decoded now, so the file is attributed to the right project
  and its script stays pre-selected.
- The `--help` usage column is aligned again: `hop <script> --no-wait` is
  exactly as wide as the column, so its description used to run into it.
- **A new project inside an untracked directory is detected.** `git status`
  collapses an untracked folder into a single `?? packages/` entry, so a
  project created in `packages/team/app` was invisible and never
  pre-selected. Every untracked file is now listed individually.
- **A port redirect no longer breaks the dependency handshake.** When a
  service had to move to another port, the waiting sibling referred to the
  old port and therefore got no gate at all — it started immediately and
  talked to whatever else owned that port. The handshake now follows the
  service to its new port.
- **A stray `PORT=…` in the shell no longer overrides the project's own
  `.env`.** The ambient variable used to win, so the first project grabbed
  that port and every other project was pushed off its configured one.
- **hop no longer crashes on a project path longer than 260 characters.**
  The spawn fails and the stdio socket then reports its own error, which
  was uncaught and ended the run with a raw Node stack trace.
- Ports mentioned in a **comment** are no longer treated as dependencies.
  A commented-out URL in a `.env` made hop wait for a port nobody serves.
  All dependencies of a project now share a single timeout instead of
  getting one each.
- A directory holding both a `package.json` and a `docker-compose.yml` keeps
  its **published ports**: the compose file is read even though the project
  itself is a node project.
- A `package.json` whose `scripts` is an **array** no longer produces made-up
  scripts named `0`, `1`, … .
- A command is **never dropped** when a script name collides: the third and
  later candidates get a numbered suffix instead of disappearing.
- Two projects can no longer end up with the **same name**, which used to
  merge their change counts and hide one of them from the picker.
- **Symlinked and junctioned project directories are found** again, while a
  link that points back into the tree is still skipped.
- A project inside a folder named `build`, `out` or `target` is found again
  — those names are only treated as build output when they hold no project.
- A **monorepo root that orchestrates its workspace** (`turbo dev`, `nx dev`,
  `pnpm -r dev`, …) is no longer started next to the packages it already
  starts, which used to launch every dev server twice.

## [0.1.0] - 2026-10-18

### Added

- Zero-config scanning of the current directory and up to three levels below it
  for Node (`package.json`), Docker (`Dockerfile` / compose), Python
  (`requirements.txt` / `pyproject.toml`) and Go (`go.mod`) projects.
- Interactive picker with per-project groups, select-all rows, and pre-selection
  of projects with uncommitted git changes (their `dev` / `serve` / `start` /
  `run` script), marked with a `· N changed` label.
- Concurrent execution with color-prefixed output, per-script result summary,
  and a clean `Ctrl+C` that kills the entire process tree (no orphaned ports);
  exit codes 0 / 1 / 130.
- `hop <script>` direct mode, `hop --npm` (scripts through the project's package
  manager, pre/post hooks included), `hop --list` inventory.
- Dynamic port conflict resolution: probes `--port`, `$PORT` and `PORT=` in
  `.env*`, walks upward when a port is blocked, rewrites the command's `--port`
  flag when needed, injects the resolved `PORT` into the child, and never hands
  the same port to two projects. Ports published by compose files are reserved
  automatically.
- Dependency handshakes: hop waits for localhost services referenced by `.env`
  files, bundler configs or script commands — and for sibling services that
  publish those ports — before starting dependents. Animated spinner on TTY,
  plain `[hop]` lines otherwise, 30 s timeout breaker, `--no-wait` to skip, and
  explicit `"hop": { "waitFor": [...] }` in `package.json`.
- Test suite covering scanner edge cases, process lifecycle and kill-tree
  behaviour, port planning, health checks, git mapping, CLI and the interactive
  flow.
