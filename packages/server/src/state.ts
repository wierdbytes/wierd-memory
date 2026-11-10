/**
 * What goes on around memory, as files under `.local/` of the memory
 * repository (never committed):
 *
 *   state.json          which sessions dreams have read, the statuses of inbox
 *                       items, rejected titles, usefulness votes
 *   inbox/<day>.jsonl   things kept for the next dream, one JSON object a line,
 *                       append-only
 *   review.json         the review: `baseCommit` (the commit of the approved
 *                       branch the dreams branch is in step with), `runs` (the
 *                       dreams whose proposals may still be pending), the
 *                       comments left for dreams, AGENTS.md proposals
 *   decisions.jsonl     every accept / reject, one JSON object a line,
 *                       append-only
 *   runs/<run>/         a dream: run.json (when, how it ended, cost) and
 *                       report.json (what it proposed and why) — beside what the
 *                       dream itself saved there
 *
 * The server is the only writer; files are replaced whole (write + rename),
 * the `.jsonl` ones are appended to.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentsProposal, HomePaths, InboxItem, NoteStats, ReportData, ReviewComment, ReviewDecision, RunInfo, SessionMark } from "@wierd-memory/core";
import { today } from "@wierd-memory/core";

const now = () => new Date().toISOString();

export type StoredAgents = Omit<AgentsProposal, "projectName">;
/** A comment as kept: `processedAt` says since when a dream has applied it. */
type StoredComment = ReviewComment & { processedAt?: string };

interface ReviewFile {
	/** The commit of the approved branch the dreams branch is in step with. */
	baseCommit?: string;
	/** Dreams whose proposals may still be pending (their reports explain the items). */
	runs: string[];
	comments: StoredComment[];
	agents: StoredAgents[];
}

interface StateFile {
	version: 1;
	/** Sessions last written before this and never read are ignored. */
	cutoffMs?: number;
	sessions: Record<string, SessionMark>;
	/** Inbox items that are no longer pending. */
	inbox: Record<string, { status: "done" | "dismissed"; runId?: string; at: string }>;
	rejected: Array<{ title: string; at: string; noteId?: string }>;
	stats: Record<string, NoteStats>;
	[key: string]: unknown;
}

type StoredRun = RunInfo & { opts?: Record<string, unknown> };

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, "utf-8");
	renameSync(tmp, path);
}

export class StateStore {
	private state: StateFile | undefined;
	private reviewFile: ReviewFile | undefined;
	private decisionLog: ReviewDecision[] | undefined;
	private runFiles: Map<string, StoredRun> | undefined;

	constructor(private paths: HomePaths) {}

	private load(): StateFile {
		if (!this.state) {
			const s = readJson<Partial<StateFile>>(this.paths.state) ?? {};
			this.state = { ...s, version: 1, sessions: s.sessions ?? {}, inbox: s.inbox ?? {}, rejected: s.rejected ?? [], stats: s.stats ?? {} };
		}
		return this.state;
	}

	private save(): void {
		writeJson(this.paths.state, this.load());
	}

	// ── anything else worth keeping ──────────────────────────────────────

	async get<V>(k: string): Promise<V | undefined> {
		return this.load()[k] as V | undefined;
	}

	async set(k: string, v: unknown): Promise<void> {
		this.load()[k] = v;
		this.save();
	}

	// ── inbox ────────────────────────────────────────────────────────────

	private inboxItems(): InboxItem[] {
		const done = this.load().inbox;
		const out: InboxItem[] = [];
		let names: string[] = [];
		try {
			names = readdirSync(this.paths.inbox)
				.filter((n) => n.endsWith(".jsonl"))
				.sort();
		} catch {
			// nothing was ever kept
		}
		const seen = new Set<string>();
		for (const name of names) {
			for (const line of (readFileSync(join(this.paths.inbox, name), "utf-8") || "").split("\n")) {
				if (!line.trim()) continue;
				try {
					const item = JSON.parse(line) as InboxItem;
					if (!item?.id || typeof item.text !== "string" || seen.has(item.id)) continue;
					seen.add(item.id);
					out.push({
						id: item.id,
						ts: item.ts,
						source: item.source === "user" ? "user" : "agent",
						text: item.text,
						kind: item.kind,
						scope: item.scope === "global" || item.scope === "project" ? item.scope : undefined,
						cwd: item.cwd ?? "",
						projectKey: item.projectKey ?? "",
						sessionId: item.sessionId,
						sessionFile: item.sessionFile,
						entryId: item.entryId,
						status: done[item.id]?.status ?? "pending",
					});
				} catch {
					// a torn line
				}
			}
		}
		return out.sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
	}

	async inbox(status: "pending" | "done" | "dismissed" | "all" = "pending"): Promise<InboxItem[]> {
		const all = this.inboxItems();
		return status === "all" ? all : all.filter((i) => i.status === status);
	}

	async inboxItem(id: string): Promise<InboxItem | undefined> {
		return this.inboxItems().find((i) => i.id === id);
	}

	async addInbox(item: Omit<InboxItem, "id" | "ts" | "status"> & { id?: string; ts?: string; status?: InboxItem["status"] }): Promise<InboxItem> {
		const { status = "pending", ...rest } = item;
		const full = { ...rest, id: item.id ?? `i-${randomBytes(4).toString("hex")}`, ts: item.ts ?? now() };
		mkdirSync(this.paths.inbox, { recursive: true });
		appendFileSync(join(this.paths.inbox, `${today(new Date(full.ts))}.jsonl`), `${JSON.stringify(full)}\n`, "utf-8");
		if (status !== "pending") await this.setInboxStatus([full.id], status);
		return { ...full, status } as InboxItem;
	}

	async setInboxStatus(ids: readonly string[], status: InboxItem["status"], runId?: string): Promise<void> {
		if (!ids.length) return;
		const s = this.load();
		for (const id of ids) {
			if (status === "pending") delete s.inbox[id];
			else s.inbox[id] = { status, ...(runId ? { runId } : {}), at: now() };
		}
		this.save();
	}

	// ── sessions the dreams have read ────────────────────────────────────

	async marks(): Promise<Record<string, SessionMark>> {
		return { ...this.load().sessions };
	}

	async setMarks(marks: Record<string, SessionMark>): Promise<void> {
		if (!Object.keys(marks).length) return;
		Object.assign(this.load().sessions, marks);
		this.save();
	}

	// ── runs ─────────────────────────────────────────────────────────────

	private runFile(id: string): string {
		return join(this.paths.runs, id.replace(/[^A-Za-z0-9-]/g, ""), "run.json");
	}

	private info(r: StoredRun): RunInfo {
		const { opts: _opts, ...info } = r;
		return info;
	}

	/** Every run on record (run.json of each folder under runs/), read once: the server is the only one who writes them. */
	private runMap(): Map<string, StoredRun> {
		if (!this.runFiles) {
			this.runFiles = new Map();
			let names: string[] = [];
			try {
				names = readdirSync(this.paths.runs, { withFileTypes: true })
					.filter((d) => d.isDirectory())
					.map((d) => d.name);
			} catch {
				// no dreams yet
			}
			for (const id of names) {
				const r = readJson<StoredRun>(this.runFile(id));
				if (r?.id) this.runFiles.set(r.id, r);
			}
		}
		return this.runFiles;
	}

	/** Newest first. */
	private storedRuns(): StoredRun[] {
		return [...this.runMap().values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
	}

	private report(id: string): ReportData | undefined {
		const report = readJson<ReportData>(join(dirname(this.runFile(id)), "report.json"));
		return report && Array.isArray(report.items) ? report : undefined;
	}

	async runs(limit = 50): Promise<RunInfo[]> {
		return this.storedRuns()
			.slice(0, limit)
			.map((r) => this.info(r));
	}

	async run(id: string): Promise<(RunInfo & { opts: Record<string, unknown>; report?: ReportData }) | undefined> {
		const r = this.runMap().get(id);
		if (!r) return undefined;
		return { ...this.info(r), opts: r.opts ?? {}, report: this.report(id) };
	}

	/** The reports of these runs, oldest first. */
	async runReports(ids: readonly string[]): Promise<ReportData[]> {
		const want = new Set(ids);
		return this.storedRuns()
			.filter((r) => want.has(r.id))
			.reverse()
			.map((r) => this.report(r.id))
			.filter((r): r is ReportData => !!r);
	}

	async createRun(run: RunInfo & { opts?: Record<string, unknown> }): Promise<void> {
		const stored = { ...run, opts: run.opts ?? {} };
		this.runMap().set(run.id, stored);
		writeJson(this.runFile(run.id), stored);
	}

	async updateRun(id: string, patch: Partial<RunInfo> & { report?: ReportData }): Promise<void> {
		const cur = this.runMap().get(id);
		if (!cur) return;
		const { report, ...rest } = patch;
		const next: Record<string, unknown> = { ...cur };
		for (const [k, v] of Object.entries(rest)) {
			if (v === undefined || v === null) delete next[k];
			else next[k] = v;
		}
		this.runMap().set(id, next as unknown as StoredRun);
		writeJson(this.runFile(id), next);
		if (report) writeJson(join(dirname(this.runFile(id)), "report.json"), report);
	}

	/** The latest finished dream that counts for the schedule (not a dry run, a reindex or a comments-only pass). */
	async lastDream(): Promise<RunInfo | undefined> {
		const r = this.storedRuns().find((x) => x.kind === "run" && x.status !== "running");
		return r ? this.info(r) : undefined;
	}

	async runningRuns(): Promise<RunInfo[]> {
		return this.storedRuns()
			.filter((r) => r.status === "running")
			.map((r) => this.info(r));
	}

	// ── the review ───────────────────────────────────────────────────────

	private review(): ReviewFile {
		if (!this.reviewFile) {
			const r = readJson<Partial<ReviewFile>>(this.paths.review) ?? {};
			this.reviewFile = { ...(r.baseCommit ? { baseCommit: r.baseCommit } : {}), runs: r.runs ?? [], comments: r.comments ?? [], agents: r.agents ?? [] };
		}
		return this.reviewFile;
	}

	private saveReview(): void {
		const r = this.review();
		writeJson(this.paths.review, { baseCommit: r.baseCommit, runs: r.runs, comments: r.comments, agents: r.agents });
	}

	async baseCommit(): Promise<string | undefined> {
		return this.review().baseCommit;
	}

	async setBaseCommit(commit: string): Promise<void> {
		if (this.review().baseCommit === commit) return;
		this.review().baseCommit = commit;
		this.saveReview();
	}

	/** Dreams whose proposals may still be pending, in the order they came. */
	async reviewRuns(): Promise<string[]> {
		return [...this.review().runs];
	}

	async setReviewRuns(runs: readonly string[]): Promise<void> {
		const cur = this.review().runs;
		if (cur.length === runs.length && cur.every((r, i) => r === runs[i])) return;
		this.review().runs = [...runs];
		this.saveReview();
	}

	// ── decisions ────────────────────────────────────────────────────────

	private decisionList(): ReviewDecision[] {
		if (!this.decisionLog) {
			this.decisionLog = [];
			let text = "";
			try {
				text = readFileSync(this.paths.decisions, "utf-8");
			} catch {
				// nothing decided yet
			}
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try {
					const d = JSON.parse(line) as ReviewDecision;
					if (d?.key && d.decision) this.decisionLog.push(d);
				} catch {
					// a torn line
				}
			}
		}
		return this.decisionLog;
	}

	/** The latest decisions, newest first. */
	async decisions(limit = 100): Promise<ReviewDecision[]> {
		return this.decisionList().slice(-limit).reverse();
	}

	async addDecisions(list: readonly ReviewDecision[]): Promise<void> {
		if (!list.length) return;
		const log = this.decisionList();
		mkdirSync(dirname(this.paths.decisions), { recursive: true });
		appendFileSync(this.paths.decisions, list.map((d) => `${JSON.stringify(d)}\n`).join(""), "utf-8");
		log.push(...list);
	}

	// ── comments for dreams ──────────────────────────────────────────────

	private publicComment(c: StoredComment): ReviewComment {
		const { processedAt: _at, ...out } = c;
		return { ...out };
	}

	/** Every comment, oldest first, with since when a dream has applied it. */
	async comments(): Promise<Array<ReviewComment & { processedAt?: string }>> {
		return this.review().comments.map((c) => ({ ...c }));
	}

	async comment(id: string): Promise<ReviewComment | undefined> {
		const c = this.review().comments.find((x) => x.id === id);
		return c ? this.publicComment(c) : undefined;
	}

	async addComment(body: string, author: string, noteId?: string): Promise<ReviewComment> {
		const c: ReviewComment = { id: `c-${randomBytes(4).toString("hex")}`, ...(noteId ? { noteId } : {}), body, author, at: now() };
		this.review().comments.push(c);
		this.saveReview();
		return { ...c };
	}

	/** Remove a comment no dream has applied yet: "gone" when there is no such comment, "applied" when a dream has. */
	async removeComment(id: string): Promise<"ok" | "gone" | "applied"> {
		const list = this.review().comments;
		const i = list.findIndex((c) => c.id === id);
		if (i < 0) return "gone";
		if (list[i].processedRun) return "applied";
		list.splice(i, 1);
		this.saveReview();
		return "ok";
	}

	async markComments(done: ReadonlyArray<{ id: string; unhandled?: string }>, runId: string): Promise<void> {
		if (!done.length) return;
		const by = new Map(done.map((d) => [d.id, d]));
		let touched = false;
		for (const c of this.review().comments) {
			const d = by.get(c.id);
			if (!d) continue;
			c.processedRun = runId;
			c.processedAt = now();
			if (d.unhandled) c.unhandled = d.unhandled;
			touched = true;
		}
		if (touched) this.saveReview();
	}

	// ── rejected titles ──────────────────────────────────────────────────

	async addRejection(title: string, noteId?: string): Promise<void> {
		const s = this.load();
		s.rejected.push({ title, at: now(), ...(noteId ? { noteId } : {}) });
		s.rejected = s.rejected.slice(-400);
		this.save();
	}

	/** The latest rejected titles, oldest of them first. */
	async rejectedTitles(limit = 40): Promise<string[]> {
		return this.load()
			.rejected.slice(-limit)
			.map((r) => r.title);
	}

	// ── usefulness votes ─────────────────────────────────────────────────

	async stats(): Promise<Map<string, NoteStats>> {
		return new Map(Object.entries(this.load().stats).map(([id, s]) => [id, { ...s }]));
	}

	async addVotes(votes: Record<string, { helpful: number; harmful: number }>): Promise<void> {
		const s = this.load();
		let touched = false;
		for (const [id, v] of Object.entries(votes)) {
			if (!v.helpful && !v.harmful) continue;
			const cur = (s.stats[id] ??= { helpful: 0, harmful: 0 });
			cur.helpful += v.helpful;
			cur.harmful += v.harmful;
			touched = true;
		}
		if (touched) this.save();
	}

	// ── AGENTS.md proposals ──────────────────────────────────────────────

	async agentsProposals(where: { status?: AgentsProposal["status"] } = {}): Promise<StoredAgents[]> {
		return this.review()
			.agents.filter((a) => !where.status || a.status === where.status)
			.map((a) => ({ ...a }))
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	async agentsProposal(id: string): Promise<StoredAgents | undefined> {
		const a = this.review().agents.find((x) => x.id === id);
		return a ? { ...a } : undefined;
	}

	async addAgentsProposal(p: { runId: string; projectKey: string; repoRoot: string; rel: string; summary?: string; edits: AgentsProposal["edits"]; rationale: string[] }): Promise<string> {
		const id = `a-${randomBytes(4).toString("hex")}`;
		this.review().agents.push({ id, runId: p.runId, projectKey: p.projectKey, repoRoot: p.repoRoot, rel: p.rel, ...(p.summary ? { summary: p.summary } : {}), edits: p.edits, rationale: p.rationale, status: "pending", createdAt: now() });
		this.saveReview();
		return id;
	}

	async updateAgentsProposal(id: string, patch: { status?: AgentsProposal["status"]; error?: string | null; edits?: AgentsProposal["edits"] }): Promise<void> {
		const a = this.review().agents.find((x) => x.id === id);
		if (!a) return;
		if (patch.status) {
			a.status = patch.status;
			if (patch.status === "pending") delete a.decidedAt;
			else a.decidedAt = now();
		}
		if ("error" in patch) {
			if (patch.error) a.error = patch.error;
			else delete a.error;
		}
		if (patch.edits) a.edits = patch.edits;
		this.saveReview();
	}

	/** Whether the state file exists (a fresh home has none). */
	exists(): boolean {
		return existsSync(this.paths.state);
	}
}
