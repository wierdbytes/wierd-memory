/**
 * Names: scopes, project keys, run ids, and where wierd-mem keeps its files.
 *
 * ```
 * ~/.wierd-mem/                (WMEM_HOME)
 *   config.json                settings
 *   dolt/                      Dolt data dir: `wmem` (memory, versioned) and `wmem_state` (inbox, runs, reviews)
 *   digests/<project>/<session>.txt   session digests — the search corpus (derived, rebuilt by dreams)
 *   cards/<session>.json       session cards (cache of the cheap-model pass)
 *   runs/<run>/                what each dream saw and said (debugging)
 *   logs/                      server.log, dolt.log, dreams/<run>.log
 *   skills/<scope>/<name>/SKILL.md    approved skills, written out for pi to load
 * ```
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const GLOBAL_SCOPE = "global";

export function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return resolve(p);
}

/** Directory-safe name for a project key (`github.com/o/r` → `github.com__o__r`). */
export function keyToDir(key: string): string {
	const raw = key.startsWith("local:") ? `local/${key.slice(6)}` : key;
	let s = raw
		.split("/")
		.filter(Boolean)
		.join("__")
		.replace(/[^A-Za-z0-9._-]/g, "_");
	if (s.length > 120) s = `${s.slice(0, 100)}__${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
	return s || "_";
}

/** Scope id for a project key: `projects/<dir>`. */
export function projectScope(key: string): string {
	return `projects/${keyToDir(key)}`;
}

/** Best guess of the project key behind a scope id (`projects/local__Users__me__app` → `local:/Users/me/app`). */
export function keyOfScope(scope: string): string | undefined {
	if (!scope.startsWith("projects/")) return undefined;
	const path = scope.slice("projects/".length).split("__").join("/");
	return path.startsWith("local/") ? `local:/${path.slice(6)}` : path;
}

export interface HomePaths {
	home: string;
	config: string;
	dolt: string;
	digests: string;
	digestIndex: string;
	cards: string;
	runs: string;
	logs: string;
	dreamLogs: string;
	skills: string;
	serverInfo: string;
}

export function wmemHome(): string {
	return expandHome(process.env.WMEM_HOME || "~/.wierd-mem");
}

export function homePaths(home: string = wmemHome()): HomePaths {
	return {
		home,
		config: join(home, "config.json"),
		dolt: join(home, "dolt"),
		digests: join(home, "digests"),
		digestIndex: join(home, "digests", "index.json"),
		cards: join(home, "cards"),
		runs: join(home, "runs"),
		logs: join(home, "logs"),
		dreamLogs: join(home, "logs", "dreams"),
		skills: join(home, "skills"),
		serverInfo: join(home, "server.json"),
	};
}

/** Local calendar date `YYYY-MM-DD`. */
export function today(d: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Sortable run id: `20261108-0415-a1b2`. */
export function newRunId(d: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	const rand = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${rand}`;
}

/** `2026-11-08 21:41` from a run id (`20261108-2141-a1b2`). */
export function runWhen(runId: string): string {
	const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(runId);
	return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : runId;
}

/** pi's agent directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`). */
export function piAgentDir(): string {
	return expandHome(process.env.PI_CODING_AGENT_DIR || "~/.pi/agent");
}
