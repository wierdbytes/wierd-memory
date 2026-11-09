/**
 * Memory notes — the unit of memory.
 *
 * A note is one row of the `notes` table in the Dolt database (`wmem`): a
 * one-line statement (the title — it is also the line agents see in their
 * context), the specifics (body), how it reaches agents (index) and the
 * evidence behind it. `main` holds approved memory; a dream writes its
 * proposals to a review branch.
 */

import { randomBytes } from "node:crypto";

export const NOTE_TYPES = ["preference", "procedure", "pitfall", "fact", "decision", "reference"] as const;
export const NOTE_STATUSES = ["active", "superseded", "deprecated"] as const;
export const INDEX_MODES = ["always", "pointer", "none"] as const;
export const EVIDENCE_KINDS = ["user", "observed", "inbox", "reviewer"] as const;

export type NoteType = (typeof NOTE_TYPES)[number];
export type NoteStatus = (typeof NOTE_STATUSES)[number];
export type IndexMode = (typeof INDEX_MODES)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Evidence {
	/**
	 * Where it comes from: a pi session id, `inbox:<id>`, `review:<comment id>`
	 * (a comment left in a review), `manual` (a hand edit) or `pr#<n>` (a GitHub
	 * pull request comment, in notes imported from pi-dream).
	 */
	s: string;
	/** Entry ids (or comment ids). */
	e: string[];
	date?: string;
	/** When the cited entries were written (ISO, minute precision, UTC); the latest of them. */
	at?: string;
	kind?: EvidenceKind;
}

export interface NoteStats {
	helpful: number;
	harmful: number;
}

export interface Note {
	id: string;
	/** Scope id: `global` or `projects/<dir>`. */
	scope: string;
	title: string;
	type: NoteType;
	status: NoteStatus;
	index: IndexMode;
	when?: string;
	body: string;
	/** A dream never closes a pinned note; it is first in the index. */
	pinned: boolean;
	/** `false`: turned off by the user — not injected, not found by agents, left alone by dreams. */
	enabled: boolean;
	created: string;
	updated: string;
	confirmed?: string;
	validUntil?: string;
	supersededBy?: string;
	supersedes: string[];
	evidence: Evidence[];
	/** Unknown fields carried over from imports. */
	extra: Record<string, unknown>;
	/** Usefulness votes from session cards (bookkeeping, kept outside the versioned row). */
	stats?: NoteStats;
}

/** The fields a person (or a review edit) can change. */
export interface NoteFields {
	type?: NoteType;
	title?: string;
	body?: string;
	when?: string;
	index?: IndexMode;
}

export const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
	typeof v === "string" && (list as readonly string[]).includes(v);

export function isNoteId(v: unknown): v is string {
	return typeof v === "string" && /^m-[0-9a-f]{6,12}$/.test(v);
}

export function newNoteId(taken: Set<string>): string {
	for (;;) {
		const id = `m-${randomBytes(3).toString("hex")}`;
		if (!taken.has(id)) {
			taken.add(id);
			return id;
		}
	}
}

/** ISO timestamp cut to minutes: `2026-10-31T13:50Z`. */
export function isoMinute(v: string | number | undefined): string | undefined {
	if (v === undefined || v === "") return undefined;
	const t = typeof v === "number" ? v : Date.parse(v);
	if (!Number.isFinite(t)) return undefined;
	return `${new Date(t).toISOString().slice(0, 16)}Z`;
}

/** Creation time of a UUIDv7 session id (pi session ids are v7), in ms. */
export function uuidV7Time(id: string): number | undefined {
	const hex = id.replace(/-/g, "");
	if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "7") return undefined;
	return Number.parseInt(hex.slice(0, 12), 16);
}

/** Evidence that is not a pi session: inbox items, review comments, hand edits. */
export function isSessionEvidence(e: Pick<Evidence, "s">): boolean {
	return !/^(inbox:|review:|pr#|manual)/.test(e.s);
}

/**
 * When a piece of evidence was observed, in ms: the cited entries' time, else
 * the session start (`startOf`, then the id itself), else the day.
 */
export function evidenceTime(e: Evidence, startOf?: (sessionId: string) => string | undefined): number | undefined {
	const at = e.at ? Date.parse(e.at) : Number.NaN;
	if (Number.isFinite(at)) return at;
	if (isSessionEvidence(e)) {
		const started = startOf?.(e.s);
		const t = started ? Date.parse(started) : Number.NaN;
		if (Number.isFinite(t)) return t;
		const v7 = uuidV7Time(e.s);
		if (v7 !== undefined) return v7;
	}
	const day = e.date ? Date.parse(e.date) : Number.NaN;
	return Number.isFinite(day) ? day : undefined;
}

export function evidenceKey(e: Evidence): string {
	return `${e.s}|${[...e.e].sort().join(",")}`;
}

/** Append evidence not already there; returns how many were added. */
export function mergeEvidence(into: Evidence[], add: readonly Evidence[]): number {
	const seen = new Set(into.map(evidenceKey));
	let n = 0;
	for (const e of add) {
		const k = evidenceKey(e);
		if (seen.has(k)) continue;
		seen.add(k);
		into.push(e);
		n++;
	}
	return n;
}

export function parseEvidence(v: unknown): Evidence[] {
	if (!Array.isArray(v)) return [];
	const out: Evidence[] = [];
	for (const item of v) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		if (typeof o.s !== "string" || !o.s) continue;
		const e = Array.isArray(o.e) ? o.e.filter((x): x is string => typeof x === "string") : typeof o.e === "string" ? [o.e] : [];
		const at = typeof o.at === "string" ? isoMinute(o.at) : o.at instanceof Date ? isoMinute(o.at.getTime()) : undefined;
		const date = o.date instanceof Date ? o.date.toISOString().slice(0, 10) : typeof o.date === "string" && o.date.trim() ? o.date.trim() : undefined;
		const ev: Evidence = { s: o.s, e };
		if (date) ev.date = date;
		if (at) ev.at = at;
		if (oneOf(EVIDENCE_KINDS, o.kind)) ev.kind = o.kind;
		out.push(ev);
	}
	return out;
}

export function cloneNote(n: Note): Note {
	return {
		...n,
		supersedes: [...n.supersedes],
		evidence: n.evidence.map((e) => ({ ...e, e: [...e.e] })),
		extra: { ...n.extra },
		stats: n.stats ? { ...n.stats } : undefined,
	};
}

/** A complete note from partial input (a new note written by hand or by a dream). */
export function makeNote(p: Partial<Note> & { id: string; scope: string; title: string }, date: string): Note {
	return {
		id: p.id,
		scope: p.scope,
		title: p.title,
		type: p.type ?? "fact",
		status: p.status ?? "active",
		index: p.index ?? "none",
		when: p.when || undefined,
		body: p.body ?? "",
		pinned: p.pinned ?? false,
		enabled: p.enabled ?? true,
		created: p.created || date,
		updated: p.updated || p.created || date,
		confirmed: p.confirmed || undefined,
		validUntil: p.validUntil || undefined,
		supersededBy: p.supersededBy || undefined,
		supersedes: p.supersedes ?? [],
		evidence: p.evidence ?? [],
		extra: p.extra ?? {},
		stats: p.stats,
	};
}

// ── the versioned row ────────────────────────────────────────────────────

/** Columns of a note's row, in the order comparisons and diffs list them. */
export const NOTE_COLUMNS = [
	"scope",
	"title",
	"type",
	"status",
	"index",
	"when",
	"body",
	"pinned",
	"enabled",
	"created",
	"updated",
	"confirmed",
	"validUntil",
	"supersededBy",
	"supersedes",
	"evidence",
	"extra",
] as const;
export type NoteColumn = (typeof NOTE_COLUMNS)[number];

/** JSON with sorted keys: equal values give equal strings whatever order the database returns keys in. */
export function canonical(v: unknown): string {
	if (v === undefined || v === null) return "null";
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (typeof v === "object") {
		const o = v as Record<string, unknown>;
		return `{${Object.keys(o)
			.filter((k) => o[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(v);
}

/** A column's value in comparable form (missing and empty optional values are the same). */
export function columnValue(n: Note, c: NoteColumn): string {
	const v: unknown = n[c];
	if (c === "evidence") return canonical((v as Evidence[]).map((e) => ({ s: e.s, e: e.e, date: e.date, at: e.at, kind: e.kind })));
	if (v === undefined || v === null || v === "") return "null";
	if (typeof v === "string") return JSON.stringify(c === "body" || c === "title" ? v.trim() : v);
	return canonical(v);
}

/** Columns in which two versions of a note differ. */
export function changedColumns(a: Note, b: Note): NoteColumn[] {
	return NOTE_COLUMNS.filter((c) => columnValue(a, c) !== columnValue(b, c));
}

export function sameNote(a: Note | undefined, b: Note | undefined): boolean {
	if (!a || !b) return a === b;
	return a.id === b.id && changedColumns(a, b).length === 0;
}

// ── text helpers ─────────────────────────────────────────────────────────

const TRANSLIT: Record<string, string> = {
	а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
	н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "",
	ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** File-name-safe slug of a title (used when notes are exported as files). */
export function slugify(title: string, max = 60): string {
	const t = [...title.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join("");
	let s = t
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (s.length > max) {
		s = s.slice(0, max);
		const cut = s.lastIndexOf("-");
		if (cut > max / 2) s = s.slice(0, cut);
	}
	return s || "note";
}

const j = (v: unknown) => JSON.stringify(v);

/** A note as a Markdown file with front matter (the format pi-dream kept in git) — for export. */
export function serializeNote(n: Note): string {
	const lines = ["---", `id: ${n.id}`, `title: ${j(n.title)}`, `type: ${n.type}`, `status: ${n.status}`, `index: ${n.index}`];
	if (n.when) lines.push(`when: ${j(n.when)}`);
	if (n.pinned) lines.push("pinned: true");
	if (!n.enabled) lines.push("enabled: false");
	lines.push(`created: ${j(n.created)}`, `updated: ${j(n.updated)}`);
	if (n.confirmed) lines.push(`confirmed: ${j(n.confirmed)}`);
	if (n.validUntil) lines.push(`valid_until: ${j(n.validUntil)}`);
	if (n.supersededBy) lines.push(`superseded_by: ${j(n.supersededBy)}`);
	if (n.supersedes.length) lines.push(`supersedes: ${j(n.supersedes)}`);
	if (n.stats && (n.stats.helpful || n.stats.harmful)) lines.push(`stats: ${j({ helpful: n.stats.helpful, harmful: n.stats.harmful })}`);
	if (n.evidence.length) {
		lines.push("evidence:");
		for (const ev of n.evidence) {
			const o: Record<string, unknown> = { s: ev.s, e: ev.e };
			if (ev.date) o.date = ev.date;
			if (ev.at) o.at = ev.at;
			if (ev.kind) o.kind = ev.kind;
			lines.push(`  - ${j(o)}`);
		}
	}
	for (const [k, v] of Object.entries(n.extra)) if (v !== undefined) lines.push(`${k}: ${j(v)}`);
	lines.push("---", "", n.body.trim(), "");
	return lines.join("\n");
}
