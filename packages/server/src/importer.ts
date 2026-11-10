/**
 * Taking over from pi-dream: what its memory repository keeps outside git
 * (`<repo>/.local`) — which sessions were read, the inbox, rejected titles,
 * session digests and cards — and its settings.
 *
 * The notes themselves need no import: wierd-mem works on the same repository
 * (a branch of it), in the same file format. To bring over notes pi-dream
 * approved later, merge its branch with git.
 *
 * Nothing is changed in the source, and running it again only adds what is
 * new (a session pi-dream has read since, a new inbox item).
 */

import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expandHome, type InboxItem, piAgentDir, sanitize, saveConfig, type SessionMark } from "@wierd-mem/core";
import { type App, bad } from "./app.ts";

export interface ImportOptions {
	from?: string;
}

export interface ImportResult {
	from: string;
	sessions: number;
	inbox: number;
	rejected: number;
	digests: boolean;
	settings: boolean;
	warnings: string[];
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

interface OldState {
	cutoffMs?: number;
	sessions?: Record<string, SessionMark>;
	inboxDone?: string[];
	rejected?: Array<{ title: string; at: string }>;
	openPr?: { number: number; url: string };
}

export function importPiDreamState(app: App, opts: ImportOptions = {}): Promise<ImportResult> {
	return app.lock(async () => {
		const { state, paths } = app;
		const from = expandHome(opts.from?.trim() || "~/.pi/memory");
		const local = join(from, ".local");
		if (!existsSync(local)) throw bad(`${from} has no .local folder: not a pi-dream memory repository`);
		if (local === paths.local) throw bad(`${from} is the repository wierd-mem itself works in`);
		const warnings: string[] = [];
		const res: ImportResult = { from, sessions: 0, inbox: 0, rejected: 0, digests: false, settings: false, warnings };

		const old = readJson<OldState>(join(local, "state.json"));
		if (old) {
			const cur = await state.get<number>("cutoffMs");
			if (typeof old.cutoffMs === "number") await state.set("cutoffMs", cur === undefined ? old.cutoffMs : Math.min(cur, old.cutoffMs));
			if (old.sessions) {
				// What wierd-mem itself has read since stays: its own mark is the newer one.
				const mine = await state.marks();
				const fresh = Object.fromEntries(Object.entries(old.sessions).filter(([path, m]) => !mine[path] || (mine[path].size < m.size && m.ok)));
				await state.setMarks(fresh);
				res.sessions = Object.keys(fresh).length;
			}
			const known = new Set(await state.rejectedTitles(10_000));
			for (const r of old.rejected ?? []) {
				if (known.has(r.title)) continue;
				await state.addRejection(r.title);
				res.rejected++;
			}
			if (old.openPr) warnings.push(`pi-dream remembers a review PR (${old.openPr.url}): what an open PR proposes is not on its main branch — merge it there first, then merge that branch into wierd-mem's`);
		}
		const done = new Set(old?.inboxDone ?? []);
		const have = new Set((await state.inbox("all")).map((i) => i.id));
		const dir = join(local, "inbox");
		for (const name of (existsSync(dir) ? readdirSync(dir) : []).filter((n) => n.endsWith(".jsonl")).sort()) {
			for (const line of (readText(join(dir, name)) ?? "").split("\n")) {
				if (!line.trim()) continue;
				try {
					const item = JSON.parse(line) as InboxItem;
					if (!item?.id || typeof item.text !== "string" || have.has(item.id)) continue;
					await state.addInbox({ ...item, source: item.source === "user" ? "user" : "agent", status: done.has(item.id) ? "done" : "pending" });
					res.inbox++;
				} catch {
					// a torn line
				}
			}
		}
		// Digests and cards are derived, but slow (and not free) to rebuild.
		for (const [name, to] of [
			["digests", paths.digests],
			["cards", paths.cards],
		] as const) {
			const src = join(local, name);
			if (!existsSync(src) || !statSync(src).isDirectory()) continue;
			cpSync(src, to, { recursive: true, force: true });
			if (name === "digests") res.digests = true;
		}
		const settings = readJson<Record<string, unknown>>(join(piAgentDir(), "@wierdbytes", "pi-dream", "settings.json"));
		if (settings) {
			const next = sanitize({
				...app.cfg,
				language: settings.language,
				inject: settings.inject,
				models: settings.models,
				// The schedule is copied but stays as it is set here: pi-dream still dreams until you switch over.
				schedule: { ...(settings.schedule as object), enabled: app.cfg.schedule.enabled },
				dream: { ...(settings.dream as object), piCommand: app.cfg.dream.piCommand },
				budgets: settings.budgets,
				agentsMd: settings.agentsMd,
			});
			saveConfig(next, paths.config);
			app.cfg = { ...next, port: app.cfg.port, memory: app.cfg.memory };
			res.settings = true;
		}
		app.dreams.configChanged();
		app.bump("import");
		return res;
	});
}
