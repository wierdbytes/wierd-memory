/**
 * The HTTP API of the wierd-memory server, as types: what the web UI, the pi
 * extension, the Herdr mod and the CLI send and get back. Every route is
 * under `/api`; bodies are JSON. `docs/api.md` describes each route.
 */

import type { WmemConfig } from "./config.ts";
import type { DiffKind } from "./diff.ts";
import type { Evidence, IndexMode, Note, NoteColumn, NoteStatus, NoteType } from "./notes.ts";
import type { ReportData, ReportRejected } from "./report.ts";
import type { ScopeMeta, WorkspaceChanges } from "./workspace.ts";

/**
 * How a note reaches agents now: `always` — its title is in every session of
 * its scope; `pointer` — a "when → id" line is; `none` — search only; `over` —
 * meant for the index but over the token budget (search only); `off` — turned
 * off by the user; `archived` — superseded or deprecated.
 */
export type Reach = "always" | "pointer" | "none" | "over" | "off" | "archived";

export interface NoteView extends Note {
	reach: Reach;
	/** Short name of the note's scope (`Global`, `herdr-app`). */
	scopeName: string;
	/** The note's file in the memory repository (absolute path). */
	file?: string;
}

export interface ScopeInfo {
	id: string;
	/** `global`, or the project key (`github.com/o/r`, `local:/path`). */
	key: string;
	/** `Global`, or the project's short name. */
	name: string;
	root: string | null;
	/** What this scope's memory is for (steers dreams); null: the default. */
	charter: string | null;
	budget: number;
	index: { ids: string[]; tokens: number; over: number };
	counts: { active: number; off: number; archived: number };
}

export interface NoteHistoryEntry {
	commit: string;
	date: string;
	author: string;
	message: string;
	/** `added`, `modified` or `removed`. */
	type: string;
	/** Column → [before, after] for what the commit changed. */
	changes: Partial<Record<NoteColumn, [unknown, unknown]>>;
}

export interface CommitInfo {
	hash: string;
	date: string;
	author: string;
	email: string;
	message: string;
}

// ── inbox ────────────────────────────────────────────────────────────────

export const INBOX_KINDS = ["preference", "procedure", "pitfall", "fact", "decision", "reference", "other"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export interface InboxItem {
	id: string;
	ts: string;
	source: "agent" | "user";
	text: string;
	kind?: InboxKind;
	scope?: "global" | "project";
	cwd: string;
	projectKey: string;
	sessionId?: string;
	sessionFile?: string;
	/** Leaf entry of the session when the item was written. */
	entryId?: string;
	status: "pending" | "done" | "dismissed";
	/** Scope the item would land in (`global`, or its project's scope id). */
	scopeId?: string | null;
	projectName?: string | null;
}

export interface InboxInput {
	text: string;
	source?: "agent" | "user";
	kind?: InboxKind;
	scope?: "global" | "project";
	cwd?: string;
	sessionId?: string;
	sessionFile?: string;
	entryId?: string;
}

// ── a session's context ──────────────────────────────────────────────────

export interface ContextInfo {
	cwd: string;
	project: { key: string; root: string; name: string };
	/** The project's scope id when it has memory. */
	scope: string | null;
	injection: { text: string | null; ids: string[]; tokens: number; memver: string };
	/** Folders with approved skills for pi to load. */
	skills: string[];
	inject: boolean;
}

// ── review ───────────────────────────────────────────────────────────────

export type ItemKind = DiffKind | "skill";

export interface ReviewItem {
	/** `note:<id>` or `skill:<scope>/<name>`: what accept / reject take. */
	key: string;
	kind: ItemKind;
	/** Note ids the item covers (a replacement covers the replaced note too). */
	ids: string[];
	scope: string;
	scopeName: string;
	/** moved: the scope the note leaves. */
	from?: string;
	fromName?: string;
	/** The note as proposed (removed / deprecated: the note being closed). */
	note: Note;
	/** The approved version it changes; for a replacement, the note being replaced. */
	before?: Note;
	/** Columns that differ from the approved version. */
	fields: NoteColumn[];
	/** How the proposed note would reach agents. */
	reach: Reach;
	/** Evidence the proposal adds. */
	evidence: Evidence[];
	/** Why a dream (or a review comment) wants it. */
	why: string[];
	/** The fact check of the latest change. */
	check?: { verdict: string; reason: string; corrected: boolean };
	/** Made on a review comment. */
	reviewer?: boolean;
	/** Risky content in the text (`pipe-to-shell`…). */
	risky: string[];
	/** supersede / deprecate: evidence of the old note that is newer than this change's. */
	newerEvidence?: Evidence[];
	remark?: string;
	/** Dreams that touched it. */
	runs: string[];
	/** Text can be edited before accepting (not for closing or confirming a note). */
	editable: boolean;
	/** kind `skill`: the skill proposed. */
	skill?: { scope: string; name: string; description: string; body: string; before?: { description: string; body: string } };
}

export interface ReviewDecision {
	key: string;
	kind: string;
	noteId?: string;
	title: string;
	scope?: string;
	decision: "accepted" | "edited" | "rejected";
	at: string;
	by: string;
	reason?: string;
}

export interface ReviewComment {
	id: string;
	reviewId: string;
	/** The note the comment is about; absent: the whole review. */
	noteId?: string;
	body: string;
	author: string;
	at: string;
	/** The dream that applied it. */
	processedRun?: string;
	/** Why a dream could not apply it. */
	unhandled?: string;
}

export interface AgentsProposal {
	id: string;
	runId: string;
	reviewId?: string;
	projectKey: string;
	projectName: string;
	repoRoot: string;
	/** `AGENTS.md` or `CLAUDE.md`, relative to the repo root. */
	rel: string;
	summary?: string;
	edits: Array<{ old: string; new: string }>;
	rationale: string[];
	status: "pending" | "applied" | "rejected" | "failed";
	error?: string;
	createdAt: string;
	decidedAt?: string;
}

export interface RunInfo {
	id: string;
	/** `run` — a dream; `review` — review comments only; `dry` — nothing is written; `reindex` — digests only. */
	kind: "run" | "review" | "dry" | "reindex";
	status: "running" | "ok" | "noop" | "error" | "cancelled";
	startedAt: string;
	finishedAt?: string;
	error?: string;
	sessions?: number;
	cost?: number;
	reviewId?: string;
	title?: string;
	pid?: number;
	/** How it was started: `schedule`, `user`, `agent`. */
	trigger?: string;
}

export interface ReviewSummary {
	id: string;
	status: "open" | "merged" | "closed";
	title: string;
	createdAt: string;
	closedAt?: string;
	/** Items still to decide (open reviews). */
	pending: number;
	accepted: number;
	rejected: number;
	runs: string[];
}

export interface ReviewView extends ReviewSummary {
	branch: string;
	items: ReviewItem[];
	decisions: ReviewDecision[];
	comments: ReviewComment[];
	agents: AgentsProposal[];
	/** What the dreams of this review proposed and their own fact check threw out. */
	rejectedByCheck: Array<ReportRejected & { run: string }>;
	warnings: string[];
	runInfos: RunInfo[];
	/** Session id → title, for the evidence of the items. */
	sessionTitles: Record<string, string>;
	/** Scope id → name, for every scope the items mention. */
	scopeNames: Record<string, string>;
	counts: Partial<Record<ItemKind, number>>;
	/** Where the same difference can be seen on the remote (GitHub: approved branch ... review branch). */
	compareUrl?: string;
}

/** Text of a note as edited by the reviewer before accepting. */
export interface NoteEdit {
	title?: string;
	body?: string;
	when?: string | null;
	index?: IndexMode;
	type?: NoteType;
	/** A scope id, to move the note. */
	scope?: string;
}

/** `PATCH /api/notes/:id`: a hand edit of approved memory. */
export interface NotePatch extends NoteEdit {
	enabled?: boolean;
	pinned?: boolean;
	status?: NoteStatus;
}

export interface NoteCreate extends NoteEdit {
	scope: string;
	title: string;
	pinned?: boolean;
}

// ── dreams ───────────────────────────────────────────────────────────────

export interface DueCheck {
	due: boolean;
	reason: string;
	sessions: number;
	inbox: number;
}

export interface DreamStatus {
	running: RunInfo | null;
	last: RunInfo | null;
	due: DueCheck;
	schedule: WmemConfig["schedule"];
	runs: RunInfo[];
}

export interface SessionMark {
	size: number;
	mtimeMs: number;
	at: string;
	/** The session (at this size) was summarized, or had nothing to summarize. */
	ok: boolean;
	/** Failed card attempts at this size; the session is skipped after 3. */
	failures: number;
}

export type PromptName = "cards" | "curator" | "review" | "verify";

/** What a dream starts from (`GET /api/dream/workspace?run=<id>`). */
export interface DreamWorkspace {
	runId: string;
	kind: RunInfo["kind"];
	opts: { sinceDays?: number; maxSessions?: number };
	config: WmemConfig;
	home: string;
	state: {
		/** Sessions last written before this and never processed are ignored. */
		cutoffMs: number;
		sessions: Record<string, SessionMark>;
		/** Titles the user rejected before (latest last). */
		rejected: string[];
	};
	inbox: InboxItem[];
	/** The open review the dream continues, with the comments it has not applied yet. */
	review: { id: string; comments: ReviewComment[] } | null;
	/** Approved notes plus what the open review proposes. */
	notes: Note[];
	/** Note ids that exist only in the open review. */
	pending: string[];
	scopes: Array<ScopeMeta & { charter?: string | null }>;
	/** Prompt overrides and the default purpose of project memory. */
	prompts: Partial<Record<PromptName | "project_charter", string>>;
	/** AGENTS.md proposals that still wait for review (no second one is stacked on them). */
	agentsPending: Array<{ id: string; repoRoot: string; rel: string }>;
}

/** What a dream hands back (`POST /api/dream/submit`). */
export interface DreamSubmit {
	runId: string;
	status: "ok" | "noop";
	changes: WorkspaceChanges;
	votes: Record<string, { helpful: number; harmful: number }>;
	report: ReportData;
	marks: Record<string, SessionMark>;
	inboxDone: string[];
	commentsDone: Array<{ id: string; unhandled?: string }>;
	agents: Array<{ projectKey: string; repoRoot: string; rel: string; summary?: string; edits: Array<{ old: string; new: string }>; rationale: string[] }>;
	sessions: number;
	cost: number;
}

export interface DreamSubmitResult {
	status: RunInfo["status"];
	reviewId?: string;
	url?: string;
	items?: number;
}

// ── search, evidence ─────────────────────────────────────────────────────

export interface SearchResult {
	notes: Array<{ id: string; scope: string; scopeName: string; type: NoteType; status: NoteStatus; title: string; when?: string; score: number }>;
	sessions: Array<{ ref: string; sessionId: string; entryId?: string; project: string; here: boolean; snippet: string; score: number }>;
	/** The result as the `memory_search` tool shows it. */
	text: string;
}

export interface EvidenceInfo {
	sessions: Record<
		string,
		{
			name?: string;
			/** What the user asked first (an unnamed session goes by it). */
			first?: string | null;
			started?: string;
			cwd?: string;
			project?: string;
			file?: string | null;
			missing?: boolean;
			/** Cited digest lines by entry id. */
			entries: Record<string, { role: string; text: string } | null>;
		}
	>;
	inbox: Record<string, InboxItem>;
}

// ── status ───────────────────────────────────────────────────────────────

export interface StatusInfo {
	version: string;
	home: string;
	url: string;
	/** Short hash of the commit approved memory is at. */
	memver: string;
	/** Bumped on every change: clients poll `/api/wait?rev=` to refresh. */
	rev: number;
	notes: { total: number; active: number; off: number; archived: number; scopes: number };
	inbox: number;
	review: ReviewSummary | null;
	dream: { running: RunInfo | null; last: RunInfo | null; due: DueCheck; scheduled: boolean };
	/** The repository memory is kept in: its folder, the approved branch and the commit it is at. */
	git: { dir: string; branch: string; head: string };
	/** The remote it is pushed to (`url` null: none), and how the last exchange went. */
	remote: { name: string; url: string | null; sync: boolean; lastPush?: string; lastFetch?: string; error?: string };
}

export interface ApiError {
	error: string;
}
