/**
 * A note as a file: `scopes/<scope>/notes/<slug>.md`, YAML front matter and a
 * Markdown body — the format pi-dream wrote, so its repositories and their
 * history carry over as they are.
 *
 * Reading is lenient: a note written by hand without an id, with plain YAML
 * instead of JSON values, or with unknown fields still loads (unknown fields
 * are kept). Writing is canonical (`serializeNote`), and a file is only
 * rewritten when the note in it really changed.
 */

import { INDEX_MODES, isNoteId, makeNote, type Note, NOTE_STATUSES, NOTE_TYPES, type NoteStats, oneOf, parseEvidence, serializeNote, slugify, type SkillDraft } from "@wierd-memory/core";
import { parse as parseYaml } from "yaml";

const KNOWN = new Set(["id", "title", "type", "status", "index", "when", "pinned", "enabled", "created", "updated", "confirmed", "valid_until", "superseded_by", "supersedes", "stats", "evidence"]);

export function frontMatter(text: string): { fm: Record<string, unknown>; body: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!m) return { fm: {}, body: text };
	let fm: unknown;
	try {
		fm = parseYaml(m[1]);
	} catch {
		fm = {};
	}
	return { fm: fm && typeof fm === "object" && !Array.isArray(fm) ? (fm as Record<string, unknown>) : {}, body: text.slice(m[0].length) };
}

function dateStr(v: unknown): string | undefined {
	if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
	if (typeof v === "string" && v.trim()) return v.trim();
	return undefined;
}

export interface ParsedNote {
	/** `id` is empty when the file has none (or an invalid one). */
	note: Note;
	/** Usefulness votes pi-dream kept in the file (wierd-memory keeps them in the state). */
	stats?: NoteStats;
	/** What the file lacks and a rewrite would add: an id, dates. */
	incomplete: boolean;
}

export function parseNote(content: string, scope: string, date: string): ParsedNote {
	const { fm, body: raw } = frontMatter(content);
	const body = raw.trim();
	const firstLine = body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() ?? "";
	const extra: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fm)) if (!KNOWN.has(k)) extra[k] = v;
	const st = (fm.stats && typeof fm.stats === "object" ? fm.stats : {}) as Record<string, unknown>;
	const stats = { helpful: typeof st.helpful === "number" ? st.helpful : 0, harmful: typeof st.harmful === "number" ? st.harmful : 0 };
	const created = dateStr(fm.created);
	const id = isNoteId(fm.id) ? fm.id : "";
	const note = makeNote(
		{
			id,
			scope,
			title: typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : firstLine || "(untitled)",
			type: oneOf(NOTE_TYPES, fm.type) ? fm.type : "fact",
			status: oneOf(NOTE_STATUSES, fm.status) ? fm.status : "active",
			index: oneOf(INDEX_MODES, fm.index) ? fm.index : "none",
			when: typeof fm.when === "string" && fm.when.trim() ? fm.when.trim() : undefined,
			body,
			pinned: fm.pinned === true,
			enabled: fm.enabled !== false,
			created: created ?? date,
			updated: dateStr(fm.updated) ?? created ?? date,
			confirmed: dateStr(fm.confirmed),
			validUntil: dateStr(fm.valid_until),
			supersededBy: typeof fm.superseded_by === "string" ? fm.superseded_by : undefined,
			supersedes: Array.isArray(fm.supersedes) ? fm.supersedes.filter((x): x is string => typeof x === "string") : [],
			evidence: parseEvidence(fm.evidence),
			extra,
		},
		date,
	);
	return { note, stats: stats.helpful || stats.harmful ? stats : undefined, incomplete: !id || !created };
}

export function renderNote(n: Note): string {
	return serializeNote(n);
}

/** `scopes/<scope>/notes/<name>.md` → the scope id; undefined for any other path. */
export function scopeOfPath(path: string): string | undefined {
	return /^scopes\/(global|projects\/[^/]+)\/notes\/[^/]+\.md$/.exec(path)?.[1];
}

export function noteFileName(title: string): string {
	return `${slugify(title)}.md`;
}

// ── skills ───────────────────────────────────────────────────────────────

/** `scopes/<scope>/skills/<name>/SKILL.md` → scope and name. */
export function skillOfPath(path: string): { scope: string; name: string } | undefined {
	const m = /^scopes\/(global|projects\/[^/]+)\/skills\/([^/]+)\/SKILL\.md$/.exec(path);
	return m ? { scope: m[1], name: m[2] } : undefined;
}

export function parseSkill(content: string, scope: string, name: string): SkillDraft {
	const { fm, body } = frontMatter(content);
	return { scope, name: typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : name, description: typeof fm.description === "string" ? fm.description : "", body: body.trim() };
}

export function renderSkill(s: SkillDraft): string {
	return `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body.trim()}\n`;
}
