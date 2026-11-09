/**
 * Import of a pi-dream memory repository (`~/.pi/memory`): the notes, scopes,
 * charters, skills and prompt overrides of its checked-out branch become one
 * commit on `main`; its local state (which sessions were read, the inbox,
 * rejected titles, past dreams) goes to the state database; session digests
 * and cards are copied so that search works at once and the first dream does
 * not redo them. pi-dream's settings become wierd-mem's.
 *
 * Nothing is changed in the source. Running it again needs `overwrite`
 * (the source wins for every note it has) and optionally `prune` (notes the
 * source does not have are deleted).
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_GLOBAL_CHARTER,
	DEFAULT_PROJECT_CHARTER,
	defaultPrompt,
	expandHome,
	GLOBAL_SCOPE,
	INDEX_MODES,
	type InboxItem,
	isNoteId,
	makeNote,
	newNoteId,
	type Note,
	NOTE_STATUSES,
	NOTE_TYPES,
	oneOf,
	parseEvidence,
	piAgentDir,
	PROMPT_NAMES,
	type ReportData,
	saveConfig,
	sanitize,
	type SessionMark,
	today,
} from "@wierd-mem/core";
import { parse as parseYaml } from "yaml";
import { type App, bad, HttpError } from "./app.ts";
import { MAIN } from "./dolt.ts";

export interface ImportOptions {
	from?: string;
	overwrite?: boolean;
	prune?: boolean;
	actor?: string;
}

export interface ImportResult {
	from: string;
	notes: number;
	scopes: number;
	skills: number;
	prompts: number;
	sessions: number;
	inbox: number;
	rejected: number;
	runs: number;
	digests: boolean;
	settings: boolean;
	pruned: number;
	warnings: string[];
	commit: string | null;
}

const KNOWN = new Set(["id", "title", "type", "status", "index", "when", "pinned", "enabled", "created", "updated", "confirmed", "valid_until", "superseded_by", "supersedes", "stats", "evidence"]);

function frontMatter(text: string): { fm: Record<string, unknown>; body: string } {
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

/** A pi-dream note file → a note (and its usefulness votes). */
export function parseNoteFile(content: string, scope: string, taken: Set<string>, date = today()): Note {
	const { fm, body: raw } = frontMatter(content);
	const body = raw.trim();
	const firstLine = body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() ?? "";
	const extra: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fm)) if (!KNOWN.has(k)) extra[k] = v;
	const stats = (fm.stats && typeof fm.stats === "object" ? fm.stats : {}) as Record<string, unknown>;
	const created = dateStr(fm.created) ?? date;
	let id = isNoteId(fm.id) ? fm.id : "";
	if (!id) id = newNoteId(taken);
	taken.add(id);
	return makeNote(
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
			created,
			updated: dateStr(fm.updated) ?? created,
			confirmed: dateStr(fm.confirmed),
			validUntil: dateStr(fm.valid_until),
			supersededBy: typeof fm.superseded_by === "string" ? fm.superseded_by : undefined,
			supersedes: Array.isArray(fm.supersedes) ? fm.supersedes.filter((x): x is string => typeof x === "string") : [],
			evidence: parseEvidence(fm.evidence),
			extra,
			stats: { helpful: typeof stats.helpful === "number" ? stats.helpful : 0, harmful: typeof stats.harmful === "number" ? stats.harmful : 0 },
		},
		date,
	);
}

const readText = (p: string): string | undefined => {
	try {
		return readFileSync(p, "utf-8");
	} catch {
		return undefined;
	}
};
const readJson = <T>(p: string): T | undefined => {
	try {
		return JSON.parse(readFileSync(p, "utf-8")) as T;
	} catch {
		return undefined;
	}
};
const dirs = (p: string): string[] => {
	try {
		return readdirSync(p, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return [];
	}
};

interface OldState {
	cutoffMs?: number;
	sessions?: Record<string, SessionMark>;
	inboxDone?: string[];
	lastRun?: { id: string; startedAt: string; finishedAt?: string; status: string; error?: string; sessions?: number; cost?: number };
	rejected?: Array<{ title: string; at: string }>;
	runs?: Array<{ id: string }>;
	openPr?: { number: number; url: string };
}

export function importPiDream(app: App, opts: ImportOptions = {}): Promise<ImportResult> {
	return app.lock(async () => {
		const { mem, state, db, paths } = app;
		const from = expandHome(opts.from?.trim() || "~/.pi/memory");
		if (!existsSync(join(from, "scopes"))) throw bad(`${from} is not a pi-dream memory repository (no scopes/ folder)`);
		const existing = await mem.noteIds(MAIN);
		if (existing.size && !opts.overwrite) throw new HttpError(409, `memory already has ${existing.size} notes: import with overwrite (the source wins for the notes it has)`);
		const warnings: string[] = [];
		const res: ImportResult = { from, notes: 0, scopes: 0, skills: 0, prompts: 0, sessions: 0, inbox: 0, rejected: 0, runs: 0, digests: false, settings: false, pruned: 0, warnings, commit: null };

		// ── memory: scopes, notes, skills, prompts ───────────────────────
		const scopeIds = [...(existsSync(join(from, "scopes", "global")) ? [GLOBAL_SCOPE] : []), ...dirs(join(from, "scopes", "projects")).map((d) => `projects/${d}`)];
		const taken = new Set(existing);
		const notes: Note[] = [];
		for (const scope of scopeIds) {
			const dir = join(from, "scopes", scope);
			const meta = scope === GLOBAL_SCOPE ? undefined : readJson<{ key?: string; root?: string }>(join(dir, "scope.json"));
			const charter = readText(join(dir, "charter.md"))?.trim();
			let names: string[] = [];
			try {
				names = readdirSync(join(dir, "notes")).filter((n) => n.endsWith(".md")).sort();
			} catch {
				// no notes yet
			}
			const skillNames = dirs(join(dir, "skills"));
			if (!names.length && !skillNames.length && !charter && scope !== GLOBAL_SCOPE) continue;
			await mem.ensureScope(MAIN, { id: scope, key: meta?.key, root: meta?.root });
			if (charter && charter !== (scope === GLOBAL_SCOPE ? DEFAULT_GLOBAL_CHARTER : DEFAULT_PROJECT_CHARTER)) await mem.setCharter(MAIN, scope, charter);
			res.scopes++;
			for (const name of names) {
				const text = readText(join(dir, "notes", name));
				if (text === undefined) continue;
				const fmId = /^id:\s*(m-[0-9a-f]{6,12})\s*$/m.exec(text)?.[1];
				if (fmId) taken.delete(fmId); // its own id is not "taken" by an earlier import
				const note = parseNoteFile(text, scope, taken);
				if (notes.some((n) => n.id === note.id)) {
					warnings.push(`${scope}/notes/${name}: duplicate id ${note.id}, skipped`);
					continue;
				}
				notes.push(note);
			}
			for (const skill of skillNames) {
				const text = readText(join(dir, "skills", skill, "SKILL.md"));
				if (!text) continue;
				const { fm, body } = frontMatter(text);
				await mem.upsertSkill(MAIN, { scope, name: typeof fm.name === "string" ? fm.name : skill, description: typeof fm.description === "string" ? fm.description : "", body: body.trim() }, today());
				res.skills++;
			}
		}
		await mem.upsert(MAIN, notes);
		res.notes = notes.length;
		for (const n of notes) if (n.stats && (n.stats.helpful || n.stats.harmful)) await state.setStats(n.id, n.stats);
		if (opts.prune) {
			const keep = new Set(notes.map((n) => n.id));
			const gone = [...existing].filter((id) => !keep.has(id));
			await mem.remove(MAIN, gone);
			res.pruned = gone.length;
		}
		const projectCharter = readText(join(from, "scopes", "projects", "_charter.md"))?.trim();
		if (projectCharter && projectCharter !== DEFAULT_PROJECT_CHARTER) {
			await mem.setPrompt(MAIN, "project_charter", projectCharter);
			res.prompts++;
		}
		for (const name of PROMPT_NAMES) {
			const text = readText(join(from, "prompts", `${name}.md`))?.trim();
			if (text && text !== defaultPrompt(name)) {
				await mem.setPrompt(MAIN, name, text);
				res.prompts++;
			}
		}
		res.commit = await db.commit(MAIN, `import from pi-dream: ${notes.length} notes, ${res.scopes} scopes${res.skills ? `, ${res.skills} skills` : ""}\n\n${from}${opts.actor ? `\nvia ${opts.actor}` : ""}`, app.identity);

		// ── state ────────────────────────────────────────────────────────
		const local = join(from, ".local");
		const old = readJson<OldState>(join(local, "state.json"));
		if (old) {
			if (typeof old.cutoffMs === "number") await state.set("cutoffMs", old.cutoffMs);
			if (old.sessions) {
				await state.setMarks(old.sessions);
				res.sessions = Object.keys(old.sessions).length;
			}
			const known = new Set(await state.rejectedTitles(10_000));
			for (const r of old.rejected ?? []) {
				if (known.has(r.title)) continue;
				await state.addRejection(r.title);
				res.rejected++;
			}
			const have = new Set((await state.runs(10_000)).map((r) => r.id));
			const runIds = new Set([...(old.runs ?? []).map((r) => r.id), ...(old.lastRun ? [old.lastRun.id] : [])]);
			for (const id of runIds) {
				if (have.has(id)) continue;
				const report = readJson<ReportData>(join(local, "runs", id, "report.json"));
				const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(id);
				const started = old.lastRun?.id === id ? old.lastRun.startedAt : m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).toISOString() : new Date().toISOString();
				const last = old.lastRun?.id === id ? old.lastRun : undefined;
				await state.createRun({ id, kind: "run", status: "running", startedAt: started, trigger: "pi-dream" });
				await state.updateRun(id, {
					status: last ? (["ok", "noop", "error"].includes(last.status) ? (last.status as "ok" | "noop" | "error") : "error") : "ok",
					finishedAt: last?.finishedAt ?? started,
					error: last?.error,
					sessions: last?.sessions ?? report?.sessions?.length,
					cost: last?.cost,
					title: report ? `pi-dream ${report.date}` : "pi-dream",
					report: report && Array.isArray(report.items) ? { ...report, agents: report.agents ?? [], rejected: report.rejected ?? [], indexes: report.indexes ?? [] } : undefined,
				});
				res.runs++;
			}
			const merged = old.openPr ? spawnSync("git", ["-C", from, "log", "-n", "1", "--oneline", "--grep", `Merge pull request #${old.openPr.number} `], { encoding: "utf-8" }).stdout?.trim() : "";
			if (old.openPr && !merged) warnings.push(`pi-dream has an open review PR (${old.openPr.url}): what it proposes is not on main and was not imported — merge it and import again, or let the next dream find it anew`);
		}
		const done = new Set(old?.inboxDone ?? []);
		const haveInbox = new Set((await state.inbox("all")).map((i) => i.id));
		for (const name of (existsSync(join(local, "inbox")) ? readdirSync(join(local, "inbox")) : []).filter((n) => n.endsWith(".jsonl")).sort()) {
			for (const line of (readText(join(local, "inbox", name)) ?? "").split("\n")) {
				if (!line.trim()) continue;
				try {
					const item = JSON.parse(line) as InboxItem;
					if (!item?.id || typeof item.text !== "string" || haveInbox.has(item.id)) continue;
					await state.addInbox({ ...item, source: item.source === "user" ? "user" : "agent", status: done.has(item.id) ? "done" : "pending" });
					res.inbox++;
				} catch {
					// torn line
				}
			}
		}

		// ── digests and cards (derived, but slow to rebuild) ─────────────
		for (const [name, to] of [
			["digests", paths.digests],
			["cards", paths.cards],
		] as const) {
			const src = join(local, name);
			if (!existsSync(src) || !statSync(src).isDirectory()) continue;
			cpSync(src, to, { recursive: true, force: true });
			if (name === "digests") res.digests = true;
		}

		// ── settings ─────────────────────────────────────────────────────
		const settings = readJson<Record<string, unknown>>(join(piAgentDir(), "@wierdbytes", "pi-dream", "settings.json"));
		if (settings) {
			const next = sanitize({
				...app.cfg,
				language: settings.language,
				inject: settings.inject,
				models: settings.models,
				// The schedule is copied but stays off: pi-dream still dreams until you switch over.
				schedule: { ...(settings.schedule as object), enabled: app.cfg.schedule.enabled },
				dream: { ...(settings.dream as object), piCommand: app.cfg.dream.piCommand },
				budgets: settings.budgets,
				agentsMd: settings.agentsMd,
			});
			saveConfig(next, paths.config);
			app.cfg = { ...next, port: app.cfg.port, doltPort: app.cfg.doltPort };
			res.settings = true;
		}
		await app.afterMainChange({ skills: true });
		return res;
	});
}
