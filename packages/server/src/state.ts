/**
 * What goes on around memory, as files under `.local/` of the memory
 * repository (never committed):
 *
 *   state.json          which sessions dreams have read, the statuses of inbox
 *                       items, rejected titles, usefulness votes
 *   inbox/<day>.jsonl   things kept for the next dream, one JSON object a line,
 *                       append-only
 *   reviews/<id>.json   a review: its branch, every decision made in it, the
 *                       comments left for the dream, AGENTS.md proposals
 *   runs/<run>/         a dream: run.json (when, how it ended, cost) and
 *                       report.json (what it proposed and why) — beside what the
 *                       dream itself saved there
 *
 * The server is the only writer; files are replaced whole (write + rename).
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentsProposal, HomePaths, InboxItem, NoteStats, ReportData, ReviewComment, ReviewDecision, RunInfo, SessionMark } from "@wierd-mem/core";
import { today } from "@wierd-mem/core";

const now = () => new Date().toISOString();

export interface ReviewRow {
	id: string;
	branch: string;
	status: "open" | "merged" | "closed";
	title: string;
	createdAt: string;
	closedAt?: string;
	/** The commit of the approved branch the review branch is in step with. */
	baseCommit?: string;
	runs: string[];
}

type StoredAgents = Omit<AgentsProposal, "projectName">;

interface ReviewFile extends ReviewRow {
	decisions: ReviewDecision[];
	comments: ReviewComment[];
	agents: StoredAgents[];
}

interface StateFile {
	version: 1;
	/** Sessions last written before this and never read are ignored. */
	cutoffMs?: number;
	sessions: Record<string, SessionMark>;
	/** Inbox items that are no longer pending. */
	inbox: Record<string, { status: "done" | "dismissed"; runId?: string; at: string }>;
	rejected: Array<{ title: string; at: string; reviewId?: string; noteId?: string }>;
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
	private reviewFiles: Map<string, ReviewFile> | undefined;
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

	// ── reviews ──────────────────────────────────────────────────────────

	private reviewMap(): Map<string, ReviewFile> {
		if (!this.reviewFiles) {
			this.reviewFiles = new Map();
			let names: string[] = [];
			try {
				names = readdirSync(this.paths.reviews).filter((n) => n.endsWith(".json"));
			} catch {
				// no reviews yet
			}
			for (const name of names) {
				const r = readJson<ReviewFile>(join(this.paths.reviews, name));
				if (r?.id) this.reviewFiles.set(r.id, { ...r, runs: r.runs ?? [], decisions: r.decisions ?? [], comments: r.comments ?? [], agents: r.agents ?? [] });
			}
		}
		return this.reviewFiles;
	}

	private saveReviewFile(r: ReviewFile): void {
		this.reviewMap().set(r.id, r);
		writeJson(join(this.paths.reviews, `${r.id.replace(/[^A-Za-z0-9-]/g, "")}.json`), r);
	}

	private row(r: ReviewFile): ReviewRow {
		return { id: r.id, branch: r.branch, status: r.status, title: r.title, createdAt: r.createdAt, closedAt: r.closedAt, baseCommit: r.baseCommit, runs: [...r.runs] };
	}

	private sorted(): ReviewFile[] {
		return [...this.reviewMap().values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async openReview(): Promise<ReviewRow | undefined> {
		const r = this.sorted().find((x) => x.status === "open");
		return r ? this.row(r) : undefined;
	}

	async review(id: string): Promise<ReviewRow | undefined> {
		const r = this.reviewMap().get(id);
		return r ? this.row(r) : undefined;
	}

	async reviews(limit = 50): Promise<ReviewRow[]> {
		return this.sorted()
			.slice(0, limit)
			.map((r) => this.row(r));
	}

	async saveReview(r: ReviewRow): Promise<void> {
		const cur = this.reviewMap().get(r.id);
		this.saveReviewFile({ decisions: [], comments: [], agents: [], ...cur, ...r, runs: [...r.runs] });
	}

	async decisions(reviewId: string): Promise<ReviewDecision[]> {
		return [...(this.reviewMap().get(reviewId)?.decisions ?? [])];
	}

	async decisionCounts(reviewIds: readonly string[]): Promise<Record<string, { accepted: number; rejected: number }>> {
		const out: Record<string, { accepted: number; rejected: number }> = {};
		for (const id of reviewIds) {
			const r = this.reviewMap().get(id);
			if (!r?.decisions.length) continue;
			out[id] = { accepted: r.decisions.filter((d) => d.decision !== "rejected").length, rejected: r.decisions.filter((d) => d.decision === "rejected").length };
		}
		return out;
	}

	async addDecision(reviewId: string, d: ReviewDecision): Promise<void> {
		const r = this.reviewMap().get(reviewId);
		if (!r) return;
		r.decisions.push(d);
		this.saveReviewFile(r);
	}

	async comments(reviewId: string): Promise<ReviewComment[]> {
		return [...(this.reviewMap().get(reviewId)?.comments ?? [])];
	}

	async addComment(reviewId: string, body: string, author: string, noteId?: string): Promise<ReviewComment> {
		const c: ReviewComment = { id: `c-${randomBytes(4).toString("hex")}`, reviewId, ...(noteId ? { noteId } : {}), body, author, at: now() };
		const r = this.reviewMap().get(reviewId);
		if (r) {
			r.comments.push(c);
			this.saveReviewFile(r);
		}
		return c;
	}

	/** Remove a comment no dream has read yet. */
	async removeComment(id: string): Promise<void> {
		for (const r of this.reviewMap().values()) {
			const i = r.comments.findIndex((c) => c.id === id && !c.processedRun);
			if (i < 0) continue;
			r.comments.splice(i, 1);
			this.saveReviewFile(r);
		}
	}

	async markComments(done: ReadonlyArray<{ id: string; unhandled?: string }>, runId: string): Promise<void> {
		if (!done.length) return;
		const by = new Map(done.map((d) => [d.id, d]));
		for (const r of this.reviewMap().values()) {
			let touched = false;
			for (const c of r.comments) {
				const d = by.get(c.id);
				if (!d) continue;
				c.processedRun = runId;
				if (d.unhandled) c.unhandled = d.unhandled;
				touched = true;
			}
			if (touched) this.saveReviewFile(r);
		}
	}

	// ── rejected titles ──────────────────────────────────────────────────

	async addRejection(title: string, reviewId?: string, noteId?: string): Promise<void> {
		const s = this.load();
		s.rejected.push({ title, at: now(), ...(reviewId ? { reviewId } : {}), ...(noteId ? { noteId } : {}) });
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

	async setStats(id: string, stats: NoteStats): Promise<void> {
		this.load().stats[id] = { helpful: stats.helpful, harmful: stats.harmful };
		this.save();
	}

	// ── AGENTS.md proposals ──────────────────────────────────────────────

	async agentsProposals(where: { status?: AgentsProposal["status"]; reviewId?: string } = {}): Promise<StoredAgents[]> {
		const out: StoredAgents[] = [];
		for (const r of this.reviewMap().values()) {
			if (where.reviewId && r.id !== where.reviewId) continue;
			for (const a of r.agents) if (!where.status || a.status === where.status) out.push({ ...a });
		}
		return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	async agentsProposal(id: string): Promise<StoredAgents | undefined> {
		for (const r of this.reviewMap().values()) {
			const a = r.agents.find((x) => x.id === id);
			if (a) return { ...a };
		}
		return undefined;
	}

	async addAgentsProposal(p: { runId: string; reviewId: string; projectKey: string; repoRoot: string; rel: string; summary?: string; edits: AgentsProposal["edits"]; rationale: string[] }): Promise<string> {
		const r = this.reviewMap().get(p.reviewId);
		if (!r) throw new Error(`no review ${p.reviewId}`);
		const id = `a-${randomBytes(4).toString("hex")}`;
		r.agents.push({ id, runId: p.runId, reviewId: p.reviewId, projectKey: p.projectKey, repoRoot: p.repoRoot, rel: p.rel, ...(p.summary ? { summary: p.summary } : {}), edits: p.edits, rationale: p.rationale, status: "pending", createdAt: now() });
		this.saveReviewFile(r);
		return id;
	}

	async updateAgentsProposal(id: string, patch: { status?: AgentsProposal["status"]; error?: string | null; edits?: AgentsProposal["edits"] }): Promise<void> {
		for (const r of this.reviewMap().values()) {
			const a = r.agents.find((x) => x.id === id);
			if (!a) continue;
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
			this.saveReviewFile(r);
			return;
		}
	}

	/** Whether the state file exists (a fresh home has none). */
	exists(): boolean {
		return existsSync(this.paths.state);
	}
}
