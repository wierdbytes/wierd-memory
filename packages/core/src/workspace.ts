/**
 * The curator's hands: operations proposed by a model are validated here and
 * applied by plain code to an in-memory copy of the notes — item by item,
 * never rewritten wholesale, so memory cannot "collapse" into a short generic
 * summary. What changed is then sent to the server, which writes it to the
 * dreams branch.
 *
 * Invariants: every note keeps its evidence; superseded and deprecated notes
 * stay with `validUntil`; near-duplicates are merged into the existing note;
 * text with credentials or prompt-injection patterns is refused; notes the
 * user turned off are left alone and are not proposed again.
 */

import { GLOBAL_SCOPE, projectScope } from "./layout.ts";
import { buildIndex, type IndexResult } from "./memindex.ts";
import {
	cloneNote,
	type Evidence,
	INDEX_MODES,
	isNoteId,
	makeNote,
	mergeEvidence,
	newNoteId,
	type Note,
	NOTE_TYPES,
	type NoteFields,
	oneOf,
	sameNote,
} from "./notes.ts";
import { tokenize } from "./search.ts";
import { findInjection, findSecrets } from "./secrets.ts";

export type OpKind = "add" | "update" | "supersede" | "deprecate" | "confirm" | "agents_md" | "skill";

export interface EvidenceRef {
	s: string;
	e: string[];
}

interface BaseOp {
	ref: string;
	rationale: string;
	evidence: EvidenceRef[];
}

export interface AddOp extends BaseOp, NoteFields {
	op: "add";
	/** `global`, `project` or an existing scope id. */
	scope: string;
	title: string;
}
export interface UpdateOp extends BaseOp, NoteFields {
	op: "update";
	id: string;
	/** Move the note: `global`, `project`, `project:<key>` or a scope id. */
	scope?: string;
}
export interface SupersedeOp extends BaseOp {
	op: "supersede";
	id: string;
	replacement: NoteFields & { title: string };
}
export interface DeprecateOp extends BaseOp {
	op: "deprecate";
	id: string;
}
export interface ConfirmOp extends BaseOp {
	op: "confirm";
	id: string;
}
export interface AgentsMdOp extends BaseOp {
	op: "agents_md";
	/** One line: what the edit changes. */
	summary?: string;
	edits: Array<{ old: string; new: string }>;
}
export interface SkillOp extends BaseOp {
	op: "skill";
	scope: string;
	name: string;
	description: string;
	body: string;
}

export type Op = AddOp | UpdateOp | SupersedeOp | DeprecateOp | ConfirmOp | AgentsMdOp | SkillOp;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function parseEvidenceRefs(v: unknown): EvidenceRef[] {
	if (!Array.isArray(v)) return [];
	const out: EvidenceRef[] = [];
	for (const item of v) {
		if (!isObj(item) || typeof item.s !== "string" || !item.s.trim()) continue;
		const e = Array.isArray(item.e) ? item.e : typeof item.e === "string" ? [item.e] : [];
		out.push({
			s: item.s.trim(),
			e: e.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().replace(/^\[|\]$/g, "")),
		});
	}
	return out;
}

function noteFields(o: Record<string, unknown>): NoteFields {
	return {
		type: oneOf(NOTE_TYPES, o.type) ? o.type : undefined,
		title: optStr(o.title),
		body: typeof o.body === "string" ? o.body.trim() : undefined,
		when: optStr(o.when),
		index: oneOf(INDEX_MODES, o.index) ? o.index : undefined,
	};
}

export interface ParsedOps {
	ops: Op[];
	problems: string[];
	unhandled: Array<{ comment: string; reason: string }>;
}

/** Validate a curator reply. Throws only when the shape is unusable (so the model is asked again). */
export function parseOps(raw: unknown): ParsedOps {
	if (!isObj(raw) || !Array.isArray(raw.ops)) throw new Error('expected an object {"ops": [...]}');
	const ops: Op[] = [];
	const problems: string[] = [];
	const refs = new Set<string>();
	raw.ops.forEach((item, i) => {
		if (!isObj(item)) return problems.push(`op ${i + 1}: not an object`);
		let ref = optStr(item.ref) ?? `op${i + 1}`;
		if (refs.has(ref)) ref = `${ref}-${i + 1}`;
		refs.add(ref);
		const base: BaseOp = { ref, rationale: optStr(item.rationale) ?? "", evidence: parseEvidenceRefs(item.evidence) };
		const id = optStr(item.id);
		const bad = (why: string) => problems.push(`${ref} (${String(item.op)}): ${why}`);
		switch (item.op) {
			case "add": {
				const f = noteFields(item);
				const scope = optStr(item.scope);
				if (!f.title) return bad("missing title");
				if (!scope) return bad("missing scope");
				ops.push({ ...base, op: "add", ...f, title: f.title, scope });
				return;
			}
			case "update":
				if (!isNoteId(id)) return bad("invalid id");
				ops.push({ ...base, op: "update", id, ...noteFields(item), scope: optStr(item.scope) });
				return;
			case "supersede": {
				if (!isNoteId(id)) return bad("invalid id");
				const r = isObj(item.replacement) ? noteFields(item.replacement) : {};
				if (!r.title) return bad("replacement needs a title");
				ops.push({ ...base, op: "supersede", id, replacement: { ...r, title: r.title } });
				return;
			}
			case "deprecate":
			case "confirm":
				if (!isNoteId(id)) return bad("invalid id");
				ops.push({ ...base, op: item.op, id });
				return;
			case "agents_md": {
				const edits = (Array.isArray(item.edits) ? item.edits : [])
					.filter(isObj)
					.filter((e) => typeof e.old === "string" && typeof e.new === "string")
					.map((e) => ({ old: e.old as string, new: e.new as string }));
				if (!edits.length) return bad("no edits");
				ops.push({ ...base, op: "agents_md", summary: optStr(item.summary)?.slice(0, 90), edits });
				return;
			}
			case "skill": {
				const name = optStr(item.name);
				const description = optStr(item.description);
				const body = optStr(item.body);
				const scope = optStr(item.scope) ?? "project";
				if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) return bad("invalid skill name");
				if (!description || !body) return bad("skill needs description and body");
				ops.push({ ...base, op: "skill", scope, name, description: description.slice(0, 1024), body });
				return;
			}
			default:
				bad("unknown op");
		}
	});
	const unhandled = (Array.isArray(raw.unhandled) ? raw.unhandled : [])
		.filter(isObj)
		.map((u) => ({ comment: String(u.comment ?? ""), reason: String(u.reason ?? "") }));
	return { ops, problems, unhandled };
}

/** Token-set Jaccard similarity of two titles. */
export function similarity(a: string, b: string): number {
	const A = new Set(tokenize(a));
	const B = new Set(tokenize(b));
	if (!A.size || !B.size) return 0;
	let inter = 0;
	for (const t of A) if (B.has(t)) inter++;
	return inter / (A.size + B.size - inter);
}

export const DUPLICATE_THRESHOLD = 0.72;
export const MAX_TITLE = 240;
export const MAX_BODY = 4000;

/** Problems that make text unacceptable as memory. */
export function lintText(text: string): string[] {
	const out: string[] = [];
	const secrets = findSecrets(text);
	if (secrets.length) out.push(`contains credentials (${secrets.join(", ")})`);
	const inj = findInjection(text);
	if (inj.length) out.push(`contains a prompt-injection phrase (${inj.join(", ")})`);
	return out;
}

export type ChangeKind = "added" | "merged" | "updated" | "moved" | "superseded" | "deprecated" | "removed" | "confirmed" | "skill";

export interface Change {
	kind: ChangeKind;
	ref: string;
	scope: string;
	noteId?: string;
	title: string;
	/** For superseded: the replacement's id. */
	newId?: string;
	/** For moved: the scope the note left. */
	from?: string;
	/** For updated: the title before, when it changed. */
	oldTitle?: string;
	note?: string;
}

export interface ScopeMeta {
	id: string;
	/** Project key (`github.com/o/r`, `local:/path`); absent for global. */
	key?: string;
	/** Project root on this machine. */
	root?: string;
}

export interface SkillDraft {
	scope: string;
	name: string;
	description: string;
	body: string;
}

export interface WorkspaceChanges {
	/** Notes written by this run, with the version the run started from (absent: new). */
	notes: Array<{ before?: Note; after: Note }>;
	/** Proposed notes dropped again (they were never approved). */
	removed: Note[];
	/** Project scopes that got their first note. */
	scopes: ScopeMeta[];
	skills: SkillDraft[];
}

export class Workspace {
	readonly notes = new Map<string, Note[]>();
	readonly ids = new Set<string>();
	/** Notes that exist only on the dreams branch (proposed, not approved yet). */
	readonly pending = new Set<string>();
	readonly skills = new Map<string, SkillDraft>();
	private original = new Map<string, Note>();
	private dirty = new Set<Note>();
	private gone = new Map<string, Note>();
	private metas = new Map<string, ScopeMeta>();
	private known = new Set<string>();

	constructor(
		notes: readonly Note[],
		readonly date: string,
		opts: { pending?: Iterable<string>; scopes?: Iterable<ScopeMeta> } = {},
	) {
		for (const n of notes) {
			const copy = cloneNote(n);
			this.scope(copy.scope).push(copy);
			this.ids.add(copy.id);
			this.original.set(copy.id, cloneNote(n));
		}
		for (const s of opts.scopes ?? []) {
			this.known.add(s.id);
			this.scope(s.id);
		}
		for (const id of opts.pending ?? []) this.pending.add(id);
		this.scope(GLOBAL_SCOPE);
	}

	scope(scope: string): Note[] {
		let list = this.notes.get(scope);
		if (!list) this.notes.set(scope, (list = []));
		return list;
	}

	/** Register a project scope; it is created on the server once it holds a note. */
	ensureScope(scope: string, meta?: { key?: string; root?: string }): void {
		this.scope(scope);
		if (meta && !this.known.has(scope)) this.metas.set(scope, { id: scope, ...meta });
	}

	all(): Note[] {
		return [...this.notes.values()].flat();
	}

	find(id: string): Note | undefined {
		for (const list of this.notes.values()) for (const n of list) if (n.id === id) return n;
		return undefined;
	}

	createNote(scope: string, f: NoteFields & { title: string }, evidence: Evidence[]): Note {
		const note = makeNote(
			{ id: newNoteId(this.ids), scope, title: f.title, type: f.type, index: f.index, when: f.when, body: f.body ?? "", evidence: [...evidence], stats: { helpful: 0, harmful: 0 } },
			this.date,
		);
		this.scope(scope).push(note);
		this.pending.add(note.id);
		this.dirty.add(note);
		return note;
	}

	touch(n: Note): void {
		this.dirty.add(n);
	}

	/** Move a note to another scope; id, evidence and history stay. */
	moveNote(n: Note, scope: string): void {
		const from = this.scope(n.scope);
		const i = from.indexOf(n);
		if (i >= 0) from.splice(i, 1);
		n.scope = scope;
		this.scope(scope).push(n);
		this.dirty.add(n);
	}

	/** Drop a note that was never approved (it only exists on the dreams branch). */
	removeNote(n: Note): void {
		const list = this.scope(n.scope);
		const i = list.indexOf(n);
		if (i >= 0) list.splice(i, 1);
		this.dirty.delete(n);
		this.pending.delete(n.id);
		const before = this.original.get(n.id);
		if (before) this.gone.set(n.id, before);
	}

	/** What this run changed, compared with what it started from. */
	changes(): WorkspaceChanges {
		const notes: WorkspaceChanges["notes"] = [];
		for (const n of this.dirty) {
			const before = this.original.get(n.id);
			if (before && sameNote(before, n)) continue;
			notes.push({ before, after: cloneNote(n) });
		}
		const scopes = [...this.metas.values()].filter((m) => this.scope(m.id).length > 0 || [...this.skills.values()].some((s) => s.scope === m.id));
		return { notes, removed: [...this.gone.values()], scopes, skills: [...this.skills.values()] };
	}
}

export interface ApplyContext {
	/** Scope id that "project" refers to in this pass. */
	projectScope?: string;
	evidence: Evidence[];
	/** Corrections from the fact checker. */
	fix?: { title?: string; body?: string; scope?: string };
}

export type ApplyResult = { ok: true; change: Change } | { ok: false; reason: string };

function cleanFields<T extends NoteFields>(f: T): T {
	const out = { ...f };
	if (out.title && out.title.length > MAX_TITLE) out.title = `${out.title.slice(0, MAX_TITLE - 1)}…`;
	if (out.body && out.body.length > MAX_BODY) out.body = `${out.body.slice(0, MAX_BODY - 1)}…`;
	return out;
}

/** `global` | `project` (this pass) | `project:<key>` | an existing scope id → scope id. */
export function resolveScope(ws: Workspace, scope: string, thisProject?: string): string | undefined {
	if (scope === "global") return GLOBAL_SCOPE;
	if (scope === "project") return thisProject;
	if (scope.startsWith("project:") && scope.length > 8) {
		const id = projectScope(scope.slice(8));
		ws.ensureScope(id, { key: scope.slice(8) });
		return id;
	}
	if (ws.notes.has(scope)) return scope;
	return undefined;
}

const OFF = (id: string) => `${id} was turned off by the user`;

export function applyOp(ws: Workspace, op: Op, actx: ApplyContext): ApplyResult {
	const fix = actx.fix ?? {};
	const ev = actx.evidence;
	switch (op.op) {
		case "add": {
			const scope = resolveScope(ws, fix.scope ?? op.scope, actx.projectScope);
			if (!scope) return { ok: false, reason: `unknown scope ${fix.scope ?? op.scope}` };
			const f = cleanFields({ ...op, title: fix.title ?? op.title, body: fix.body ?? op.body });
			const problems = lintText(`${f.title}\n${f.body ?? ""}\n${f.when ?? ""}`);
			if (problems.length) return { ok: false, reason: problems.join("; ") };
			const dup = ws
				.scope(scope)
				.filter((n) => n.status === "active")
				.map((n) => ({ n, s: similarity(n.title, f.title) }))
				.sort((a, b) => b.s - a.s)[0];
			if (dup && dup.s >= DUPLICATE_THRESHOLD) {
				if (!dup.n.enabled) return { ok: false, reason: `duplicate of ${dup.n.id}, which the user turned off` };
				const added = mergeEvidence(dup.n.evidence, ev);
				if (added) {
					dup.n.confirmed = ws.date;
					ws.touch(dup.n);
				}
				return { ok: true, change: { kind: "merged", ref: op.ref, scope, noteId: dup.n.id, title: dup.n.title, note: `duplicate of ${dup.n.id}` } };
			}
			const note = ws.createNote(scope, f, ev);
			return { ok: true, change: { kind: "added", ref: op.ref, scope, noteId: note.id, title: note.title } };
		}
		case "update": {
			const n = ws.find(op.id);
			if (!n) return { ok: false, reason: `no note ${op.id}` };
			if (!n.enabled) return { ok: false, reason: OFF(op.id) };
			const f = cleanFields({ ...op, title: fix.title ?? op.title, body: fix.body ?? op.body });
			const problems = lintText(`${f.title ?? ""}\n${f.body ?? ""}\n${f.when ?? ""}`);
			if (problems.length) return { ok: false, reason: problems.join("; ") };
			const target = fix.scope ?? op.scope;
			const to = target ? resolveScope(ws, target, actx.projectScope) : undefined;
			if (target && !to) return { ok: false, reason: `unknown scope ${target}` };
			const oldTitle = f.title && f.title !== n.title ? n.title : undefined;
			if (f.title) n.title = f.title;
			if (f.body !== undefined) n.body = f.body;
			if (f.when) n.when = f.when;
			if (f.index) n.index = f.index;
			if (f.type) n.type = f.type;
			mergeEvidence(n.evidence, ev);
			n.updated = ws.date;
			ws.touch(n);
			const from = n.scope;
			if (to && to !== n.scope) ws.moveNote(n, to);
			const moved = n.scope !== from;
			return {
				ok: true,
				change: { kind: moved ? "moved" : "updated", ref: op.ref, scope: n.scope, noteId: n.id, title: n.title, from: moved ? from : undefined, oldTitle },
			};
		}
		case "supersede": {
			const old = ws.find(op.id);
			if (!old) return { ok: false, reason: `no note ${op.id}` };
			if (!old.enabled) return { ok: false, reason: OFF(op.id) };
			if (old.status !== "active") return { ok: false, reason: `${op.id} is already ${old.status}` };
			const f = cleanFields({ ...op.replacement, title: fix.title ?? op.replacement.title, body: fix.body ?? op.replacement.body });
			const problems = lintText(`${f.title}\n${f.body ?? ""}`);
			if (problems.length) return { ok: false, reason: problems.join("; ") };
			if (ws.pending.has(old.id)) {
				// Never approved: there is no history to keep, the pending note simply changes.
				const oldTitle = old.title !== f.title ? old.title : undefined;
				old.title = f.title;
				if (f.body !== undefined) old.body = f.body;
				if (f.when) old.when = f.when;
				if (f.index) old.index = f.index;
				if (f.type) old.type = f.type;
				mergeEvidence(old.evidence, ev);
				old.updated = ws.date;
				ws.touch(old);
				return { ok: true, change: { kind: "updated", ref: op.ref, scope: old.scope, noteId: old.id, title: old.title, oldTitle } };
			}
			const repl = ws.createNote(old.scope, { type: old.type, index: old.index, when: old.when, ...f }, ev);
			repl.supersedes = [old.id];
			old.status = "superseded";
			old.validUntil = ws.date;
			old.supersededBy = repl.id;
			old.updated = ws.date;
			ws.touch(old);
			return { ok: true, change: { kind: "superseded", ref: op.ref, scope: old.scope, noteId: old.id, newId: repl.id, title: repl.title } };
		}
		case "deprecate": {
			const n = ws.find(op.id);
			if (!n) return { ok: false, reason: `no note ${op.id}` };
			if (ws.pending.has(n.id)) {
				ws.removeNote(n);
				return { ok: true, change: { kind: "removed", ref: op.ref, scope: n.scope, noteId: n.id, title: n.title } };
			}
			if (!n.enabled) return { ok: false, reason: OFF(op.id) };
			if (n.pinned) return { ok: false, reason: `${op.id} is pinned` };
			if (n.status !== "active") return { ok: false, reason: `${op.id} is already ${n.status}` };
			n.status = "deprecated";
			n.validUntil = ws.date;
			n.updated = ws.date;
			mergeEvidence(n.evidence, ev);
			ws.touch(n);
			return { ok: true, change: { kind: "deprecated", ref: op.ref, scope: n.scope, noteId: n.id, title: n.title } };
		}
		case "confirm": {
			const n = ws.find(op.id);
			if (!n) return { ok: false, reason: `no note ${op.id}` };
			if (!n.enabled) return { ok: false, reason: OFF(op.id) };
			const added = mergeEvidence(n.evidence, ev);
			if (!added) return { ok: false, reason: "no new evidence" };
			n.confirmed = ws.date;
			ws.touch(n);
			return { ok: true, change: { kind: "confirmed", ref: op.ref, scope: n.scope, noteId: n.id, title: n.title } };
		}
		case "skill": {
			const scope = resolveScope(ws, op.scope, actx.projectScope);
			if (!scope) return { ok: false, reason: `unknown scope ${op.scope}` };
			const problems = lintText(`${op.description}\n${op.body}`);
			if (problems.length) return { ok: false, reason: problems.join("; ") };
			ws.skills.set(`${scope}/${op.name}`, { scope, name: op.name, description: op.description, body: op.body.trim() });
			return { ok: true, change: { kind: "skill", ref: op.ref, scope, title: `${op.name}: ${op.description}` } };
		}
		case "agents_md":
			return { ok: false, reason: "agents_md is proposed separately" };
	}
}

/** Tally helpful / harmful votes from session cards on existing notes; returns what to add per note. */
export function applyVotes(ws: Workspace, votes: Array<{ id: string; effect: string }>): Record<string, { helpful: number; harmful: number }> {
	const out: Record<string, { helpful: number; harmful: number }> = {};
	for (const v of votes) {
		const note = ws.find(v.id);
		if (!note) continue;
		const delta = (out[v.id] ??= { helpful: 0, harmful: 0 });
		note.stats ??= { helpful: 0, harmful: 0 };
		if (v.effect === "helpful") {
			delta.helpful++;
			note.stats.helpful++;
		} else if (v.effect === "harmful" || v.effect === "stale") {
			delta.harmful++;
			note.stats.harmful++;
		}
	}
	for (const [id, d] of Object.entries(out)) if (!d.helpful && !d.harmful) delete out[id];
	return out;
}

export interface IndexStat extends Omit<IndexResult, "text" | "body"> {
	scope: string;
	budget: number;
}

/** What each scope's index would hold with these notes (for the report: what loads, what is over budget). */
export function indexStats(notes: ReadonlyMap<string, readonly Note[]>, budgets: { globalTokens: number; projectTokens: number }): IndexStat[] {
	const out: IndexStat[] = [];
	for (const [scope, list] of notes) {
		if (!list.length) continue;
		const budget = scope === GLOBAL_SCOPE ? budgets.globalTokens : budgets.projectTokens;
		const res = buildIndex(list, scope, budget);
		out.push({ scope, budget, tokens: res.tokens, included: res.included, dropped: res.dropped });
	}
	return out;
}
