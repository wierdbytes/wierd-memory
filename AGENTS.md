# AGENTS.md

Guidance for AI agents working in this repo.

## What this is

wierd-memory: long-term memory for the pi coding agent, stored as Markdown notes in a git repository, with a local
server (the only writer), a web UI, a pi extension and a Herdr mod. Bun workspace; TypeScript is run directly — the
one build step is the npm bundle of the pi extension (`bun run build:pi`). Read `README.md` first.

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
  git.ts                Repo: the memory repository — the dreams branch's worktree, commits, history, the remote
  notefile.ts           a note as a file (front matter + body): lenient parse, canonical render
  memory.ts             MemoryStore: notes / scopes / skills / prompts of a branch as files; note history by id
  state.ts              StateStore: `.local/` files — state.json, inbox/*.jsonl, review.json (base commit, pending runs,
                        comments, AGENTS.md proposals), decisions.jsonl (append-only), runs/<run>/run.json
  app.ts                App: reading, hand edits of the approved branch (one commit each), taking in edits made
                        outside the server, afterMainChange, push / pull, the mutation lock
  reviews.ts            the dreams branch: sync (a merge commit), items and their versions, accept / edit / reject,
                        comments, AGENTS.md proposals, a dream's submit
  dreams.ts             schedule, spawn and watch the headless pi that dreams; what a dream starts from
  searcher.ts           memory_search / memory_read / evidence
  http.ts               routes (keep docs/api.md and core/api.ts in step with it)
  cli.ts serve.ts       `wmem`
packages/web/           React UI, bundled by Bun's HTML import (no other build tooling); `import type` from core only
packages/pi/            the pi extension (index.ts) and the dream (runner.ts → pipeline.ts, llm.ts)
                        package.json is the private development manifest; npm gets dist/ (below)
packages/herdr-mod/     the Herdr panel (JavaScript for gpui-kit; installed by `wmem herdr install`)
scripts/seed-review.ts  a made-up dream for a sandbox server
scripts/build-pi.ts     `bun run build:pi`: packages/pi/dist — index.js (core inlined; pi's own packages external),
                        the published package.json (@wierdbytes/pi-memory), README, CHANGELOG, LICENSE
.github/workflows/publish.yml   on push to main: typecheck, tests, build; publishes packages/pi/dist when its version
                        is not on npm yet (Trusted Publishing — the file name is registered on npmjs.com)
```

## Rules of the design

- The approved branch (`memory.branch`, `MAIN` in code) is approved memory. Only these write to it: a hand edit
  (`App`), an accepted review item (`Reviews.accept`), a file edited outside the server (`App.adopt` commits it),
  a pull. A dream never does: `Reviews.submit` writes to the dreams branch (`memory.reviewBranch`, `dreams`).
- The dreams branch is permanent: approved memory plus whatever is still proposed. It is made at start when missing
  (from the remote's, else from the approved branch) and never deleted; nothing opens or closes. Any subset of the
  items can be decided at any time; every decision is appended to `decisions.jsonl`. `review.json` `runs` holds
  only the dreams something of which is still pending (pruned after every decision, submit and sync).
- A store write changes files only; `Repo.commit` makes it a commit with an author. Every change of the approved
  branch is followed by `App.afterMainChange()` (merges it into the dreams branch, bumps `rev`, pushes).
- Review items are computed (`diffNotes(approved, dreams)`), never stored. Every note that differs must
  belong to exactly one item, or it can never be decided. `ReviewItem.version` hashes what deciding it would change;
  a decision sent with `versions` is refused (409) when an item changed since the client showed it.
- Notes are told apart by `id`, never by file name or similarity: git's rename detection mistakes one small note
  for another (`--follow` is not used; see `MemoryStore.noteHistory`).
- A note keeps its file for life (named after its first title), and has the same path on the approved and the
  dreams branch wherever its scope allows (`upsert(…, { like })`); where a note is the same on both, its file is
  byte-identical too (`copyFiles`), so `git diff main...dreams` shows only what is proposed.
- Files are only rewritten when the note in them changed, so a file written by hand or by an older version stays
  byte-identical until its note is edited.
- All mutations go through `App.lock`. Do not call `lock` from inside a locked function (it would wait for itself).
- The server is the only writer of `.local/`; the pi extension, the mod and the CLI use the HTTP API.
- The pi extension runs from an npm install too: it must not need the repository (a path relative to
  `import.meta.url` only as an optional fallback, like `checkoutBin` in client.ts; no files of other packages);
  what it needs from core is bundled. The dream runner is the exception — the server starts it from its own checkout.
- A pi session must never hang on memory: the extension's calls have timeouts and failures are values.
  Network git (push, fetch) never runs inside the lock except the merge of what was fetched.

## Checks

- `bun test` — needs `git` on PATH (server and pipeline tests work on real repositories in temp dirs, with a bare
  repository as the remote).
- `bun run typecheck`.
- The npm package: `bun run build:pi && npm pack --dry-run ./packages/pi/dist`, and that pi loads it:
  `pi -p --no-session --no-extensions -e packages/pi/dist "/memory"`. Releasing: bump `packages/pi/package.json`
  `version` and `packages/pi/CHANGELOG.md`; CI publishes on push to main.
- The mod: `wmem herdr install` runs `herdr-app check`.
- To try something by hand use a sandbox server, never the real one (`~/.wierd-memory`, port 7433 — its repository is
  the user's real memory and is pushed to GitHub): `WMEM_HOME=/tmp/wmem-dev WMEM_PORT=17433 bin/wmem serve`, then
  `WMEM_URL=http://127.0.0.1:17433 bun scripts/seed-review.ts`. CLI calls against it need the same `WMEM_HOME`
  and `WMEM_PORT`. Stop it by its pid (`$WMEM_HOME/server.json`), never with `pkill -f "cli.ts serve"`: the real
  server runs the same command line from this checkout, and launchd restarts it at once — on whatever code is here.
- After changing server code restart the real one: `wmem service restart`.

## Conventions

- Tabs, long lines are fine, comments say why. User-facing strings of the UI, CLI and mod are English; notes are
  written by dreams in `language` (Russian).
- When the API changes: `core/src/api.ts`, `server/src/http.ts`, `docs/api.md`, then the clients.
