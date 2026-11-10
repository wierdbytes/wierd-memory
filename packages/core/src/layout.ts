/**
 * Names: scopes, project keys, run ids, and where wierd-memory keeps its files.
 *
 * ```
 * ~/.wierd-memory/              (WMEM_HOME)
 *   config.json                 settings
 *   logs/server.log
 *   memory/                     the git repository (`memory.dir`); its approved branch is checked out here
 *     scopes/global/            notes loaded in every session on this machine
 *       charter.md              what this memory is for (steers dreams)
 *       notes/<slug>.md         one note per file: front matter + body
 *       skills/<name>/SKILL.md  approved skills (pi loads them from here)
 *     scopes/projects/<key>/    the same for one project, plus scope.json (its key and root)
 *     prompts/<stage>.md        optional overrides of the dream prompts
 *     .local/                   not in git — what goes on around memory:
 *       state.json              which sessions dreams have read, inbox statuses, rejected titles, votes
 *       inbox/<day>.jsonl       things kept for the next dream (append-only)
 *       reviews/<id>.json       a review: its branch, the decisions made in it, comments, AGENTS.md proposals
 *       runs/<run>/             a dream: run.json, report.json, what the models saw and said
 *       logs/<run>.log          a dream's log
 *       digests/<project>/<session>.txt   session digests — the search corpus (rebuilt by dreams)
 *       cards/<session>.json    session cards (cache of the cheap-model pass)
 *       worktrees/<review>/     the review branch, checked out
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
	serverInfo: string;
	/** The server's own log. */
	logs: string;
	/** The git repository. */
	memory: string;
	/** `.local` in it: everything that is not memory itself. */
	local: string;
	state: string;
	inbox: string;
	reviews: string;
	runs: string;
	dreamLogs: string;
	digests: string;
	digestIndex: string;
	cards: string;
	worktrees: string;
}

export function wmemHome(): string {
	return expandHome(process.env.WMEM_HOME || "~/.wierd-memory");
}

/** `memoryDir`: `memory.dir` from the settings (empty: `memory` under the home). */
export function homePaths(home: string = wmemHome(), memoryDir?: string): HomePaths {
	const memory = memoryDir?.trim() ? expandHome(memoryDir.trim()) : join(home, "memory");
	const local = join(memory, ".local");
	return {
		home,
		config: join(home, "config.json"),
		serverInfo: join(home, "server.json"),
		logs: join(home, "logs"),
		memory,
		local,
		state: join(local, "state.json"),
		inbox: join(local, "inbox"),
		reviews: join(local, "reviews"),
		runs: join(local, "runs"),
		dreamLogs: join(local, "logs"),
		digests: join(local, "digests"),
		digestIndex: join(local, "digests", "index.json"),
		cards: join(local, "cards"),
		worktrees: join(local, "worktrees"),
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
