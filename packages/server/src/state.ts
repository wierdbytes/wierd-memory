/**
 * The state database (`wmem_state`): what goes on around memory — the inbox,
 * which sessions dreams have read, dream runs and their reports, reviews with
 * every decision made in them, rejected titles, usefulness votes, AGENTS.md
 * proposals.
 */

import { randomBytes } from "node:crypto";
import type {
	AgentsProposal,
	InboxItem,
	NoteStats,
	ReportData,
	ReviewComment,
	ReviewDecision,
	RunInfo,
	SessionMark,
} from "@wierd-mem/core";
import { type Db, type Row, STATE_DB } from "./dolt.ts";

const T = (name: string) => `\`${STATE_DB}\`.${name}`;
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const now = () => new Date().toISOString();

function json<T>(v: unknown, fallback: T): T {
	if (v === null || v === undefined) return fallback;
	if (typeof v === "string") {
		try {
			return JSON.parse(v) as T;
		} catch {
			return fallback;
		}
	}
	return v as T;
}

export interface ReviewRow {
	id: string;
	branch: string;
	status: "open" | "merged" | "closed";
	title: string;
	createdAt: string;
	closedAt?: string;
	/** The `main` commit the review branch is in step with. */
	baseCommit?: string;
	runs: string[];
}

export class StateStore {
	constructor(readonly db: Db) {}

	// ── kv ───────────────────────────────────────────────────────────────

	async get<V>(k: string): Promise<V | undefined> {
		const rows = await this.db.q(`SELECT v FROM ${T("kv")} WHERE k = ?`, [k]);
		return rows[0] ? json<V | undefined>(rows[0].v, undefined) : undefined;
	}

	async set(k: string, v: unknown): Promise<void> {
		await this.db.q(`REPLACE INTO ${T("kv")} (k, v) VALUES (?, ?)`, [k, JSON.stringify(v)]);
	}

	// ── inbox ────────────────────────────────────────────────────────────

	private inboxRow(r: Row): InboxItem {
		return {
			id: String(r.id),
			ts: String(r.ts),
			source: r.source === "user" ? "user" : "agent",
			text: String(r.text ?? ""),
			kind: str(r.kind) as InboxItem["kind"],
			scope: r.scope === "global" || r.scope === "project" ? r.scope : undefined,
			cwd: String(r.cwd ?? ""),
			projectKey: String(r.project_key ?? ""),
			sessionId: str(r.session_id),
			sessionFile: str(r.session_file),
			entryId: str(r.entry_id),
			status: r.status === "done" || r.status === "dismissed" ? r.status : "pending",
		};
	}

	async inbox(status: "pending" | "done" | "dismissed" | "all" = "pending"): Promise<InboxItem[]> {
		const rows = status === "all" ? await this.db.q(`SELECT * FROM ${T("inbox")} ORDER BY ts DESC`) : await this.db.q(`SELECT * FROM ${T("inbox")} WHERE status = ? ORDER BY ts DESC`, [status]);
		return rows.map((r) => this.inboxRow(r));
	}

	async inboxItem(id: string): Promise<InboxItem | undefined> {
		const rows = await this.db.q(`SELECT * FROM ${T("inbox")} WHERE id = ?`, [id]);
		return rows[0] ? this.inboxRow(rows[0]) : undefined;
	}

	async addInbox(item: Omit<InboxItem, "id" | "ts" | "status"> & { id?: string; ts?: string; status?: InboxItem["status"] }): Promise<InboxItem> {
		const full: InboxItem = { id: item.id ?? `i-${randomBytes(4).toString("hex")}`, ts: item.ts ?? now(), status: item.status ?? "pending", ...item } as InboxItem;
		await this.db.q(
			`REPLACE INTO ${T("inbox")} (id, ts, source, text, kind, scope, cwd, project_key, session_id, session_file, entry_id, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			[full.id, full.ts, full.source, full.text, full.kind ?? null, full.scope ?? null, full.cwd ?? "", full.projectKey ?? "", full.sessionId ?? null, full.sessionFile ?? null, full.entryId ?? null, full.status],
		);
		return full;
	}

	async setInboxStatus(ids: readonly string[], status: InboxItem["status"], runId?: string): Promise<void> {
		if (!ids.length) return;
		await this.db.q(`UPDATE ${T("inbox")} SET status = ?, run_id = ?, done_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`, [status, runId ?? null, now(), ...ids]);
	}

	// ── sessions the dreams have read ────────────────────────────────────

	async marks(): Promise<Record<string, SessionMark>> {
		const rows = await this.db.q(`SELECT * FROM ${T("session_marks")}`);
		const out: Record<string, SessionMark> = {};
		for (const r of rows) out[String(r.path)] = { size: Number(r.size), mtimeMs: Number(r.mtime_ms), at: String(r.at), ok: Number(r.ok) === 1, failures: Number(r.failures) };
		return out;
	}

	async setMarks(marks: Record<string, SessionMark>): Promise<void> {
		const entries = Object.entries(marks);
		for (let i = 0; i < entries.length; i += 200) {
			const chunk = entries.slice(i, i + 200);
			await this.db.q(
				`REPLACE INTO ${T("session_marks")} (path, size, mtime_ms, at, ok, failures) VALUES ${chunk.map(() => "(?,?,?,?,?,?)").join(",")}`,
				chunk.flatMap(([path, m]) => [path, m.size, m.mtimeMs, m.at, m.ok ? 1 : 0, m.failures ?? 0]),
			);
		}
	}

	// ── runs ─────────────────────────────────────────────────────────────

	private runRow(r: Row): RunInfo {
		return {
			id: String(r.id),
			kind: (str(r.kind) ?? "run") as RunInfo["kind"],
			status: (str(r.status) ?? "error") as RunInfo["status"],
			startedAt: String(r.started_at),
			finishedAt: str(r.finished_at),
			error: str(r.error),
			sessions: r.sessions === null || r.sessions === undefined ? undefined : Number(r.sessions),
			cost: r.cost === null || r.cost === undefined ? undefined : Number(r.cost),
			reviewId: str(r.review_id),
			title: str(r.title),
			pid: r.pid === null || r.pid === undefined ? undefined : Number(r.pid),
			trigger: str(r.trigger_by),
		};
	}

	private static RUN_COLS = "id, kind, status, trigger_by, started_at, finished_at, pid, error, sessions, cost, review_id, title";

	async runs(limit = 50): Promise<RunInfo[]> {
		const rows = await this.db.q(`SELECT ${StateStore.RUN_COLS} FROM ${T("runs")} ORDER BY started_at DESC LIMIT ?`, [limit]);
		return rows.map((r) => this.runRow(r));
	}

	async run(id: string): Promise<(RunInfo & { opts: Record<string, unknown>; report?: ReportData }) | undefined> {
		const rows = await this.db.q(`SELECT * FROM ${T("runs")} WHERE id = ?`, [id]);
		if (!rows[0]) return undefined;
		return { ...this.runRow(rows[0]), opts: json(rows[0].opts, {}), report: json<ReportData | undefined>(rows[0].report, undefined) };
	}

	async runReports(ids: readonly string[]): Promise<ReportData[]> {
		if (!ids.length) return [];
		const rows = await this.db.q(`SELECT id, report FROM ${T("runs")} WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY started_at`, [...ids]);
		return rows.map((r) => json<ReportData | undefined>(r.report, undefined)).filter((r): r is ReportData => !!r && Array.isArray(r.items));
	}

	async createRun(run: RunInfo & { opts?: Record<string, unknown> }): Promise<void> {
		await this.db.q(`INSERT INTO ${T("runs")} (id, kind, status, trigger_by, started_at, pid, opts) VALUES (?,?,?,?,?,?,?)`, [
			run.id,
			run.kind,
			run.status,
			run.trigger ?? null,
			run.startedAt,
			run.pid ?? null,
			JSON.stringify(run.opts ?? {}),
		]);
	}

	async updateRun(id: string, patch: Partial<RunInfo> & { report?: ReportData }): Promise<void> {
		const sets: string[] = [];
		const vals: unknown[] = [];
		const map: Record<string, string> = { status: "status", finishedAt: "finished_at", pid: "pid", error: "error", sessions: "sessions", cost: "cost", reviewId: "review_id", title: "title" };
		for (const [k, col] of Object.entries(map)) {
			if (!(k in patch)) continue;
			sets.push(`${col} = ?`);
			vals.push((patch as Record<string, unknown>)[k] ?? null);
		}
		if (patch.report) {
			sets.push("report = ?");
			vals.push(JSON.stringify(patch.report));
		}
		if (!sets.length) return;
		await this.db.q(`UPDATE ${T("runs")} SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
	}

	/** The latest finished dream that counts for the schedule (not a dry run, a reindex or a comments-only pass). */
	async lastDream(): Promise<RunInfo | undefined> {
		const rows = await this.db.q(`SELECT ${StateStore.RUN_COLS} FROM ${T("runs")} WHERE kind = 'run' AND status <> 'running' ORDER BY started_at DESC LIMIT 1`);
		return rows[0] ? this.runRow(rows[0]) : undefined;
	}

	async runningRuns(): Promise<RunInfo[]> {
		const rows = await this.db.q(`SELECT ${StateStore.RUN_COLS} FROM ${T("runs")} WHERE status = 'running' ORDER BY started_at DESC`);
		return rows.map((r) => this.runRow(r));
	}

	// ── reviews ──────────────────────────────────────────────────────────

	private reviewRow(r: Row): ReviewRow {
		return {
			id: String(r.id),
			branch: String(r.branch),
			status: (str(r.status) ?? "open") as ReviewRow["status"],
			title: String(r.title ?? ""),
			createdAt: String(r.created_at),
			closedAt: str(r.closed_at),
			baseCommit: str(r.base_commit),
			runs: json<string[]>(r.runs, []),
		};
	}

	async openReview(): Promise<ReviewRow | undefined> {
		const rows = await this.db.q(`SELECT * FROM ${T("reviews")} WHERE status = 'open' ORDER BY created_at DESC LIMIT 1`);
		return rows[0] ? this.reviewRow(rows[0]) : undefined;
	}

	async review(id: string): Promise<ReviewRow | undefined> {
		const rows = await this.db.q(`SELECT * FROM ${T("reviews")} WHERE id = ?`, [id]);
		return rows[0] ? this.reviewRow(rows[0]) : undefined;
	}

	async reviews(limit = 50): Promise<ReviewRow[]> {
		const rows = await this.db.q(`SELECT * FROM ${T("reviews")} ORDER BY created_at DESC LIMIT ?`, [limit]);
		return rows.map((r) => this.reviewRow(r));
	}

	async saveReview(r: ReviewRow): Promise<void> {
		await this.db.q(`REPLACE INTO ${T("reviews")} (id, branch, status, title, created_at, closed_at, base_commit, runs) VALUES (?,?,?,?,?,?,?,?)`, [
			r.id,
			r.branch,
			r.status,
			r.title,
			r.createdAt,
			r.closedAt ?? null,
			r.baseCommit ?? null,
			JSON.stringify(r.runs),
		]);
	}

	async decisions(reviewId: string): Promise<ReviewDecision[]> {
		const rows = await this.db.q(`SELECT * FROM ${T("review_decisions")} WHERE review_id = ? ORDER BY seq`, [reviewId]);
		return rows.map((r) => ({
			key: String(r.item_key),
			kind: String(r.kind),
			noteId: str(r.note_id),
			title: String(r.title ?? ""),
			scope: str(r.scope),
			decision: (str(r.decision) ?? "accepted") as ReviewDecision["decision"],
			at: String(r.at),
			by: String(r.by_who ?? ""),
			reason: str(r.reason),
		}));
	}

	async decisionCounts(reviewIds: readonly string[]): Promise<Record<string, { accepted: number; rejected: number }>> {
		const out: Record<string, { accepted: number; rejected: number }> = {};
		if (!reviewIds.length) return out;
		const rows = await this.db.q(`SELECT review_id, decision, COUNT(*) AS n FROM ${T("review_decisions")} WHERE review_id IN (${reviewIds.map(() => "?").join(",")}) GROUP BY review_id, decision`, [...reviewIds]);
		for (const r of rows) {
			const c = (out[String(r.review_id)] ??= { accepted: 0, rejected: 0 });
			if (r.decision === "rejected") c.rejected += Number(r.n);
			else c.accepted += Number(r.n);
		}
		return out;
	}

	async addDecision(reviewId: string, d: ReviewDecision): Promise<void> {
		await this.db.q(`INSERT INTO ${T("review_decisions")} (review_id, item_key, kind, note_id, title, scope, decision, at, by_who, reason) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
			reviewId,
			d.key,
			d.kind,
			d.noteId ?? null,
			d.title,
			d.scope ?? null,
			d.decision,
			d.at,
			d.by,
			d.reason ?? null,
		]);
	}

	private commentRow(r: Row): ReviewComment {
		return { id: String(r.id), reviewId: String(r.review_id), noteId: str(r.note_id), body: String(r.body ?? ""), author: String(r.author ?? ""), at: String(r.at), processedRun: str(r.processed_run), unhandled: str(r.unhandled) };
	}

	async comments(reviewId: string): Promise<ReviewComment[]> {
		const rows = await this.db.q(`SELECT * FROM ${T("review_comments")} WHERE review_id = ? ORDER BY at`, [reviewId]);
		return rows.map((r) => this.commentRow(r));
	}

	async addComment(reviewId: string, body: string, author: string, noteId?: string): Promise<ReviewComment> {
		const c: ReviewComment = { id: `c-${randomBytes(4).toString("hex")}`, reviewId, noteId, body, author, at: now() };
		await this.db.q(`INSERT INTO ${T("review_comments")} (id, review_id, note_id, body, author, at) VALUES (?,?,?,?,?,?)`, [c.id, reviewId, noteId ?? null, body, author, c.at]);
		return c;
	}

	async removeComment(id: string): Promise<void> {
		await this.db.q(`DELETE FROM ${T("review_comments")} WHERE id = ? AND processed_run IS NULL`, [id]);
	}

	async markComments(done: ReadonlyArray<{ id: string; unhandled?: string }>, runId: string): Promise<void> {
		for (const c of done) await this.db.q(`UPDATE ${T("review_comments")} SET processed_run = ?, unhandled = ? WHERE id = ?`, [runId, c.unhandled ?? null, c.id]);
	}

	// ── rejected titles ──────────────────────────────────────────────────

	async addRejection(title: string, reviewId?: string, noteId?: string): Promise<void> {
		await this.db.q(`INSERT INTO ${T("rejections")} (title, at, review_id, note_id) VALUES (?,?,?,?)`, [title, now(), reviewId ?? null, noteId ?? null]);
	}

	async rejectedTitles(limit = 40): Promise<string[]> {
		const rows = await this.db.q(`SELECT title FROM ${T("rejections")} ORDER BY seq DESC LIMIT ?`, [limit]);
		return rows.map((r) => String(r.title)).reverse();
	}

	// ── usefulness votes ─────────────────────────────────────────────────

	async stats(): Promise<Map<string, NoteStats>> {
		const rows = await this.db.q(`SELECT note_id, helpful, harmful FROM ${T("note_stats")}`);
		return new Map(rows.map((r) => [String(r.note_id), { helpful: Number(r.helpful), harmful: Number(r.harmful) }]));
	}

	async addVotes(votes: Record<string, { helpful: number; harmful: number }>): Promise<void> {
		for (const [id, v] of Object.entries(votes)) {
			if (!v.helpful && !v.harmful) continue;
			await this.db.q(`INSERT INTO ${T("note_stats")} (note_id, helpful, harmful) VALUES (?,?,?) ON DUPLICATE KEY UPDATE helpful = helpful + VALUES(helpful), harmful = harmful + VALUES(harmful)`, [id, v.helpful, v.harmful]);
		}
	}

	async setStats(id: string, s: NoteStats): Promise<void> {
		await this.db.q(`REPLACE INTO ${T("note_stats")} (note_id, helpful, harmful) VALUES (?,?,?)`, [id, s.helpful, s.harmful]);
	}

	// ── AGENTS.md proposals ──────────────────────────────────────────────

	private agentsRow(r: Row): Omit<AgentsProposal, "projectName"> {
		return {
			id: String(r.id),
			runId: String(r.run_id ?? ""),
			reviewId: str(r.review_id),
			projectKey: String(r.project_key ?? ""),
			repoRoot: String(r.repo_root),
			rel: String(r.rel),
			summary: str(r.summary),
			edits: json<AgentsProposal["edits"]>(r.edits, []),
			rationale: json<string[]>(r.rationale, []),
			status: (str(r.status) ?? "pending") as AgentsProposal["status"],
			error: str(r.error),
			createdAt: String(r.created_at),
			decidedAt: str(r.decided_at),
		};
	}

	async agentsProposals(where: { status?: AgentsProposal["status"]; reviewId?: string } = {}): Promise<Array<Omit<AgentsProposal, "projectName">>> {
		const cond: string[] = [];
		const vals: unknown[] = [];
		if (where.status) {
			cond.push("status = ?");
			vals.push(where.status);
		}
		if (where.reviewId) {
			cond.push("review_id = ?");
			vals.push(where.reviewId);
		}
		const rows = await this.db.q(`SELECT * FROM ${T("agents_proposals")}${cond.length ? ` WHERE ${cond.join(" AND ")}` : ""} ORDER BY created_at`, vals);
		return rows.map((r) => this.agentsRow(r));
	}

	async agentsProposal(id: string): Promise<Omit<AgentsProposal, "projectName"> | undefined> {
		const rows = await this.db.q(`SELECT * FROM ${T("agents_proposals")} WHERE id = ?`, [id]);
		return rows[0] ? this.agentsRow(rows[0]) : undefined;
	}

	async addAgentsProposal(p: { runId: string; reviewId?: string; projectKey: string; repoRoot: string; rel: string; summary?: string; edits: AgentsProposal["edits"]; rationale: string[] }): Promise<string> {
		const id = `a-${randomBytes(4).toString("hex")}`;
		await this.db.q(`INSERT INTO ${T("agents_proposals")} (id, run_id, review_id, project_key, repo_root, rel, summary, edits, rationale, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
			id,
			p.runId,
			p.reviewId ?? null,
			p.projectKey,
			p.repoRoot,
			p.rel,
			p.summary ?? null,
			JSON.stringify(p.edits),
			JSON.stringify(p.rationale),
			"pending",
			now(),
		]);
		return id;
	}

	async updateAgentsProposal(id: string, patch: { status?: AgentsProposal["status"]; error?: string | null; edits?: AgentsProposal["edits"] }): Promise<void> {
		const sets: string[] = [];
		const vals: unknown[] = [];
		if (patch.status) {
			sets.push("status = ?", "decided_at = ?");
			vals.push(patch.status, patch.status === "pending" ? null : now());
		}
		if ("error" in patch) {
			sets.push("error = ?");
			vals.push(patch.error ?? null);
		}
		if (patch.edits) {
			sets.push("edits = ?");
			vals.push(JSON.stringify(patch.edits));
		}
		if (!sets.length) return;
		await this.db.q(`UPDATE ${T("agents_proposals")} SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
	}
}
