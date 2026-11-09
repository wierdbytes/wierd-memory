# AGENTS.md

Guidance for AI agents working in this repo.

## What this is

wierd-mem: long-term memory for the pi coding agent, stored in Dolt, with a local server, a web UI, a pi extension
and a Herdr mod. Bun workspace; TypeScript is run directly (no build step). Read `README.md` first.

## Layout

```
packages/core/src/      shared, no dependencies, no pi imports (runs under bun, pi's loader and in tests)
  notes.ts              Note, evidence, column-wise comparison (changedColumns / sameNote)
  memindex.ts           the index and the <memory> section (buildIndex, renderInjection)
  workspace.ts          the curator's operations applied to an in-memory copy of the notes (parseOps, applyOp)
  diff.ts               diffNotes (review items) and mergeNote / rebaseNotes (three-way, by column)
  api.ts                types of the HTTP API — the contract of server, web, pi, mod, CLI
  digest.ts sessions.ts project(s).ts search.ts secrets.ts prompts.ts schedule.ts report.ts config.ts layout.ts
packages/server/src/
  dolt.ts               the `dolt sql-server` child and the connection (Db: q / on / onBranch / commit)
  schema.ts             tables of `wmem` (memory, branched) and `wmem_state` (inbox, runs, reviews)
  memory.ts state.ts    row access for the two databases
  app.ts                App: reading, hand edits of main (one commit each), afterMainChange, the mutation lock
  reviews.ts            the review branch: sync with main, items, accept / edit / reject, a dream's submit
  dreams.ts             schedule, spawn and watch the headless pi that dreams; what a dream starts from
  searcher.ts           memory_search / memory_read / evidence
  http.ts               routes (keep docs/api.md and core/api.ts in step with it)
  importer.ts           pi-dream repository → Dolt
  cli.ts serve.ts       `wmem`
packages/web/           React UI, bundled by Bun's HTML import (no other build tooling); `import type` from core only
packages/pi/            the pi extension (index.ts) and the dream (runner.ts → pipeline.ts, llm.ts)
packages/herdr-mod/     the Herdr panel (JavaScript for gpui-kit; installed by `wmem herdr install`)
scripts/seed-review.ts  a made-up dream for a sandbox server
```

## Rules of the design

- `main` of the `wmem` database is approved memory. Only three things write to it: a hand edit (`App`), an accepted
  review item (`Reviews.accept`), an import. A dream never does: `Reviews.submit` writes to the review branch.
- Every write to a branch ends in `Db.commit` with an author; every change of `main` is followed by
  `App.afterMainChange()` (syncs the open review branch, bumps `rev`).
- Review items are computed (`diffNotes(main, branch)`), never stored. Every row that differs must belong to exactly
  one item, or a review can never close.
- All mutations go through `App.lock`. Do not call `lock` from inside a locked function (it would wait for itself).
- The server is the only writer of the databases; the pi extension, the mod and the CLI use the HTTP API.
- A pi session must never hang on memory: the extension's calls have timeouts and failures are values.

## Checks

- `bun test` — needs `dolt` on PATH (server and pipeline tests start a real Dolt in a temp dir, ports 175xx/176xx).
- `bun run typecheck`.
- The mod: `wmem herdr install` runs `herdr-app check`.
- To try something by hand use a sandbox server, never the real one (`~/.wierd-mem`, ports 7433/7434):
  `WMEM_HOME=/tmp/wmem-dev WMEM_PORT=17433 WMEM_DOLT_PORT=17434 bin/wmem serve`, then
  `WMEM_URL=http://127.0.0.1:17433 bun scripts/seed-review.ts`. CLI calls against it need the same `WMEM_PORT`.
- After changing server code restart the real one: `wmem service restart`.

## Conventions

- Tabs, long lines are fine, comments say why. User-facing strings of the UI, CLI and mod are English; notes are
  written by dreams in `language` (Russian).
- When the API changes: `core/src/api.ts`, `server/src/http.ts`, `docs/api.md`, then the clients.
