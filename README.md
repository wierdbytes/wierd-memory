# wierd-memory

Long-term memory for [pi](https://pi.dev) agents, kept in a git repository of Markdown notes — with a review
that lets you decide on every change by itself.

A local server owns the memory. Agents read it (a small `<memory>` index injected into every session, plus search)
and drop things into an inbox. **Dreams** — background pi runs over your past sessions — propose changes.
**Nothing a dream proposes becomes memory until you decide**: per change you can accept it, edit it by hand and
accept, or reject it — in the web UI, in the Herdr panel, or from the command line.

The review is not a GitHub pull request, which can only be merged whole: the server does the accepting, note by
note, and GitHub is where the repository is backed up and can be looked at.

```
 pi sessions ──► dream (headless pi: cards → curator → fact check) ──► review/<id> branch ──► you ──► approved branch
      ▲                                                                   accept · edit · reject          │
      └────────── <memory> index, memory_search / memory_read ◄────────── approved memory ◄───────────────┘
```

## What is where

| | |
|---|---|
| `packages/server` | `wmem serve`: the HTTP API and the web UI on `127.0.0.1:7433`, everything that writes to the repository, the dream schedule. Also the `wmem` CLI (a client of that API). |
| `packages/web` | The web UI: Review, Memory, Inbox, Dreams, History, Settings. |
| `packages/pi` | The pi extension: memory injection, `memory_search` / `memory_read` / `memory_inbox`, `/dream`, `/memory`, `/remember`, and the dream runner the server starts. |
| `packages/herdr-mod` | The Herdr app panel: memory of the focused pane's project, the open review, hand edits. |
| `packages/core` | What they share: the note model, the index, search, the curator's operations, diff / three-way merge, API types. |
| `~/.wierd-memory/` | `config.json`, `logs/`, and `memory/` — the git repository. |

## Setup

Needs [Bun](https://bun.sh), git and pi.

```sh
git clone https://github.com/wierdbytes/wierd-memory && cd wierd-memory && bun install
ln -s "$PWD/bin/wmem" ~/.local/bin/wmem

wmem init --repo git@github.com:you/pi-memory.git
                          # clone your memory repository into ~/.wierd-memory/memory; its `main` branch is
                          # approved memory (`--branch <name>` for another one, `--from <ref>` to start it from
                          # there if it does not exist yet). Without --repo the server starts an empty local repository.
wmem service install      # launchd: the server starts at login and is restarted if it dies
                          # (or run it in a terminal: wmem serve)
wmem status
wmem open                 # http://127.0.0.1:7433

pi install npm:@wierdbytes/pi-memory          # the pi extension (packages/pi/README.md)
wmem dream schedule on                        # let the server dream on its own (off until you say so)
wmem herdr install                            # the Herdr panel (see packages/herdr-mod/README.md)
```

To work on the extension itself, install it from the checkout instead (an absolute path; pi loads `index.ts` from
source): `pi install /path/to/wierd-memory/packages/pi`.

## How memory is kept

```
~/.wierd-memory/memory/           the git repository; its approved branch is checked out here
  scopes/global/                  what is true on this machine in every project
    charter.md                    what this memory is for (steers dreams)
    notes/<slug>.md               one note per file: front matter + body
    skills/<name>/SKILL.md        approved skills (pi loads them from here)
  scopes/projects/<key>/          the same for one project, plus scope.json (its key and root)
  prompts/<stage>.md              optional overrides of the dream prompts
  .local/                         not in git:
    state.json                    which sessions dreams have read, inbox statuses, rejected titles, votes
    inbox/<day>.jsonl             things kept for the next dream (append-only)
    reviews/<id>.json             a review: its branch, every decision, comments, AGENTS.md proposals
    runs/<run>/                   a dream: run.json, report.json, what the models saw and said
    logs/<run>.log                a dream's log
    digests/, cards/              the search corpus of past sessions, and the cheap-model cache
    worktrees/<review>/           the review branch, checked out
```

A note:

```markdown
---
id: m-7f3a2c
title: "One self-contained statement — this is the line agents see"
type: procedure            # preference | procedure | pitfall | fact | decision | reference
status: active             # active | superseded | deprecated
index: always              # always — in every session of the scope; pointer — a "when → id" line; none — search only
when: "when it matters"
enabled: false             # only when you turned it off
created: "2026-11-08"
updated: "2026-11-08"
evidence:
  - {"s": "<session id>", "e": ["<entry id>"], "date": "2026-11-06", "at": "2026-11-06T14:05Z", "kind": "user"}
---

The specifics: exact commands, paths, conditions, reasons.
```

The **approved branch** (`memory.branch`) is what sessions get. Every change to it is a commit with an author
(`accept added m-1a2b3c: …`, `turn off m-…`, `edit by hand: 1 note`), so every note has a history and any version
can be restored. The index injected into a session is generated from the notes within a token budget; no model
ever rewrites it.

### Review

A dream commits its changes to a branch **`review/<id>`** off the approved one. While a review is open, later
dreams add to it. The items you see are the difference between the two branches, note by note — so the list is
always exactly what accepting would change:

- **accept** — the note's file is copied to the approved branch (one commit);
- **edit and accept** — your text goes to the review branch first, then as above; the note is marked as approved
  by you, which later dreams weigh against older evidence;
- **reject** — the approved version is copied back to the review branch; a rejected new note is not proposed
  again without new evidence;
- **comment** — an instruction for the dream ("split this", "move it to project X"), applied by
  `wmem dream review` or the next dream.

When nothing is left the review closes and its branch is deleted (on the remote too). The approved branch may
change while a review is open (hand edits, accepted items, a pull): it is merged into the review branch — a real
merge commit, whose content is worked out note by note and field by field rather than line by line — so the review
branch is always "approved + what is still proposed". You can look at the same thing with git or on GitHub:

```sh
git -C ~/.wierd-memory/memory diff main...review/r-20261109-50c2
# https://github.com/<you>/pi-memory/compare/main...review/r-20261109-50c2   (the link is in the review's header)
```

Dreams may also propose AGENTS.md / CLAUDE.md edits for a project; they wait in the same review, and accepting one
applies it to the file in the working copy (nothing is committed there).

### By hand

In the web UI, the Herdr panel and the CLI you can **turn a note off** (agents no longer get it — not in the index,
not in search; dreams leave it alone and do not add the same thing again) and on, **edit** it, pin it, close or
reopen it, move it to another scope, delete it, add one. Your own edits apply at once: one commit each, no review.

Notes are files, so an editor works too: change `~/.wierd-memory/memory/scopes/…/notes/*.md` (or add a file — an
id and dates are filled in) and the server commits it a moment later as `edit by hand`. A commit you make with git
yourself, or pull, is taken as it is.

### The remote

With `memory.sync` on (the default when the repository has an `origin`), the server pushes the approved branch and
the open review's branch after every change, and every ten minutes fetches the approved branch and takes in what
the remote has — an edit made on GitHub, another machine. `wmem sync` does both now. If both sides changed the same
lines it stops and says so in `wmem status`; merge by hand in `~/.wierd-memory/memory`.

## Every day

```sh
wmem status                          # memory, the open review, dreams, the remote
wmem review                          # what waits for a decision
wmem review accept m-1a2b3c m-4d5e6f # … or --all
wmem review edit m-1a2b3c --title "…" --body "…"     # edit, then accept
wmem review reject m-7a8b9c --reason "one-off"
wmem review comment "move this to the herdr-app project" --note m-1a2b3c

wmem notes --scope herdr-app         # ● always  ○ when relevant  · search only  ⊘ off
wmem note m-1a2b3c --history         # the note, its file, its commits
wmem note off m-1a2b3c               # on · pin · unpin · close · reopen · delete
wmem note edit m-1a2b3c --body "…"
wmem search "chezmoi" --all
wmem remember "Deploys only on Fridays" --global

wmem dream run --max 20              # now; `wmem dream log --follow`, `wmem dream report`
wmem dream schedule on               # on its own: every 20 h once 3 new sessions pile up (config)
wmem history                         # commits on approved memory
wmem sync                            # pull from and push to the remote now
```

`wmem help` lists everything; `--json` prints the API's answer as is (for agents and scripts). The HTTP API is in
[`docs/api.md`](docs/api.md).

In pi: `/memory` (what this session got), `/dream [status|run|review|dry|index|log|open]`, `/remember <text>`,
`--no-memory`. The agent has `memory_search`, `memory_read` and `memory_inbox`. If the server is not running a
session simply goes without memory (the extension tries to start it once: the launchd agent of
`wmem service install`, else `wmem serve` when `wmem` is on `PATH`).

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

`~/.wierd-memory/config.json` (or the Settings page, or `wmem config <key> <value>`):

| Key | Default | |
|---|---|---|
| `port` | `7433` | HTTP, on 127.0.0.1 (restart to apply) |
| `memory.dir` | `~/.wierd-memory/memory` | the git repository (restart to apply) |
| `memory.branch` | `main` | the branch that is approved memory (restart to apply) |
| `memory.remote` / `memory.sync` | `origin` / `true` | push after every change, pull every ten minutes |
| `language` | `Russian` | language of notes |
| `inject` | `true` | inject the approved index into sessions |
| `models.cards` / `analyze` / `verify` | Sonnet low / Opus high / GPT medium | `{ "model": "provider/id", "thinking": "…" }` |
| `schedule` | `{ enabled: false, minHoursBetween: 20, minNewSessions: 3 }` | when the server dreams on its own |
| `dream.maxSessionsPerRun` · `minIdleMinutes` · `concurrency` · `maxRuntimeMinutes` | `60` · `30` · `4` · `180` | |
| `dream.childExtensions` | `["npm:@wierdbytes/pi-anthropic"]` | extensions the dream process loads |
| `dream.piCommand` | `pi` | |
| `budgets.globalTokens` / `projectTokens` | `1000` / `1500` | index budgets |
| `agentsMd` | `true` | propose AGENTS.md / CLAUDE.md edits |

Charters (what each scope's memory is for) and the dream prompts are edited in the web UI; they are files in the
repository and versioned like the notes.

## Development

```sh
bun test                 # core; the server on real git repositories in temp dirs (with a bare remote);
                         # a whole dream with scripted models
bun run typecheck
WMEM_HOME=/tmp/wmem-dev WMEM_PORT=17433 WMEM_DEV=1 bin/wmem serve     # a sandbox server (its own empty repository)
WMEM_URL=http://127.0.0.1:17433 bun scripts/seed-review.ts            # a made-up review to try the UI on
                                                                      # (needs some notes with session evidence)
```

See [`AGENTS.md`](AGENTS.md) for the layout of the code.

### Releasing the pi extension

The extension is published to npm as [`@wierdbytes/pi-memory`](https://www.npmjs.com/package/@wierdbytes/pi-memory):
`bun run build:pi` bundles it (with `packages/core` inlined — core is not published on its own) into
`packages/pi/dist` with a manifest of its own; `packages/pi/package.json` stays private.

To release: bump `version` in `packages/pi/package.json`, add its entry to `packages/pi/CHANGELOG.md`, push to
`main`. [`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs the checks on every push and publishes
when that version is not on npm yet, through npm Trusted Publishing (OIDC, no token). The very first version is
published by hand (a package must exist before it can have a trusted publisher); then `npm trust github` registers
this workflow for it.
