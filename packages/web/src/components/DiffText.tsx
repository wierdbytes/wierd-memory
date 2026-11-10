/**
 * Diffs of note text: word-level for one-line fields, line-level (with the
 * changed words marked) for bodies, and "what changed" for whole notes.
 */

import type { Evidence, IndexMode, Note } from "@wierd-memory/core";
import { type Change, diffLines, diffWordsWithSpace } from "diff";
import { memo, type ReactNode, useMemo } from "react";
import { cls, INDEX_LABEL, plural } from "../util.ts";

/** Inline word diff: removed words struck through, added ones marked. */
export const WordDiff = memo(function WordDiff({ before, after, className }: { before: string; after: string; className?: string }) {
	const parts = useMemo(() => diffWordsWithSpace(before, after), [before, after]);
	return (
		<span className={cls("diff-words", className)}>
			{parts.map((p, i) =>
				p.added ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: static list
					<ins key={i}>{p.value}</ins>
				) : p.removed ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: static list
					<del key={i}>{p.value}</del>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: static list
					<span key={i}>{p.value}</span>
				),
			)}
		</span>
	);
});

interface Seg {
	text: string;
	hot: boolean;
}

interface Row {
	type: "ctx" | "del" | "add" | "gap";
	segs: Seg[];
}

const lines = (s: string) => {
	const out = s.split("\n");
	if (out.length > 1 && out[out.length - 1] === "") out.pop();
	return out;
};

/** One side of a word diff, cut into lines. */
function sideRows(changes: Change[], side: "del" | "add"): Row[] {
	const rows: Row[] = [{ type: side, segs: [] }];
	for (const c of changes) {
		if (side === "del" ? c.added : c.removed) continue;
		const hot = side === "del" ? !!c.removed : !!c.added;
		const chunks = c.value.split("\n");
		chunks.forEach((chunk, i) => {
			if (i > 0) rows.push({ type: side, segs: [] });
			if (chunk) rows[rows.length - 1].segs.push({ text: chunk, hot });
		});
	}
	return rows;
}

function buildRows(before: string, after: string, context: number): Row[] {
	const norm = (s: string) => (s.endsWith("\n") || !s ? s : `${s}\n`);
	const parts = diffLines(norm(before), norm(after));
	const rows: Row[] = [];
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		const next = parts[i + 1];
		if (p.removed && next?.added) {
			const a = p.value.replace(/\n$/, "");
			const b = next.value.replace(/\n$/, "");
			const words = diffWordsWithSpace(a, b);
			// When nearly everything differs, marking words is noise: show whole lines.
			const same = words.filter((w) => !w.added && !w.removed).reduce((n, w) => n + w.value.trim().length, 0);
			const fine = same >= Math.min(a.length, b.length) * 0.3;
			if (fine) rows.push(...sideRows(words, "del"), ...sideRows(words, "add"));
			else rows.push(...lines(p.value).map((t): Row => ({ type: "del", segs: [{ text: t, hot: false }] })), ...lines(next.value).map((t): Row => ({ type: "add", segs: [{ text: t, hot: false }] })));
			i++;
			continue;
		}
		const type: Row["type"] = p.added ? "add" : p.removed ? "del" : "ctx";
		for (const t of lines(p.value)) rows.push({ type, segs: [{ text: t, hot: false }] });
	}
	// Fold long unchanged runs.
	const keep = rows.map(() => false);
	rows.forEach((r, i) => {
		if (r.type === "ctx") return;
		for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
	});
	const out: Row[] = [];
	let skipped = 0;
	rows.forEach((r, i) => {
		if (keep[i]) {
			if (skipped) out.push({ type: "gap", segs: [{ text: `${plural(skipped, "unchanged line")}`, hot: false }] });
			skipped = 0;
			out.push(r);
		} else skipped++;
	});
	if (skipped && out.length) out.push({ type: "gap", segs: [{ text: `${plural(skipped, "unchanged line")}`, hot: false }] });
	return out;
}

const SIGN: Record<Row["type"], string> = { ctx: " ", del: "−", add: "+", gap: "⋯" };

/** Line diff of a longer text; inside a changed line the changed words are marked. */
export const LineDiff = memo(function LineDiff({ before, after, context = 2 }: { before: string; after: string; context?: number }) {
	const rows = useMemo(() => buildRows(before, after, context), [before, after, context]);
	if (!rows.length) return <div className="diff-lines diff-same">no changes</div>;
	return (
		<div className="diff-lines">
			{rows.map((r, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static list
				<div key={i} className={cls("diff-row", `diff-${r.type}`)}>
					<span className="diff-sign">{SIGN[r.type]}</span>
					<span className="diff-text">
						{r.segs.length
							? r.segs.map((s, k) =>
									s.hot ? (
										// biome-ignore lint/suspicious/noArrayIndexKey: static list
										<mark key={k}>{s.text}</mark>
									) : (
										// biome-ignore lint/suspicious/noArrayIndexKey: static list
										<span key={k}>{s.text}</span>
									),
								)
							: "\u00a0"}
					</span>
				</div>
			))}
		</div>
	);
});

// ── what changed in a note ───────────────────────────────────────────────

const FIELD_LABEL: Record<string, string> = {
	title: "Title",
	when: "When it applies",
	body: "Text",
	index: "Reaches agents",
	type: "Type",
	scope: "Scope",
	status: "Status",
	pinned: "Pinned",
	enabled: "Turned on",
	validUntil: "Valid until",
	supersededBy: "Superseded by",
	supersedes: "Supersedes",
	evidence: "Evidence",
	confirmed: "Confirmed",
	updated: "Updated",
	created: "Created",
	extra: "Extra",
};

/** Dates that move with every change: listed, not shown as changes of their own. */
const BOOKKEEPING = new Set(["updated", "confirmed", "created"]);

/** Column order for diffs. */
const ORDER = ["scope", "title", "when", "body", "index", "type", "status", "enabled", "pinned", "validUntil", "supersededBy", "supersedes", "evidence", "extra", "created", "updated", "confirmed"];

const isBlank = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

function evidenceKey(e: Evidence): string {
	return `${e.s}|${[...e.e].sort().join(",")}`;
}

function evidenceSummary(before: unknown, after: unknown): string {
	const a = Array.isArray(before) ? (before as Evidence[]) : [];
	const b = Array.isArray(after) ? (after as Evidence[]) : [];
	const had = new Set(a.map(evidenceKey));
	const has = new Set(b.map(evidenceKey));
	const added = b.filter((e) => !had.has(evidenceKey(e))).length;
	const removed = a.filter((e) => !has.has(evidenceKey(e))).length;
	const parts = [added ? `+${added}` : "", removed ? `−${removed}` : ""].filter(Boolean).join(" ");
	return `${parts || "reordered"} · ${plural(b.length, "source")} now`;
}

function show(field: string, v: unknown, scopeName?: (id: string) => string): string {
	if (isBlank(v)) return "—";
	if (field === "scope" && typeof v === "string") return scopeName?.(v) ?? v;
	if (field === "index" && typeof v === "string") return INDEX_LABEL[v as IndexMode] ?? v;
	if (typeof v === "boolean") return v ? "yes" : "no";
	if (typeof v === "string" || typeof v === "number") return String(v);
	if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(", ");
	return JSON.stringify(v);
}

/** One changed field: a text diff for text, `before → after` for the rest. */
export function FieldChange({ field, before, after, scopeName }: { field: string; before: unknown; after: unknown; scopeName?: (id: string) => string }) {
	const label = FIELD_LABEL[field] ?? field;
	let body: ReactNode;
	const a = typeof before === "string" ? before : "";
	const b = typeof after === "string" ? after : "";
	if (field === "body") body = <LineDiff before={a} after={b} />;
	else if (field === "title" || field === "when") body = <WordDiff before={a} after={b} className={cls("diff-inline", field === "title" && "diff-title")} />;
	else if (field === "evidence") body = <span className="change-plain">{evidenceSummary(before, after)}</span>;
	else
		body = (
			<span className="change-plain">
				<del>{show(field, before, scopeName)}</del>
				<span className="arrow">→</span>
				<ins>{show(field, after, scopeName)}</ins>
			</span>
		);
	return (
		<div className={cls("change", `change-${field}`)}>
			<div className="change-label">{label}</div>
			<div className="change-body">{body}</div>
		</div>
	);
}

export type ChangePairs = Record<string, [unknown, unknown] | undefined>;

/** Every changed field of a note, text first; date bookkeeping goes into one dim line. */
export function Changes({ pairs, scopeName, skip }: { pairs: ChangePairs; scopeName?: (id: string) => string; skip?: readonly string[] }) {
	const fields = Object.keys(pairs)
		.filter((f) => pairs[f] && !skip?.includes(f))
		.sort((x, y) => (ORDER.indexOf(x) + 100) % 100 - (ORDER.indexOf(y) + 100) % 100);
	const main = fields.filter((f) => !BOOKKEEPING.has(f));
	const dates = fields.filter((f) => BOOKKEEPING.has(f));
	return (
		<div className="changes">
			{main.map((f) => {
				const [before, after] = pairs[f] as [unknown, unknown];
				return <FieldChange key={f} field={f} before={before} after={after} scopeName={scopeName} />;
			})}
			{dates.length ? (
				<div className="change-dates">
					{dates
						.map((f) => {
							const [, after] = pairs[f] as [unknown, unknown];
							return `${(FIELD_LABEL[f] ?? f).toLowerCase()} ${show(f, after)}`;
						})
						.join(" · ")}
				</div>
			) : !main.length ? (
				<div className="change-dates">no visible changes</div>
			) : null}
		</div>
	);
}

const COLUMNS: ReadonlyArray<keyof Note> = ["scope", "title", "type", "status", "index", "when", "body", "pinned", "enabled", "created", "updated", "confirmed", "validUntil", "supersededBy", "supersedes", "evidence", "extra"];

const comparable = (v: unknown): string => (isBlank(v) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) ? "null" : JSON.stringify(typeof v === "string" ? v.trim() : v));

/** The fields two versions of a note differ in, as `[before, after]` pairs (optionally only `fields`). */
export function notePairs(before: Note | undefined, after: Note | undefined, fields?: readonly string[]): ChangePairs {
	const out: ChangePairs = {};
	for (const c of COLUMNS) {
		if (fields && !fields.includes(c)) continue;
		const a: unknown = before?.[c];
		const b: unknown = after?.[c];
		if (comparable(a) !== comparable(b)) out[c] = [a, b];
	}
	return out;
}
