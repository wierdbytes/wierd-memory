# wierd-memory HTTP API

The server listens on `http://127.0.0.1:7433` (`port` in `~/.wierd-memory/config.json`, `WMEM_PORT`).
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
| `GET /api/status` | `StatusInfo`: counts, what waits for review in short (`ReviewSummary`), the dream state, `git` (folder, approved branch, commit), `remote` (url, last push / fetch, error), `rev`. Cheap; poll it. |
| `GET /api/wait?rev=<n>&timeout=<s>` | Long poll: answers `{ rev }` as soon as the server's `rev` differs from `n`, or after `timeout` seconds (default 25, max 55). `rev` grows on every change (memory, review, inbox, dreams, config). |
| `GET /api/events` | The same as server-sent events: `data: {"rev": 12, "kind": "memory" \| "review" \| "inbox" \| "dream" \| "config" \| "hello"}`. |

## Memory (approved: the branch `memory.branch` of the repository)

| | |
|---|---|
| `GET /api/scopes` | `ScopeInfo[]` — Global first, then projects by name. `index` says what the scope's index holds now (`ids`, `tokens` of `budget`, `over` = notes that did not fit). |
| `PUT /api/scopes/:id/charter` | `{ charter: string \| null }` — what this scope's memory is for (steers dreams). `:id` is URL-encoded (`projects%2F…`). |
| `GET /api/notes?scope=<id>&status=<s>&ref=review` | `{ notes: NoteView[] }` in index order per scope. `ref=review`: the dreams branch — approved memory as it would be if everything proposed were accepted. |
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
| `POST /api/evidence` | `{ refs: [{ s, e: [] }] }` → `EvidenceInfo`: for each cited session its name / first user line / start / cwd / file and the cited digest lines by entry id (`null` when the line is not in the digest; `missing: true` when the session has no digest); inbox items for `inbox:<id>` refs; review comments for `comment:<id>` refs. |

## Inbox

| | |
|---|---|
| `GET /api/inbox?status=pending\|done\|dismissed\|all` | `InboxItem[]`, newest first (`scopeId`, `projectName` filled in). |
| `POST /api/inbox` | `InboxInput` → `InboxItem`. `cwd` decides the project. |
| `DELETE /api/inbox/:id` | Dismiss: the next dream will not see it. |

## Review

There is one review and it never opens or closes. Everything dreams propose waits on one git branch, `dreams`
(`memory.reviewBranch`): approved memory plus what is still to decide. Dreams add to it whenever they run; any part of
it can be accepted or rejected at any time, and what is left stays until decided. The items are the difference
between the approved branch and `dreams`, note by note. `ReviewView.branch` names the branch; `compareUrl` is the same
difference on GitHub when the remote is there. Every decision goes to a log.

| | |
|---|---|
| `GET /api/review` | `ReviewView`: the items, AGENTS.md proposals (pending, and decided in the last 14 days), comments (not applied yet, and applied in the last 14 days), the 30 latest decisions (`recent`), and what the dreams behind the pending items said (`runInfos`, `rejectedByCheck`, `sessionTitles`, `warnings`). Never null: with nothing to decide `pending` is 0. |
| `GET /api/review/decisions?limit=` | `ReviewDecision[]`, newest first (default 100). |
| `POST /api/review/accept` | `ReviewAccept` → `ReviewView`. `keys` (item keys) or `all: true` — one of them is required (400). With `edit` (exactly one item): the proposed text is changed first, then accepted — "edit and accept"; the note gets the evidence `{ s: "review", kind: "reviewer" }`. One commit on the approved branch. |
| `POST /api/review/reject` | `ReviewReject` → `ReviewView`. `keys` or `all: true`, `reason?`. The approved version goes back to the dreams branch; rejected new notes are not proposed again without new evidence. AGENTS.md proposals are not items: they have their own routes below. |
| `POST /api/review/comments` | `{ body, noteId? }` → `ReviewView`. An instruction for the dream ("split this", "move to project X"); `POST /api/dreams {mode:"review"}` applies comments now, otherwise the next dream does. |
| `DELETE /api/review/comments/:cid` | → `ReviewView`. Removes a comment no dream has applied yet (409 once one has, 404 when there is none). |
| `POST /api/agents/:id/apply` | `{ edits? }` → `ReviewView`. Applies an AGENTS.md / CLAUDE.md proposal to the file in the project's working copy (not committed). 409 when the text no longer matches. |
| `POST /api/agents/:id/reject` | → `ReviewView`. Drops the proposal. |

`versions` (`{ [key]: ReviewItem.version }`, optional on accept and reject): the server checks every listed key
first and decides nothing if one fails — 409 `<key> was decided or withdrawn since you looked` when the item is gone,
409 `«<title>» changed since you looked — reload` when its version differs (a dream rewrote the proposal, the
approved note moved on). A key without the item it names, without `versions`: 404.

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
- `runs` — the dreams that proposed or touched it; `version` — a short hash of what deciding the item would change
  (the item's notes on both branches, or both versions of the skill): the same as long as nothing changed.
- `editable` — text can be edited before accepting (false for closing / confirming).

Evidence a review leaves on a note: `{ s: "comment:<id>", e: [] }` — a dream changed it on that comment;
`{ s: "review", e: [] }` — the reviewer edited the proposal before accepting it (one such entry, the latest).

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
| `GET /api/dream/workspace?run=<id>` | `DreamWorkspace`: settings, which sessions were read, the inbox, the notes to work on (the dreams branch: approved + what is still proposed; `pending` — ids not approved yet), `comments` not applied yet. |
| `POST /api/dream/submit` | `DreamSubmit` → `DreamSubmitResult` (`items`: everything waiting for a decision after it; `url`: the review page when it proposed something). Note changes go to the dreams branch; votes, session marks, inbox and comment bookkeeping go to the state. |
| `POST /api/dream/fail` | `{ runId, error }`. |

## Settings

| | |
|---|---|
| `GET /api/config` · `PUT /api/config` | `WmemConfig` (a partial object is merged at the top level: send whole sections, e.g. `{ "schedule": { … } }`). `port`, `memory.dir`, `memory.branch` and `memory.reviewBranch` apply after a restart. |
| `GET /api/prompts` | `{ prompts: [{ name, default, override }], charters: { global, project, projectOverride } }`. |
| `PUT /api/prompts/:name` | `{ body: string \| null }` — override a dream prompt (`cards`, `curator`, `review`, `verify`) or the default purpose of project memory (`project_charter`); null restores the built-in text. |
| `POST /api/sync` | `{ message }`. Exchange with the git remote now: fetch the approved branch and take in what it has, push it and the dreams branch. 409 when both sides changed the same lines. |
