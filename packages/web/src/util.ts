/**
 * Small helpers and the constants the UI shares with `@wierd-mem/core`
 * (copied: the core package's runtime code must not reach the browser bundle).
 */

import type { IndexMode, InboxKind, ItemKind, NoteType, Reach, ThinkingLevel, Stage } from "@wierd-mem/core";

export const NOTE_TYPES: readonly NoteType[] = ["preference", "procedure", "pitfall", "fact", "decision", "reference"];
export const INDEX_MODES: readonly IndexMode[] = ["always", "pointer", "none"];
export const INBOX_KINDS: readonly InboxKind[] = ["preference", "procedure", "pitfall", "fact", "decision", "reference", "other"];
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
export const STAGES: readonly Stage[] = ["cards", "analyze", "verify"];
export const GLOBAL_SCOPE = "global";

export const REACH: Record<Reach, { glyph: string; label: string; hint: string }> = {
	always: { glyph: "●", label: "always in context", hint: "The title is in the context of every session of this scope." },
	pointer: { glyph: "○", label: "when relevant", hint: "A “when → id” line is in context; the agent opens the note when the situation matches." },
	none: { glyph: "·", label: "search only", hint: "Not in context: found through memory_search only." },
	over: { glyph: "!", label: "over budget", hint: "Meant for the index but does not fit the token budget: search only for now." },
	off: { glyph: "⊘", label: "off", hint: "Turned off: agents do not get it, dreams leave it alone." },
	archived: { glyph: "—", label: "archived", hint: "Superseded or closed." },
};

export const INDEX_LABEL: Record<IndexMode, string> = {
	always: "always in context",
	pointer: "when relevant",
	none: "search only",
};

export const KIND: Record<ItemKind, { glyph: string; label: string; tone: string }> = {
	added: { glyph: "+", label: "New note", tone: "green" },
	updated: { glyph: "~", label: "Edit", tone: "blue" },
	moved: { glyph: "→", label: "Move", tone: "purple" },
	superseded: { glyph: "⇄", label: "Replacement", tone: "yellow" },
	deprecated: { glyph: "−", label: "Close", tone: "red" },
	removed: { glyph: "✕", label: "Delete", tone: "red" },
	confirmed: { glyph: "✓", label: "Confirmation", tone: "dim" },
	skill: { glyph: "§", label: "Skill", tone: "purple" },
};

export function kindInfo(kind: string): { glyph: string; label: string; tone: string } {
	// `merged` is a dream report's word for evidence added to a note that is already proposed.
	if (kind === "merged") return { glyph: "✓", label: "Merged", tone: "dim" };
	return (KIND as Record<string, { glyph: string; label: string; tone: string }>)[kind] ?? { glyph: "•", label: kind, tone: "dim" };
}

/** A readable name for a scope id when the server gave none: `projects/github.com__o__repo` → `repo`. */
export function scopeLabel(id: string): string {
	if (id === GLOBAL_SCOPE) return "Global";
	const parts = id.replace(/^projects\//, "").split("__").filter(Boolean);
	return parts[parts.length - 1] ?? id;
}

export const EVIDENCE_KIND: Record<string, string> = {
	user: "the user's own words",
	observed: "observed in the session",
	inbox: "from the inbox",
	reviewer: "a review comment",
	manual: "a hand edit",
};

export function cls(...parts: Array<string | false | null | undefined>): string {
	return parts.filter(Boolean).join(" ");
}

export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

export function clip(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

export function firstLine(s: string): string {
	const i = s.indexOf("\n");
	return i < 0 ? s : s.slice(0, i);
}

export function money(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n)) return "";
	return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

function parse(iso: string | undefined | null): number | undefined {
	if (!iso) return undefined;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : undefined;
}

/** `just now`, `5m ago`, `5h ago`, `3d ago`, then the date. */
export function ago(iso: string | undefined | null, now = Date.now()): string {
	const t = parse(iso);
	if (t === undefined) return "";
	const s = Math.round((now - t) / 1000);
	// A little into the future is clock skew (or a `now` taken a moment earlier), not a date.
	if (s < -300) return fmtDateTime(iso);
	if (s < 45) return "just now";
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
	return fmtDay(iso);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `2026-11-09 23:25` in local time. */
export function fmtDateTime(iso: string | undefined | null): string {
	const t = parse(iso);
	if (t === undefined) return iso ?? "";
	const d = new Date(t);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `2026-11-09`; a plain day (`2026-11-09`) is passed through untouched. */
export function fmtDay(iso: string | undefined | null): string {
	if (!iso) return "";
	if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
	const t = parse(iso);
	if (t === undefined) return iso;
	const d = new Date(t);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `42s`, `3m 05s`, `1h 12m`. */
export function duration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
	return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

export function runDuration(run: { startedAt: string; finishedAt?: string }, now = Date.now()): string {
	const a = parse(run.startedAt);
	if (a === undefined) return "";
	const b = parse(run.finishedAt) ?? now;
	return duration(b - a);
}

export function errorText(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/** Is the event's target a place where the user types? */
export function isTyping(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

/** The due check in words. The server caches it for a minute, so right after the schedule is switched it can still say the opposite. */
export function dueText(due: { due: boolean; reason: string; sessions: number; inbox: number }, scheduled: boolean): { text: string; due: boolean } {
	const waiting = `Waiting: ${plural(due.sessions, "new session")}, ${plural(due.inbox, "inbox item")}.`;
	if (!scheduled) return { due: false, text: `The schedule is off: dreams start only by hand. ${waiting}` };
	if (/schedule disabled/i.test(due.reason)) return { due: false, text: `The schedule is on; the server re-checks whether a dream is due within a minute. ${waiting}` };
	return { due: due.due, text: `${due.due ? "A dream is due" : "No dream is due yet"}: ${due.reason}. ${waiting}` };
}
