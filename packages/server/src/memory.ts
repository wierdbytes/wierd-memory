/**
 * The memory database (`wmem`): notes, scopes, skills and prompts at a branch,
 * and their history.
 *
 * Reads and writes name the branch explicitly: `main` is approved memory, a
 * review branch is `main` plus what a dream proposes. Nothing here decides
 * what may be written where — `reviews.ts` and `app.ts` do.
 */

import {
	type CommitInfo,
	type Evidence,
	INDEX_MODES,
	type Note,
	NOTE_STATUSES,
	NOTE_TYPES,
	type NoteColumn,
	type NoteHistoryEntry,
	oneOf,
	parseEvidence,
	type ScopeMeta,
	type SkillDraft,
} from "@wierd-mem/core";
import { type Db, MAIN, memAt, type Row, safeRef } from "./dolt.ts";

export interface ScopeRow extends ScopeMeta {
	charter: string | null;
	created?: string;
}

export interface SkillRow extends SkillDraft {
	created?: string;
	updated?: string;
}

const NOTE_COLS = "id, scope, title, type, status, index_mode, when_text, body, pinned, enabled, created, updated, confirmed, valid_until, superseded_by, supersedes, evidence, extra";

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

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export function noteFromRow(r: Row, prefix = ""): Note {
	const g = (k: string) => r[prefix + k];
	const supersedes = json<unknown[]>(g("supersedes"), []);
	const extra = json<Record<string, unknown>>(g("extra"), {});
	return {
		id: String(g("id")),
		scope: String(g("scope")),
		title: String(g("title") ?? ""),
		type: oneOf(NOTE_TYPES, g("type")) ? (g("type") as Note["type"]) : "fact",
		status: oneOf(NOTE_STATUSES, g("status")) ? (g("status") as Note["status"]) : "active",
		index: oneOf(INDEX_MODES, g("index_mode")) ? (g("index_mode") as Note["index"]) : "none",
		when: str(g("when_text")),
		body: String(g("body") ?? ""),
		pinned: Number(g("pinned")) === 1,
		enabled: Number(g("enabled")) !== 0,
		created: String(g("created") ?? ""),
		updated: String(g("updated") ?? ""),
		confirmed: str(g("confirmed")),
		validUntil: str(g("valid_until")),
		supersededBy: str(g("superseded_by")),
		supersedes: Array.isArray(supersedes) ? supersedes.filter((x): x is string => typeof x === "string") : [],
		evidence: parseEvidence(json<unknown>(g("evidence"), [])),
		extra: extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {},
	};
}

function evidenceJson(list: Evidence[]): string {
	return JSON.stringify(
		list.map((e) => {
			const o: Record<string, unknown> = { s: e.s, e: e.e };
			if (e.date) o.date = e.date;
			if (e.at) o.at = e.at;
			if (e.kind) o.kind = e.kind;
			return o;
		}),
	);
}

function noteParams(n: Note): unknown[] {
	return [
		n.id,
		n.scope,
		n.title,
		n.type,
		n.status,
		n.index,
		n.when ?? null,
		n.body ?? "",
		n.pinned ? 1 : 0,
		n.enabled === false ? 0 : 1,
		n.created,
		n.updated || n.created,
		n.confirmed ?? null,
		n.validUntil ?? null,
		n.supersededBy ?? null,
		JSON.stringify(n.supersedes ?? []),
		evidenceJson(n.evidence ?? []),
		JSON.stringify(n.extra ?? {}),
	];
}

/** Database column → the note field it holds (for history). */
const COLUMN_FIELD: Record<string, NoteColumn> = {
	scope: "scope",
	title: "title",
	type: "type",
	status: "status",
	index_mode: "index",
	when_text: "when",
	body: "body",
	pinned: "pinned",
	enabled: "enabled",
	created: "created",
	updated: "updated",
	confirmed: "confirmed",
	valid_until: "validUntil",
	superseded_by: "supersededBy",
	supersedes: "supersedes",
	evidence: "evidence",
	extra: "extra",
};

export class MemoryStore {
	constructor(readonly db: Db) {}

	// ── notes ────────────────────────────────────────────────────────────

	async notes(ref: string = MAIN): Promise<Note[]> {
		const rows = await this.db.q(`SELECT ${NOTE_COLS} FROM ${memAt(ref)}.notes ORDER BY id`);
		return rows.map((r) => noteFromRow(r));
	}

	/** Notes as they were at a commit. */
	async notesAt(commit: string): Promise<Note[]> {
		return this.db.onBranch(MAIN, async (c) => {
			const [rows] = await c.query(`SELECT ${NOTE_COLS} FROM notes AS OF ? ORDER BY id`, [safeRef(commit)]);
			return (rows as Row[]).map((r) => noteFromRow(r));
		});
	}

	async note(id: string, ref: string = MAIN): Promise<Note | undefined> {
		const rows = await this.db.q(`SELECT ${NOTE_COLS} FROM ${memAt(ref)}.notes WHERE id = ?`, [id]);
		return rows[0] ? noteFromRow(rows[0]) : undefined;
	}

	async upsert(ref: string, notes: readonly Note[]): Promise<void> {
		for (const n of notes) {
			await this.db.q(`REPLACE INTO ${memAt(ref)}.notes (${NOTE_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, noteParams(n));
		}
	}

	async remove(ref: string, ids: readonly string[]): Promise<void> {
		if (!ids.length) return;
		await this.db.q(`DELETE FROM ${memAt(ref)}.notes WHERE id IN (${ids.map(() => "?").join(",")})`, [...ids]);
	}

	async noteIds(ref: string = MAIN): Promise<Set<string>> {
		const rows = await this.db.q(`SELECT id FROM ${memAt(ref)}.notes`);
		return new Set(rows.map((r) => String(r.id)));
	}

	// ── scopes ───────────────────────────────────────────────────────────

	async scopes(ref: string = MAIN): Promise<ScopeRow[]> {
		const rows = await this.db.q(`SELECT id, project_key, root, charter, created FROM ${memAt(ref)}.scopes ORDER BY id`);
		return rows.map((r) => ({ id: String(r.id), key: str(r.project_key), root: str(r.root), charter: str(r.charter) ?? null, created: str(r.created) }));
	}

	/** Create a scope, or fill in what is not known yet (key, root). The charter is left alone. */
	async ensureScope(ref: string, s: ScopeMeta): Promise<void> {
		await this.db.q(
			`INSERT INTO ${memAt(ref)}.scopes (id, project_key, root, charter, created) VALUES (?,?,?,NULL,?)
			 ON DUPLICATE KEY UPDATE project_key = COALESCE(project_key, VALUES(project_key)), root = COALESCE(VALUES(root), root)`,
			[s.id, s.key ?? null, s.root ?? null, new Date().toISOString()],
		);
	}

	async setCharter(ref: string, id: string, charter: string | null): Promise<void> {
		await this.db.q(`UPDATE ${memAt(ref)}.scopes SET charter = ? WHERE id = ?`, [charter?.trim() ? charter.trim() : null, id]);
	}

	async removeScope(ref: string, id: string): Promise<void> {
		await this.db.q(`DELETE FROM ${memAt(ref)}.scopes WHERE id = ?`, [id]);
	}

	/** Make a branch's `scopes` and `prompts` the same as `main`'s (they are never proposed, only notes and skills are). */
	async copyShared(to: string): Promise<void> {
		for (const table of ["scopes", "prompts"]) {
			await this.db.q(`DELETE FROM ${memAt(to)}.${table}`);
			await this.db.q(`INSERT INTO ${memAt(to)}.${table} SELECT * FROM ${memAt(MAIN)}.${table}`);
		}
	}

	// ── skills ───────────────────────────────────────────────────────────

	async skills(ref: string = MAIN): Promise<SkillRow[]> {
		const rows = await this.db.q(`SELECT scope, name, description, body, created, updated FROM ${memAt(ref)}.skills ORDER BY scope, name`);
		return rows.map((r) => ({ scope: String(r.scope), name: String(r.name), description: String(r.description ?? ""), body: String(r.body ?? ""), created: str(r.created), updated: str(r.updated) }));
	}

	async upsertSkill(ref: string, s: SkillDraft, date: string): Promise<void> {
		await this.db.q(
			`INSERT INTO ${memAt(ref)}.skills (scope, name, description, body, created, updated) VALUES (?,?,?,?,?,?)
			 ON DUPLICATE KEY UPDATE description = VALUES(description), body = VALUES(body), updated = VALUES(updated)`,
			[s.scope, s.name, s.description, s.body, date, date],
		);
	}

	async removeSkill(ref: string, scope: string, name: string): Promise<void> {
		await this.db.q(`DELETE FROM ${memAt(ref)}.skills WHERE scope = ? AND name = ?`, [scope, name]);
	}

	// ── prompts ──────────────────────────────────────────────────────────

	async prompts(ref: string = MAIN): Promise<Record<string, string>> {
		const rows = await this.db.q(`SELECT name, body FROM ${memAt(ref)}.prompts`);
		return Object.fromEntries(rows.map((r) => [String(r.name), String(r.body ?? "")]));
	}

	async setPrompt(ref: string, name: string, body: string | null): Promise<void> {
		if (!body?.trim()) await this.db.q(`DELETE FROM ${memAt(ref)}.prompts WHERE name = ?`, [name]);
		else await this.db.q(`REPLACE INTO ${memAt(ref)}.prompts (name, body, updated) VALUES (?,?,?)`, [name, body.trim(), new Date().toISOString()]);
	}

	// ── history ──────────────────────────────────────────────────────────

	async log(limit = 100, ref: string = MAIN): Promise<CommitInfo[]> {
		return this.db.onBranch(ref, async (c) => {
			const [rows] = await c.query("SELECT commit_hash, committer, email, date, message FROM dolt_log ORDER BY date DESC, commit_order DESC LIMIT ?", [limit]);
			return (rows as Row[]).map((r) => ({ hash: String(r.commit_hash), author: String(r.committer), email: String(r.email), date: isoDate(r.date), message: String(r.message) }));
		});
	}

	/** Every commit on `main` that changed the note, newest first, with what it changed. */
	async noteHistory(id: string): Promise<NoteHistoryEntry[]> {
		return this.db.onBranch(MAIN, async (c) => {
			const [rows] = await c.query(
				`SELECT d.*, l.committer AS _author, l.message AS _message
				 FROM dolt_diff_notes d LEFT JOIN dolt_log l ON l.commit_hash = d.to_commit
				 WHERE (d.to_id = ? OR d.from_id = ?) AND d.to_commit <> 'WORKING'
				 ORDER BY d.to_commit_date DESC`,
				[id, id],
			);
			return (rows as Row[]).map((r) => historyEntry(r));
		});
	}

	/** Notes a commit changed: [before, after] pairs (either side absent for added / removed). */
	async commitChanges(hash: string): Promise<Array<{ type: string; before?: Note; after?: Note }>> {
		return this.db.onBranch(MAIN, async (c) => {
			const [rows] = await c.query("SELECT * FROM dolt_diff_notes WHERE to_commit = ?", [safeRef(hash)]);
			return (rows as Row[]).map((r) => ({
				type: String(r.diff_type),
				before: r.from_id ? noteFromRow(r, "from_") : undefined,
				after: r.to_id ? noteFromRow(r, "to_") : undefined,
			}));
		});
	}
}

function isoDate(v: unknown): string {
	if (v instanceof Date) return v.toISOString();
	const s = String(v ?? "");
	// "2026-11-09 21:00:41.928" (UTC, as Dolt prints commit dates) → ISO
	const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(s);
	return m ? `${m[1]}T${m[2]}${m[3] ?? ""}Z` : s;
}

function historyEntry(r: Row): NoteHistoryEntry {
	const type = String(r.diff_type);
	const before = r.from_id ? noteFromRow(r, "from_") : undefined;
	const after = r.to_id ? noteFromRow(r, "to_") : undefined;
	const changes: NoteHistoryEntry["changes"] = {};
	for (const field of Object.values(COLUMN_FIELD)) {
		const a = before ? (before as unknown as Record<string, unknown>)[field] : undefined;
		const b = after ? (after as unknown as Record<string, unknown>)[field] : undefined;
		if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes[field] = [a ?? null, b ?? null];
	}
	return { commit: String(r.to_commit), date: isoDate(r.to_commit_date), author: String(r._author ?? ""), message: String(r._message ?? ""), type, changes };
}
