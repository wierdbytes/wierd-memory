/**
 * What a dream reports: the changes it proposed (with the rationale, the fact
 * check and the evidence behind each), what the fact check rejected, the
 * sessions it read and what it cost. The server stores it with the run; the
 * review joins it to the notes the review branch changes.
 */

import type { Stage } from "./config.ts";
import type { IndexMode, Evidence } from "./notes.ts";
import type { ChangeKind, IndexStat } from "./workspace.ts";

export interface StageUsage {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
	failures: number;
}

export interface ReportSession {
	sessionId: string;
	date: string;
	project: string;
	title: string;
	outcome: string;
	learnings: number;
}

/** One change to memory, as a dream made it. */
export interface ReportItem {
	kind: ChangeKind;
	/** Scope id: `global` or `projects/<dir>`. */
	scope: string;
	/** Note id; for a replacement, the new note. */
	id?: string;
	title: string;
	body?: string;
	index?: IndexMode;
	when?: string;
	/** superseded: the replaced note; updated: the title before, when it changed. */
	old?: { id?: string; title: string };
	/** moved: the scope the note came from. */
	from?: string;
	/** Evidence behind this change. */
	evidence: Evidence[];
	/** Why the curator (or a review comment) wants it. */
	why: string[];
	/** The fact check of the change. */
	check?: { verdict: string; reason: string; corrected: boolean };
	/** Made on a review comment. */
	reviewer?: boolean;
	/** Risky content found in the note (`pipe-to-shell`…). */
	risky: string[];
	/** supersede / deprecate: evidence of the old note newer than this change's. */
	newerEvidence?: Evidence[];
	/** Other remarks (moved out of global…). */
	note?: string;
}

export interface ReportRejected {
	ref: string;
	op: string;
	title: string;
	reason: string;
}

export interface ReportAgents {
	project: string;
	rel: string;
	/** What the proposal changes. */
	title?: string;
	error?: string;
	patch: string;
	rationale: string[];
}

export interface ReportData {
	runId: string;
	date: string;
	language: string;
	models: Record<Stage, string>;
	usage: Partial<Record<Stage, StageUsage>>;
	sessions: ReportSession[];
	sessionTitles: Record<string, string>;
	inbox: number;
	/** Review comments this dream read. */
	feedback: number;
	unhandled: Array<{ comment: string; reason: string }>;
	items: ReportItem[];
	rejected: ReportRejected[];
	agents: ReportAgents[];
	indexes: IndexStat[];
	votes: number;
	problems: string[];
	/** Scope id → project key. */
	scopeTitles: Record<string, string>;
}

export function totalCost(usage: ReportData["usage"]): number {
	return Object.values(usage).reduce((s, u) => s + (u?.cost ?? 0), 0);
}

type Countable = { kind: string };

/** `+33 ~2 ⇄1 −1 ✓1 skills 1 AGENTS.md 1` */
export function countsLabel(items: readonly Countable[], agents = 0): string {
	const c = (...kinds: string[]) => items.filter((x) => kinds.includes(x.kind)).length;
	const parts = [
		c("added") && `+${c("added")}`,
		c("updated", "moved") && `~${c("updated", "moved")}`,
		c("superseded") && `⇄${c("superseded")}`,
		c("deprecated", "removed") && `−${c("deprecated", "removed")}`,
		c("confirmed", "merged") && `✓${c("confirmed", "merged")}`,
		c("skill") && `skills ${c("skill")}`,
		agents && `AGENTS.md ${agents}`,
	].filter(Boolean);
	return parts.join(" ");
}

/** `dream 2026-11-08: +33 ~2 ✓1 AGENTS.md 1` */
export function runTitle(d: Pick<ReportData, "items" | "agents" | "date">): string {
	return `dream ${d.date}: ${countsLabel(d.items, d.agents.length) || "no changes"}`;
}

function money(n: number): string {
	return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

const ICON: Record<string, string> = { added: "+", updated: "~", moved: "→", superseded: "⇄", deprecated: "−", removed: "✖", confirmed: "✓", merged: "✓", skill: "§" };

/** A dream's report as plain Markdown (for the CLI and for reading in a terminal). */
export function renderReport(d: ReportData): string {
	const out: string[] = [`# ${runTitle(d)}`, "", `run ${d.runId} · sessions ${d.sessions.length} · inbox ${d.inbox} · review comments ${d.feedback} · ${money(totalCost(d.usage))}`, ""];
	const byScope = new Map<string, ReportItem[]>();
	for (const it of d.items) {
		const list = byScope.get(it.scope) ?? [];
		list.push(it);
		byScope.set(it.scope, list);
	}
	for (const [scope, items] of byScope) {
		out.push(`## ${d.scopeTitles[scope] ?? scope}`, "");
		for (const it of items) {
			out.push(`- ${ICON[it.kind] ?? it.kind} **${it.title}**${it.id ? ` \`${it.id}\`` : ""}${it.index && it.index !== "none" ? ` _(${it.index})_` : ""}`);
			if (it.old) out.push(`  - was: ${it.old.title}${it.old.id ? ` \`${it.old.id}\`` : ""}`);
			for (const w of it.why) out.push(`  - why: ${w}`);
			if (it.check) out.push(`  - check: ${it.check.verdict}${it.check.corrected ? " (corrected)" : ""}${it.check.reason ? ` — ${it.check.reason}` : ""}`);
			for (const r of it.risky) out.push(`  - ⚠ ${r}`);
			if (it.newerEvidence?.length) out.push("  - ⚠ the old note has evidence newer than this change");
			if (it.note) out.push(`  - ${it.note}`);
		}
		out.push("");
	}
	if (d.agents.length) {
		out.push("## AGENTS.md / CLAUDE.md", "");
		for (const a of d.agents) out.push(`- ${a.project} \`${a.rel}\`${a.title ? ` — ${a.title}` : ""}${a.error ? ` (${a.error})` : ""}`);
		out.push("");
	}
	if (d.rejected.length) {
		out.push("## Rejected by the fact check", "");
		for (const r of d.rejected) out.push(`- ${r.op} "${r.title}" — ${r.reason}`);
		out.push("");
	}
	if (d.sessions.length) {
		out.push("## Sessions", "");
		for (const s of d.sessions) out.push(`- ${s.date} ${s.project} — ${s.title} \`${s.sessionId.slice(0, 8)}\` (${s.outcome}, ${s.learnings} learnings)`);
		out.push("");
	}
	const usage = (Object.entries(d.usage) as Array<[Stage, StageUsage]>).map(([stage, u]) => `${stage} ${money(u.cost)} (${u.calls}×)`).join(", ");
	out.push(`models: cards \`${d.models.cards}\`, curator \`${d.models.analyze}\`, check \`${d.models.verify}\``);
	if (usage) out.push(`cost: ${usage}`);
	if (d.problems.length) out.push("", "diagnostics:", ...d.problems.map((p) => `- ${p}`));
	return `${out.join("\n")}\n`;
}
