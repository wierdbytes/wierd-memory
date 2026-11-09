# wierd-mem

Long-term memory for [pi](https://pi.dev) agents, kept in [Dolt](https://www.dolthub.com) — a SQL database with
branches, commits and diffs — instead of a git repository of Markdown files on GitHub.

A local server owns the memory. Agents read it (a small `<memory>` index injected into every session, plus search)
and drop things into an inbox. **Dreams** — background pi runs over your past sessions — propose changes.
**Nothing a dream proposes becomes memory until you decide**: per change you can accept it, edit it by hand and
accept, or reject it — in the web UI, in the Herdr panel, or from the command line.

It is the successor of [`@wierdbytes/pi-dream`](https://github.com/wierdbytes/pi-wierd-stuff/tree/master/packages/dream)
(same notes, same dream pipeline, same tools for the agent) with the storage and the review moved off GitHub.

```
 pi sessions ──► dream (headless pi: cards → curator → fact check) ──► review branch ──► you ──► main
      ▲                                                                   accept · edit · reject     │
      └────────── <memory> index, memory_search / memory_read ◄────────── approved memory ◄──────────┘
```

## What is where

| | |
|---|---|
| `packages/server` | `wmem serve`: runs `dolt sql-server`, the HTTP API and the web UI on `127.0.0.1:7433`; schedules and starts dreams. Also the `wmem` CLI (a client of that API). |
| `packages/web` | The web UI: Review, Memory, Inbox, Dreams, History, Settings. |
| `packages/pi` | The pi extension: memory injection, `memory_search` / `memory_read` / `memory_inbox`, `/dream`, `/memory`, `/remember`, and the dream runner the server starts. |
| `packages/herdr-mod` | The Herdr app panel: memory of the focused pane's project, the open review, hand edits. |
| `packages/core` | What they share: the note model, the index, search, the curator's operations, diff / three-way merge, API types. |
| `~/.wierd-mem/` | Data: `dolt/` (the databases), `config.json`, `digests/` (search corpus of past sessions), `logs/`. |

## Setup

Needs [Bun](https://bun.sh), [Dolt](https://docs.dolthub.com/introduction/installation) (`brew install dolt`) and pi.

```sh
cd ~/me/dev/wierd-mem && bun install
ln -s "$PWD/bin/wmem" ~/.local/bin/wmem

wmem service install      # launchd: the server starts at login and is restarted if it dies
                          # (or run it in a terminal: wmem serve)
wmem status
wmem open                 # http://127.0.0.1:7433
```

### Coming from pi-dream

```sh
wmem import                                   # ~/.pi/memory → Dolt: notes, scopes, charters, skills, prompts,
                                              # which sessions were read, the inbox, digests, settings
pi remove npm:@wierdbytes/pi-dream            # the two must not be loaded together (same tool names)
pi install ~/me/dev/wierd-mem/packages/pi     # absolute path
wmem dream schedule on                        # let the server dream on its own (off until you say so)
wmem herdr install                            # the Herdr panel (see packages/herdr-mod/README.md)
```

`wmem import` changes nothing in `~/.pi/memory`. If pi-dream kept working after the first import, bring its newer
state over with `wmem import --overwrite` (its version wins for every note it has; add `--prune` to also delete notes
it does not have). What an open pi-dream PR proposes is not on `main` and is not imported: merge it first.

## How memory is kept

Two Dolt databases, served on `127.0.0.1:7434` (any MySQL client works: `wmem sql`, or `mysql -h127.0.0.1 -P7434 -uroot wmem`):

- **`wmem`** — memory itself: `notes`, `scopes` (global and one per project, with its charter), `skills`, `prompts`.
  Branch **`main` is approved memory**: what sessions get. Every change to it is a commit with an author and a
  message (`accept added m-1a2b3c: …`, `turn off m-…`, `edit m-…`), so every note has a history and any version
  can be restored.
- **`wmem_state`** — what goes on around it: the inbox, which sessions dreams have read, dream runs with their
  reports, reviews with every decision, rejected titles, usefulness votes.

A note is a row: a one-line statement (`title` — also the line agents see), the specifics (`body`), how it reaches
agents (`index_mode`: `always` — in every session of its scope; `pointer` — a "when → id" line; `none` — search
only), its scope, its evidence (which sessions and entries it comes from), and `enabled`. The index injected into a
session is generated from the rows within a token budget; no model ever rewrites it.

### Review

A dream commits its changes to a **review branch** (`review-<id>`, branched off `main`). While a review is open,
later dreams add to it. The items you see are the difference between `main` and that branch, note by note — so the
list is always exactly what accepting would change:

- **accept** — the branch's rows are copied to `main` (one commit);
- **edit and accept** — your text goes to the branch first, then as above; the note is marked as approved by you,
  which later dreams weigh against older evidence;
- **reject** — `main`'s rows are copied back to the branch; a rejected new note is not proposed again without new evidence;
- **comment** — an instruction for the dream ("split this", "move it to project X"), applied by `wmem dream review` or the next dream.

When nothing is left the review closes and its branch is deleted. `main` may change while a review is open (hand
edits, accepted items): those changes are carried into the branch column by column, so it stays "main + what is
still proposed". With SQL: `select * from dolt_diff('main', 'review-…', 'notes')`.

Dreams may also propose AGENTS.md / CLAUDE.md edits for a project; they wait in the same review, and accepting one
applies it to the file in the working copy (nothing is committed there).

### By hand

In the web UI, the Herdr panel and the CLI you can **turn a note off** (agents no longer get it — not in the index,
not in search; dreams leave it alone and do not add the same thing again) and on, **edit** it, pin it, close or
reopen it, move it to another scope, delete it, add one. Your own edits apply at once: one commit each, no review.

## Every day

```sh
wmem status                          # memory, the open review, dreams
wmem review                          # what waits for a decision
wmem review accept m-1a2b3c m-4d5e6f # … or --all
wmem review edit m-1a2b3c --title "…" --body "…"     # edit, then accept
wmem review reject m-7a8b9c --reason "one-off"
wmem review comment "move this to the herdr-app project" --note m-1a2b3c

wmem notes --scope herdr-app         # ● always  ○ when relevant  · search only  ⊘ off
wmem note m-1a2b3c --history
wmem note off m-1a2b3c               # on · pin · unpin · close · reopen · delete
wmem note edit m-1a2b3c --body "…"
wmem search "chezmoi" --all
wmem remember "Deploys only on Fridays" --global

wmem dream run --max 20              # now; `wmem dream log --follow`, `wmem dream report`
wmem dream schedule on               # on its own: every 20 h once 3 new sessions pile up (config)
wmem history                         # commits on approved memory
wmem sql "select * from dolt_log limit 5"
```

`wmem help` lists everything; `--json` prints the API's answer as is (for agents and scripts). The HTTP API is in
[`docs/api.md`](docs/api.md).

In pi: `/memory` (what this session got), `/dream [status|run|review|dry|index|log|open]`, `/remember <text>`,
`--no-memory`. The agent has `memory_search`, `memory_read` and `memory_inbox`. If the server is not running a
session simply goes without memory (the extension tries to start it once).

## Dreams

The server starts a dream as a headless pi process — it needs pi's model registry and your credentials:

```
pi -p --no-session --no-extensions -e <dream.childExtensions…> -e packages/pi/runner.ts "/wmem-dream-run --run-id …"
```

1. **Digests** of new or grown sessions (also the corpus `memory_search` reads).
2. **Cards** (`models.cards`): what happened in each session, the user's feedback, candidate learnings with entry ids.
3. **Curator** (`models.analyze`, per project): sees the current notes, the cards, older sessions that mention a
   candidate, inbox items, what you rejected before and what you turned off; proposes `add` / `update` /
   `supersede` / `deprecate` / `confirm` / `skill` / `agents_md`.
4. **Fact check** (`models.verify`): every cited entry is looked up in the raw session; an independent model checks
   each operation against those excerpts and may narrow it or move it to the right scope.
5. **Code applies** what passed, item by item (never a rewrite), and hands the result to the server, which commits
   it to the review branch. The report of each dream (what it proposed and why, what the check rejected, cost) is
   kept: `wmem dream report`, or the Dreams page.

## Settings

`~/.wierd-mem/config.json` (or the Settings page, or `wmem config <key> <value>`):

| Key | Default | |
|---|---|---|
| `port` / `doltPort` | `7433` / `7434` | HTTP and Dolt SQL, both on 127.0.0.1 (restart to apply) |
| `language` | `Russian` | language of notes |
| `inject` | `true` | inject the approved index into sessions |
| `models.cards` / `analyze` / `verify` | Sonnet low / Opus high / GPT medium | `{ "model": "provider/id", "thinking": "…" }` |
| `schedule` | `{ enabled: false, minHoursBetween: 20, minNewSessions: 3 }` | when the server dreams on its own |
| `dream.maxSessionsPerRun` · `minIdleMinutes` · `concurrency` · `maxRuntimeMinutes` | `60` · `30` · `4` · `180` | |
| `dream.childExtensions` | `["npm:@wierdbytes/pi-anthropic"]` | extensions the dream process loads |
| `dream.piCommand` | `pi` | |
| `budgets.globalTokens` / `projectTokens` | `1000` / `1500` | index budgets |
| `agentsMd` | `true` | propose AGENTS.md / CLAUDE.md edits |
| `remote.url` / `remote.autoPush` | — | a Dolt remote for `main` (`file:///…`, DoltHub…): `wmem push` |

Charters (what each scope's memory is for) and the dream prompts are edited in the web UI; they live in the
database and are versioned like the notes.

## Development

```sh
bun test                 # core, server (against a real Dolt in a temp dir), a whole dream with scripted models
bun run typecheck
WMEM_HOME=/tmp/wmem-dev WMEM_PORT=17433 WMEM_DOLT_PORT=17434 WMEM_DEV=1 bin/wmem serve   # a sandbox server
WMEM_URL=http://127.0.0.1:17433 bun scripts/seed-review.ts                               # a made-up review to try the UI on
```

See [`AGENTS.md`](AGENTS.md) for the layout of the code.
