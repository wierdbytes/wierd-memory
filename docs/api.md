# wierd-mem HTTP API

The server listens on `http://127.0.0.1:7433` (`port` in `~/.wierd-mem/config.json`, `WMEM_PORT`).
Everything is JSON under `/api`. Types are in [`packages/core/src/api.ts`](../packages/core/src/api.ts)
(`Note` is in `notes.ts`, `ReportData` in `report.ts`) — they are the contract; this page says what each route does.

- Errors: a non-2xx status with `{ "error": "why" }`.
- Writes (`POST`/`PUT`/`PATCH`/`DELETE`) with a body must send `content-type: application/json`.
  A browser request from another origin is refused (403).
- Send `x-wmem-client: web | herdr | cli | pi` — it is recorded in commit messages (`via web`) and review decisions.
- There are no accounts: the server is on loopback only and whoever reaches it is the user.

## Live updates

| | |
|---|---|
| `GET /api/status` | `StatusInfo`: counts, the open review in short, the dream state, `git` (folder, approved branch, commit), `remote` (url, last push / fetch, error), `rev`. Cheap; poll it. |
| `GET /api/wait?rev=<n>&timeout=<s>` | Long poll: answers `{ rev }` as soon as the server's `rev` differs from `n`, or after `timeout` seconds (default 25, max 55). `rev` grows on every change (memory, review, inbox, dreams, config). |
| `GET /api/events` | The same as server-sent events: `data: {"rev": 12, "kind": "memory" \| "review" \| "inbox" \| "dream" \| "config" \| "hello"}`. |

## Memory (approved: the branch `memory.branch` of the repository)

| | |
|---|---|
| `GET /api/scopes` | `ScopeInfo[]` — Global first, then projects by name. `index` says what the scope's index holds now (`ids`, `tokens` of `budget`, `over` = notes that did not fit). |
| `PUT /api/scopes/:id/charter` | `{ charter: string \| null }` — what this scope's memory is for (steers dreams). `:id` is URL-encoded (`projects%2F…`). |
| `GET /api/notes?scope=<id>&status=<s>&ref=review` | `{ notes: NoteView[] }` in index order per scope. `ref=review`: approved memory as it would be if the open review were accepted whole. |
| `GET /api/notes/:id` | `NoteView` (`reach`: how it reaches agents now; `stats`: usefulness votes; `file`: the note's file in the repository). |
| `POST /api/notes` | `NoteCreate` → `NoteView`. A hand-written note; one commit. |
| `PATCH /api/notes/:id` | `NotePatch` → `NoteView`. Any of: `title`, `body`, `when` (null clears), `index`, `type`, `scope` (move), `enabled` (false = turned off: agents no longer get it, dreams leave it alone), `pinned`, `status` (`deprecated` closes, `active` reopens). One commit; applied at once (a person's own edit needs no review). |
| `DELETE /api/notes/:id` | Deletes the file (history keeps it: the note's history still answers, and `restore` puts it back). |
| `GET /api/notes/:id/history` | `NoteHistoryEntry[]`, newest first: each commit on the approved branch that changed the note (followed by its id across moves), with `changes: { column: [before, after] }`. |
| `POST /api/notes/:id/restore` | `{ commit }` → `NoteView`: the note as it was after that commit. |
| `GET /api/history?limit=` | `CommitInfo[]`: commits on the approved branch, newest first. |
| `GET /api/history/:hash` | `{ changes: [{ type, before?: Note, after?: Note }] }`: notes that commit changed. |
| `GET /api/skills` · `DELETE /api/skills?scope=&name=` | Approved skills (`{scope, name, description, body}`). |

`reach`: `always` (title in every session of the scope) · `pointer` ("when → id" line) · `none` (search only) ·
`over` (meant for the index, over the token budget) · `off` (turned off by the user) · `archived` (superseded / deprecated).

## A session's context, search

| | |
|---|---|
| `GET /api/context?cwd=<dir>` | `ContextInfo`: the project `cwd` belongs to (as pi resolves it: origin remote, else repo root), its scope if it has memory, the `<memory>` section text for a session started there, folders with approved skills. |
| `GET /api/search?q=&scope=all\|notes\|sessions&projects=current\|all&cwd=&limit=&exclude=<session id>&off=1` | `SearchResult`: notes (BM25, ru+en) and past-session digest chunks; `text` is the answer as the `memory_search` tool prints it. Notes that are turned off are left out unless `off=1`. |
| `GET /api/read?ref=<m-id \| s:session#entry>` | `{ text }`: a note with its evidence, or a session entry with the entries around it (the `memory_read` tool). |
| `POST /api/evidence` | `{ refs: [{ s, e: [] }] }` → `EvidenceInfo`: for each cited session its name / first user line / start / cwd / file and the cited digest lines by entry id (`null` when the line is not in the digest; `missing: true` when the session has no digest); inbox items for `inbox:<id>` refs. |

## Inbox

| | |
|---|---|
| `GET /api/inbox?status=pending\|done\|dismissed\|all` | `InboxItem[]`, newest first (`scopeId`, `projectName` filled in). |
| `POST /api/inbox` | `InboxInput` → `InboxItem`. `cwd` decides the project. |
| `DELETE /api/inbox/:id` | Dismiss: the next dream will not see it. |

## Review

One review is open at a time: a git branch `review/<id>` that holds approved memory plus what dreams propose.
Its items are the difference between the approved branch and that branch, note by note. `ReviewView.branch` names
it; `compareUrl` is the same difference on GitHub when the remote is there.

| | |
|---|---|
| `GET /api/review` | The open review as `ReviewView`, or `null`. |
| `GET /api/reviews` | `ReviewSummary[]`, newest first. |
| `GET /api/reviews/:id` | `ReviewView` (`:id` may be `open`). A closed review has no `items`, only `decisions`. |
| `POST /api/reviews/:id/accept` | `{ keys?: string[], edit?: NoteEdit }` → `ReviewView`. Accepts the items (`keys` omitted: everything left). With `edit` (exactly one key): the proposed text is changed first, then accepted — "edit and accept". One commit on the approved branch. |
| `POST /api/reviews/:id/reject` | `{ keys?: string[], reason?: string }` → `ReviewView`. The items leave the review; rejected new notes are not proposed again without new evidence. |
| `POST /api/reviews/:id/close` | Rejects whatever is left and closes. |
| `POST /api/reviews/:id/comments` | `{ body, noteId? }` → `ReviewView`. An instruction for the dream ("split this", "move to project X"); `POST /api/dreams {mode:"review"}` applies comments now, otherwise the next dream does. |
| `DELETE /api/reviews/:id/comments/:cid` | Removes a comment no dream has read yet. |
| `POST /api/agents/:id/apply` | `{ edits? }` → `ReviewView \| null`. Applies an AGENTS.md / CLAUDE.md proposal to the file in the project's working copy (not committed). 409 when the text no longer matches. |
| `POST /api/agents/:id/reject` | Drops the proposal. |

A `ReviewItem`:

- `key` — what accept / reject take (`note:<id>`, `skill:<scope>/<name>`).
- `kind` — `added`, `updated`, `moved` (`from` → `scope`), `superseded` (`note` replaces `before`; both rows are one item),
  `deprecated` (closing `note`), `removed`, `confirmed` (only new evidence), `skill`.
- `note` — the note as proposed; `before` — the approved version (absent for `added`).
  `fields` — the columns that differ (`title`, `body`, `when`, `index`, `type`, `scope`, `status`, `evidence`, …).
- `reach` — how the note would reach agents once accepted.
- `why` (the dream's rationale), `check` (the fact check: `supported`, or `partial` + `corrected`), `evidence` (what the
  proposal adds: session ids + entry ids; titles in `ReviewView.sessionTitles`, lines via `POST /api/evidence`),
  `risky`, `newerEvidence` (the note being closed was seen in newer sessions than this change relies on), `remark`.
- `editable` — text can be edited before accepting (false for closing / confirming).

The review closes by itself (`merged` if anything was accepted, else `closed`) when no items and no pending
AGENTS.md proposals are left.

## Dreams

| | |
|---|---|
| `GET /api/dreams?limit=` | `DreamStatus`: `running`, `last`, `due` (and why / why not), `schedule`, recent `runs`. |
| `POST /api/dreams` | `{ mode: "run" \| "review" \| "dry" \| "reindex", sinceDays?, maxSessions? }` → `RunInfo & { log }`. Starts a dream in a background pi process. 409 when one runs. |
| `GET /api/dreams/:id` | `RunInfo & { opts, report?: ReportData }`; `?format=md` — the report as Markdown. |
| `GET /api/dreams/:id/log?tail=<lines>` | The dream's log (text). |
| `POST /api/dreams/:id/cancel` | Stops it. |

The dream runner's side (`packages/pi/runner.ts`):

| | |
|---|---|
| `POST /api/dream/begin` | `{ mode, pid?, sinceDays?, maxSessions? }` → `RunInfo`: register a run the server did not start (the runner started by hand). |
| `GET /api/dream/workspace?run=<id>` | `DreamWorkspace`: settings, which sessions were read, the inbox, the notes to work on (approved + pending in the open review), unapplied review comments. |
| `POST /api/dream/submit` | `DreamSubmit` → `DreamSubmitResult`. Note changes go to the review branch (a review is opened when there is none); votes, session marks, inbox and comment bookkeeping go to the state. |
| `POST /api/dream/fail` | `{ runId, error }`. |

## Settings

| | |
|---|---|
| `GET /api/config` · `PUT /api/config` | `WmemConfig` (a partial object is merged at the top level: send whole sections, e.g. `{ "schedule": { … } }`). `port`, `memory.dir` and `memory.branch` apply after a restart. |
| `GET /api/prompts` | `{ prompts: [{ name, default, override }], charters: { global, project, projectOverride } }`. |
| `PUT /api/prompts/:name` | `{ body: string \| null }` — override a dream prompt (`cards`, `curator`, `review`, `verify`) or the default purpose of project memory (`project_charter`); null restores the built-in text. |
| `POST /api/sync` | `{ message }`. Exchange with the git remote now: fetch the approved branch and take in what it has, push it and the open review's branch, drop the remote branches of reviews that are over. 409 when both sides changed the same lines. |
| `POST /api/import` | `{ from? }` — take over pi-dream's local state (`<repo>/.local`: sessions read, inbox, rejected titles, digests, cards) and its settings. Only adds. |
