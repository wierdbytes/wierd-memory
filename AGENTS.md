# AGENTS.md

Guidance for AI agents working in this repo.

## What this is

wierd-memory: long-term memory for the pi coding agent, stored as Markdown notes in a git repository, with a local
server (the only writer), a web UI, a pi extension and a Herdr mod. Bun workspace; TypeScript is run directly (no build step). Read `README.md` first.

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
  git.ts                Repo: the memory repository — worktrees, commits, branches, history, the remote
  notefile.ts           a note as a file (front matter + body): lenient parse, canonical render
  memory.ts             MemoryStore: notes / scopes / skills / prompts of a branch as files; note history by id
  state.ts              StateStore: `.local/` files — state.json, inbox/*.jsonl, reviews/<id>.json, runs/<run>/run.json
  app.ts                App: reading, hand edits of the approved branch (one commit each), taking in edits made
                        outside the server, afterMainChange, push / pull, the mutation lock
  reviews.ts            the review branch: sync (a merge commit), items, accept / edit / reject, a dream's submit
  dreams.ts             schedule, spawn and watch the headless pi that dreams; what a dream starts from
  searcher.ts           memory_search / memory_read / evidence
  http.ts               routes (keep docs/api.md and core/api.ts in step with it)
  cli.ts serve.ts       `wmem`
packages/web/           React UI, bundled by Bun's HTML import (no other build tooling); `import type` from core only
packages/pi/            the pi extension (index.ts) and the dream (runner.ts → pipeline.ts, llm.ts)
packages/herdr-mod/     the Herdr panel (JavaScript for gpui-kit; installed by `wmem herdr install`)
scripts/seed-review.ts  a made-up dream for a sandbox server
```

## Rules of the design

- The approved branch (`memory.branch`, `MAIN` in code) is approved memory. Only these write to it: a hand edit
  (`App`), an accepted review item (`Reviews.accept`), a file edited outside the server (`App.adopt` commits it),
  a pull. A dream never does: `Reviews.submit` writes to the review branch.
- A store write changes files only; `Repo.commit` makes it a commit with an author. Every change of the approved
  branch is followed by `App.afterMainChange()` (merges it into the open review branch, bumps `rev`, pushes).
- Review items are computed (`diffNotes(approved, review branch)`), never stored. Every note that differs must
  belong to exactly one item, or a review can never close.
- Notes are told apart by `id`, never by file name or similarity: git's rename detection mistakes one small note
  for another (`--follow` is not used; see `MemoryStore.noteHistory`).
- A note keeps its file for life (named after its first title), and has the same path on the approved and the
  review branch wherever its scope allows (`upsert(…, { like })`).
- Files are only rewritten when the note in them changed, so a file written by hand or by an older version stays
  byte-identical until its note is edited.
- All mutations go through `App.lock`. Do not call `lock` from inside a locked function (it would wait for itself).
- The server is the only writer of `.local/`; the pi extension, the mod and the CLI use the HTTP API.
- A pi session must never hang on memory: the extension's calls have timeouts and failures are values.
  Network git (push, fetch) never runs inside the lock except the merge of what was fetched.

## Checks

- `bun test` — needs `git` on PATH (server and pipeline tests work on real repositories in temp dirs, with a bare
  repository as the remote).
- `bun run typecheck`.
- The mod: `wmem herdr install` runs `herdr-app check`.
- To try something by hand use a sandbox server, never the real one (`~/.wierd-memory`, port 7433 — its repository is
  the user's real memory and is pushed to GitHub): `WMEM_HOME=/tmp/wmem-dev WMEM_PORT=17433 bin/wmem serve`, then
  `WMEM_URL=http://127.0.0.1:17433 bun scripts/seed-review.ts`. CLI calls against it need the same `WMEM_HOME`
  and `WMEM_PORT`.
- After changing server code restart the real one: `wmem service restart`.

## Conventions

- Tabs, long lines are fine, comments say why. User-facing strings of the UI, CLI and mod are English; notes are
  written by dreams in `language` (Russian).
- When the API changes: `core/src/api.ts`, `server/src/http.ts`, `docs/api.md`, then the clients.
