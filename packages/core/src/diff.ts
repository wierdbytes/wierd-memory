/**
 * What a review branch changes in memory, and how to keep it in step with `main`.
 *
 * `diffNotes(base, head)` compares two sets of notes by id and names each
 * difference the way a reviewer thinks about it: a new note, an edit, a move
 * to another scope, a replacement (the new note and the one it supersedes are
 * one item), a closed note, a confirmation (new evidence only). Every row that
 * differs belongs to exactly one item, so accepting or rejecting every item
 * makes the two sets equal.
 *
 * `rebaseNotes(base, main, branch)` is a three-way merge by column: what
 * `main` changed since `base` is carried into the branch wherever the branch
 * did not change the same thing itself. The review branch is thus always
 * "main + what is still proposed".
 */

import { changedColumns, cloneNote, evidenceKey, type Evidence, type Note, NOTE_COLUMNS, type NoteColumn, columnValue, sameNote } from "./notes.ts";

export type DiffKind = "added" | "updated" | "moved" | "superseded" | "deprecated" | "removed" | "confirmed";

export interface NoteDiff {
	kind: DiffKind;
	/** The note as the head has it (removed: as the base had it). For superseded: the replacement. */
	note: Note;
	/** The base version: the note before the change; for superseded, the replaced note as it was. */
	before?: Note;
	/** Evidence the head added. */
	evidence: Evidence[];
	/** Columns that differ (updated, moved, confirmed, deprecated). */
	fields: NoteColumn[];
	/** Every note row this item covers (the note; for superseded also the replaced note). */
	ids: string[];
}

/** Columns that carry what a note says and how it reaches agents (the rest is bookkeeping). */
const CONTENT: NoteColumn[] = ["title", "body", "when", "index", "type", "status", "pinned", "enabled"];

export function diffNotes(base: readonly Note[], head: readonly Note[]): NoteDiff[] {
	const baseById = new Map(base.map((n) => [n.id, n]));
	const headById = new Map(head.map((n) => [n.id, n]));
	const addedEvidence = (n: Note, b?: Note) => {
		const seen = new Set((b?.evidence ?? []).map(evidenceKey));
		return n.evidence.filter((e) => !seen.has(evidenceKey(e)));
	};
	const out: NoteDiff[] = [];
	const covered = new Set<string>();

	// Replacements first: they take the replaced note's row with them.
	for (const n of head) {
		if (baseById.has(n.id) || n.status !== "active" || !n.supersedes.length) continue;
		const replaced = n.supersedes
			.map((id) => ({ b: baseById.get(id), h: headById.get(id) }))
			.find((x) => x.b?.status === "active" && x.h?.status === "superseded" && x.h.supersededBy === n.id);
		if (!replaced?.b) continue;
		out.push({ kind: "superseded", note: n, before: replaced.b, evidence: addedEvidence(n), fields: [], ids: [n.id, replaced.b.id] });
		covered.add(n.id);
		covered.add(replaced.b.id);
	}

	for (const n of head) {
		if (covered.has(n.id)) continue;
		const b = baseById.get(n.id);
		if (!b) {
			out.push({ kind: "added", note: n, evidence: addedEvidence(n), fields: [], ids: [n.id] });
			continue;
		}
		const fields = changedColumns(b, n);
		if (!fields.length) continue;
		const evidence = addedEvidence(n, b);
		let kind: DiffKind;
		if (b.status === "active" && n.status !== "active") kind = "deprecated";
		else if (n.scope !== b.scope) kind = "moved";
		else if (fields.some((f) => CONTENT.includes(f))) kind = "updated";
		else kind = "confirmed";
		out.push({ kind, note: n, before: b, evidence, fields, ids: [n.id] });
	}
	for (const b of base) if (!headById.has(b.id) && !covered.has(b.id)) out.push({ kind: "removed", note: b, before: b, evidence: [], fields: [], ids: [b.id] });
	return out;
}

/** Stable key of a review item. */
export function diffKey(d: Pick<NoteDiff, "note">): string {
	return `note:${d.note.id}`;
}

// ── three-way ────────────────────────────────────────────────────────────

/**
 * One note, three ways: `base` (what both sides started from), `ours` (the
 * side being updated) and `theirs` (the side whose changes are carried over).
 * Returns what `ours` becomes: `undefined` means the row is gone.
 *
 * Column by column, `theirs` wins where only it changed; where both changed,
 * `ours` stays. A row deleted on one side and edited on the other stays as
 * the editing side has it.
 */
export function mergeNote(base: Note | undefined, ours: Note | undefined, theirs: Note | undefined): Note | undefined {
	if (sameNote(base, theirs)) return ours; // theirs changed nothing
	if (sameNote(base, ours)) return theirs ? cloneNote(theirs) : undefined; // only theirs changed
	if (!ours) return undefined; // we deleted it, they edited it: our deletion stands as the proposal
	if (!theirs) return ours; // they deleted it, we edited it: our edit stands (it would re-add the note)
	if (!base) return ours; // both added the same id: ours stays
	const out = cloneNote(ours);
	for (const c of NOTE_COLUMNS) {
		if (columnValue(base, c) !== columnValue(ours, c)) continue; // we changed it: ours stays
		if (columnValue(base, c) === columnValue(theirs, c)) continue;
		(out as unknown as Record<string, unknown>)[c] = cloneNote(theirs)[c];
	}
	return out;
}

export interface Rebase {
	/** Rows to write on the branch. */
	upsert: Note[];
	/** Row ids to delete on the branch. */
	remove: string[];
}

/**
 * Carry what `main` changed since `base` into `branch`. `base` is `main` as
 * the branch last saw it.
 */
export function rebaseNotes(base: readonly Note[], main: readonly Note[], branch: readonly Note[]): Rebase {
	const b = new Map(base.map((n) => [n.id, n]));
	const m = new Map(main.map((n) => [n.id, n]));
	const br = new Map(branch.map((n) => [n.id, n]));
	const upsert: Note[] = [];
	const remove: string[] = [];
	for (const id of new Set([...b.keys(), ...m.keys()])) {
		const base1 = b.get(id);
		const main1 = m.get(id);
		if (sameNote(base1, main1)) continue;
		const cur = br.get(id);
		const next = mergeNote(base1, cur, main1);
		if (sameNote(cur, next)) continue;
		if (next) upsert.push(next);
		else remove.push(id);
	}
	return { upsert, remove };
}
