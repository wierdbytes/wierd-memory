#!/usr/bin/env bun
/**
 * `wmem` — the command line of wierd-mem, for people and for agents.
 *
 * `wmem serve` is the server. Every other command is a client of its HTTP API
 * (`WMEM_URL`, default http://127.0.0.1:7433): `--json` prints the raw answer.
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type DreamStatus,
	type InboxItem,
	type NoteHistoryEntry,
	type NoteView,
	type ReviewItem,
	type ReviewView,
	type RunInfo,
	type ScopeInfo,
	type SearchResult,
	type StatusInfo,
	type CommitInfo,
	homePaths,
	loadConfig,
	serializeNote,
	serverUrl,
	slugify,
} from "@wierd-mem/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const LABEL = "dev.wierd-mem.server";

// ── arguments ────────────────────────────────────────────────────────────

interface Args {
	_: string[];
	flags: Record<string, string | boolean>;
}

const BOOL = new Set(["json", "all", "global", "overwrite", "prune", "notes", "sessions", "help", "force", "off", "archived", "pinned", "follow", "state", "short", "history"]);

function parseArgs(argv: string[]): Args {
	const out: Args = { _: [], flags: {} };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			out._.push(...argv.slice(i + 1));
			break;
		}
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
			if (eq > 0) out.flags[key] = a.slice(eq + 1);
			else if (BOOL.has(key) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) out.flags[key] = true;
			else out.flags[key] = argv[++i];
		} else if (a === "-q" && i + 1 < argv.length) out.flags.q = argv[++i];
		else if (a === "-h") out.flags.help = true;
		else out._.push(a);
	}
	return out;
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

// ── the server ───────────────────────────────────────────────────────────

class ApiFailure extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const base = () => serverUrl(loadConfig());

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`${base()}${path}`, {
			method,
			headers: { "x-wmem-client": process.env.WMEM_CLIENT || "cli", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
	} catch {
		throw new ApiFailure(0, `the wierd-mem server is not running at ${base()} — start it with \`wmem serve\`, or keep it running with \`wmem service install\``);
	}
	const type = res.headers.get("content-type") ?? "";
	if (!type.includes("json")) {
		const text = await res.text();
		if (!res.ok) throw new ApiFailure(res.status, text || res.statusText);
		return text as T;
	}
	const data = (await res.json()) as T & { error?: string };
	if (!res.ok) throw new ApiFailure(res.status, data?.error ?? res.statusText);
	return data;
}

const get = <T>(path: string) => api<T>("GET", path);
const qs = (o: Record<string, string | number | boolean | undefined>) => {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== false && v !== "") p.set(k, String(v === true ? 1 : v));
	const s = p.toString();
	return s ? `?${s}` : "";
};

// ── printing ─────────────────────────────────────────────────────────────

const tty = process.stdout.isTTY;
const c = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c(2, s);
const bold = (s: string) => c(1, s);
const out = (s = ""): void => {
	process.stdout.write(`${s}\n`);
};
const MARK: Record<string, string> = { always: "●", pointer: "○", none: "·", over: "!", off: "⊘", archived: "—" };
const KIND: Record<string, string> = { added: "+ new", updated: "~ edit", moved: "→ move", superseded: "⇄ replace", deprecated: "− close", removed: "✖ drop", confirmed: "✓ confirm", skill: "§ skill" };

function ago(iso: string | undefined): string {
	if (!iso) return "";
	const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

function printNote(n: NoteView): void {
	out(`${bold(n.title)}`);
	out(dim(`${n.id} · ${n.scopeName} · ${n.type} · ${n.reach}${n.pinned ? " · pinned" : ""}${n.status !== "active" ? ` · ${n.status}` : ""} · updated ${n.updated}`));
	if (n.when) out(`${dim("when:")} ${n.when}`);
	out();
	out(n.body || dim("(no details)"));
	if (n.evidence.length) {
		out();
		out(dim(`evidence (${n.evidence.length}): ${n.evidence.map((e) => `${e.s.slice(0, 13)}${e.e.length ? `#${e.e.join(",")}` : ""}${e.kind ? ` ${e.kind}` : ""}`).join("; ")}`));
	}
}

function printItem(it: ReviewItem, full: boolean): void {
	out(`${bold(KIND[it.kind] ?? it.kind)}  ${it.note.title}`);
	out(dim(`  ${it.key} · ${it.scopeName}${it.fromName ? ` ← ${it.fromName}` : ""} · ${it.reach}${it.fields.length ? ` · changes: ${it.fields.join(", ")}` : ""}`));
	if (!full) return;
	if (it.before && it.kind === "superseded") out(`  ${dim("replaces:")} ${it.before.title} ${dim(it.before.id)}`);
	if (it.before && it.kind === "updated" && it.before.title !== it.note.title) out(`  ${dim("was:")} ${it.before.title}`);
	if (it.note.when) out(`  ${dim("when:")} ${it.note.when}`);
	if (it.note.body) out(it.note.body.split("\n").map((l) => `  │ ${l}`).join("\n"));
	for (const w of it.why) out(`  ${dim("why:")} ${w}`);
	if (it.check) out(`  ${dim("check:")} ${it.check.verdict}${it.check.corrected ? " (corrected)" : ""}${it.check.reason ? ` — ${it.check.reason}` : ""}`);
	for (const r of it.risky) out(`  ⚠ ${r}`);
	if (it.newerEvidence?.length) out("  ⚠ the note it closes has newer evidence");
	out();
}

function printReview(v: ReviewView | null, full: boolean): void {
	if (!v) return out("No open review.");
	out(`${bold(v.title || v.id)} ${dim(`${v.id} · ${v.status} · ${v.pending} to decide · ${v.accepted} accepted · ${v.rejected} rejected`)}`);
	for (const w of v.warnings) out(`⚠ ${w}`);
	out();
	let scope = "";
	for (const it of v.items) {
		if (it.scope !== scope) {
			scope = it.scope;
			out(c(36, `── ${it.scopeName} ──`));
		}
		printItem(it, full);
	}
	for (const a of v.agents.filter((x) => x.status === "pending")) {
		out(`${bold("📄 AGENTS.md")}  ${a.projectName} ${a.rel}${a.summary ? ` — ${a.summary}` : ""}`);
		out(dim(`  agents:${a.id} · ${a.edits.length} edit(s) · apply: wmem review apply ${a.id}`));
	}
	if (v.status === "open" && (v.items.length || v.agents.some((a) => a.status === "pending"))) {
		out();
		out(dim("wmem review accept <key…|--all> · reject <key…|--all> · edit <key> --title … --body … · comment <text> · close"));
	}
}

function printRun(r: RunInfo): string {
	const state = r.status === "running" ? c(33, "running") : r.status === "error" ? c(31, "error") : r.status;
	return `${r.id}  ${r.kind.padEnd(7)} ${state.padEnd(tty ? 18 : 9)} ${dim(ago(r.finishedAt ?? r.startedAt).padEnd(10))} ${r.title ?? ""}${r.sessions ? dim(` · ${r.sessions} sessions`) : ""}${r.cost ? dim(` · $${r.cost.toFixed(2)}`) : ""}${r.error ? ` — ${r.error}` : ""}`;
}

// ── commands ─────────────────────────────────────────────────────────────

const HELP = `wmem — memory for pi agents, kept in Dolt (https://127.0.0.1:7433 is the web UI)

  wmem serve                          run the server (Dolt + API + web UI)
  wmem service install|uninstall|status|restart   keep the server running (launchd)
  wmem status                         memory, the open review, dreams
  wmem open                           open the web UI

memory
  wmem notes [--scope <id|name>] [-q <text>] [--all]      list notes (--all: also off and archived)
  wmem note <id> [--history]          show a note
  wmem note add --title <t> [--body <b>] [--scope <id>] [--index always|pointer|none] [--type <t>] [--when <w>]
  wmem note edit <id> [--title …] [--body …] [--when …] [--index …] [--type …] [--scope …]
  wmem note off|on|pin|unpin|close|reopen|delete <id>
  wmem note restore <id> <commit>     put a note back as it was at a commit
  wmem scopes                         scopes and their index budgets
  wmem search <query> [--all] [--notes|--sessions] [--cwd <dir>]
  wmem read <m-id | s:session#entry>
  wmem remember <text> [--global] [--kind <kind>]          add to the inbox for the next dream
  wmem inbox [rm <id>]
  wmem history [--limit N]            commits on approved memory

review (what dreams propose)
  wmem review [--short]               the open review (--short: one line per item)
  wmem review accept <key…> | --all   make the proposals memory
  wmem review reject <key…> | --all [--reason <why>]
  wmem review edit <key> [--title …] [--body …] [--when …] [--index …] [--type …] [--scope …]   edit, then accept
  wmem review comment <text> [--note <id>]                 an instruction for the next dream
  wmem review apply|drop <agents id>  AGENTS.md proposals
  wmem review close                   reject whatever is left
  wmem reviews                        past reviews

dreams
  wmem dream [status]                 running, last, due
  wmem dream run [--since <days>] [--max <sessions>]       dream now
  wmem dream review                   apply review comments only
  wmem dream dry                      dream without writing anything
  wmem dream reindex                  rebuild session digests (search)
  wmem dream log [<run>] [--follow]   a dream's log
  wmem dream report [<run>]           what a dream proposed
  wmem dream cancel [<run>]
  wmem dream schedule on|off          let the server dream on its own

setup
  wmem import [--from ~/.pi/memory] [--overwrite] [--prune]   take over a pi-dream memory repository
  wmem export <dir>                   notes as Markdown files
  wmem config [<key> [<value>]]       settings (e.g. schedule.enabled true)
  wmem push                           push approved memory to the Dolt remote (remote.url)
  wmem herdr install                  install the Herdr mod
  wmem sql ["<query>"] [--state]      SQL on the memory database (no query: a shell); --state: inbox, runs, reviews
                                      e.g. wmem sql "select * from dolt_log limit 5"

--json prints the server's answer as is.`;

async function findNoteScope(want: string): Promise<string> {
	const scopes = await get<ScopeInfo[]>("/api/scopes");
	const hit = scopes.find((s) => s.id === want) ?? scopes.find((s) => s.name.toLowerCase() === want.toLowerCase()) ?? scopes.find((s) => s.key === want);
	if (!hit) {
		if (want === "global" || want.startsWith("projects/")) return want;
		throw new ApiFailure(404, `no scope "${want}" (wmem scopes)`);
	}
	return hit.id;
}

function noteFields(a: Args): Record<string, unknown> {
	const f: Record<string, unknown> = {};
	for (const k of ["title", "body", "when", "index", "type"]) if (typeof a.flags[k] === "string") f[k] = a.flags[k];
	return f;
}

async function latestRun(id?: string): Promise<string> {
	if (id) return id;
	const s = await get<DreamStatus>("/api/dreams?limit=1");
	const run = s.running ?? s.runs[0];
	if (!run) throw new ApiFailure(404, "no dreams yet");
	return run.id;
}

async function main(): Promise<void> {
	const a = parseArgs(process.argv.slice(2));
	const [cmd = "help", sub, ...rest] = a._;
	const json = a.flags.json === true;
	const show = (data: unknown, pretty: () => void): void => (json ? out(JSON.stringify(data, null, 2)) : pretty());

	switch (cmd) {
		case "help":
			return out(HELP);

		case "serve": {
			const { serve } = await import("./serve.ts");
			return serve();
		}

		case "status": {
			const s = await get<StatusInfo>("/api/status");
			return show(s, () => {
				out(`${bold("wierd-mem")} ${s.version}  ${s.url}`);
				out(`memory    ${s.notes.active} notes in ${s.notes.scopes} scopes${s.notes.off ? `, ${s.notes.off} off` : ""}${s.notes.archived ? `, ${s.notes.archived} archived` : ""} ${dim(`· at ${s.memver}`)}`);
				out(`inbox     ${s.inbox} waiting for the next dream`);
				out(`review    ${s.review ? `${s.review.pending} to decide — ${s.review.title} ${dim(`(${s.url}/#/review)`)}` : "nothing to review"}`);
				const d = s.dream;
				out(`dream     ${d.running ? `running (${d.running.id}, ${ago(d.running.startedAt)})` : d.last ? `last ${d.last.status} ${ago(d.last.finishedAt ?? d.last.startedAt)}` : "none yet"} ${dim(`· ${d.scheduled ? (d.due.due ? "due" : "not due") : "schedule off"}: ${d.due.reason}`)}`);
				out(`storage   ${s.home}/dolt ${dim(`· dolt ${s.dolt.version} on :${s.dolt.port}, database ${s.dolt.database}`)}`);
				if (s.remote.url) out(`remote    ${s.remote.url}${s.remote.lastPush ? dim(` · pushed ${ago(s.remote.lastPush)}`) : ""}${s.remote.error ? ` — ${s.remote.error}` : ""}`);
			});
		}

		case "open": {
			spawn(process.platform === "darwin" ? "open" : "xdg-open", [base()], { detached: true, stdio: "ignore" }).unref();
			return out(base());
		}

		case "scopes": {
			const scopes = await get<ScopeInfo[]>("/api/scopes");
			return show(scopes, () => {
				for (const s of scopes) out(`${bold(s.name.padEnd(28))} ${String(s.counts.active).padStart(3)} notes  ${dim(`index ~${s.index.tokens}/${s.budget} tokens${s.index.over ? `, ${s.index.over} over budget` : ""}${s.counts.off ? ` · ${s.counts.off} off` : ""}${s.counts.archived ? ` · ${s.counts.archived} archived` : ""} · ${s.id}`)}`);
			});
		}

		case "notes": {
			const scope = str(a.flags.scope) ? await findNoteScope(str(a.flags.scope) as string) : undefined;
			let { notes } = await get<{ notes: NoteView[] }>(`/api/notes${qs({ scope })}`);
			if (!a.flags.all) notes = notes.filter((n) => n.status === "active" && n.enabled);
			const q = str(a.flags.q)?.toLowerCase();
			if (q) notes = notes.filter((n) => `${n.title}\n${n.when ?? ""}\n${n.body}\n${n.id}`.toLowerCase().includes(q));
			return show({ notes }, () => {
				let scopeName = "";
				for (const n of notes) {
					if (n.scopeName !== scopeName) {
						scopeName = n.scopeName;
						out(c(36, `── ${scopeName} ──`));
					}
					out(`${MARK[n.reach] ?? " "} ${dim(n.id)} ${n.title}`);
				}
				out(dim(`${notes.length} notes · ● always in context  ○ when relevant  · search only  ! over budget  ⊘ off  — archived`));
			});
		}

		case "note": {
			if (!sub) throw new ApiFailure(400, "wmem note <id> | add | edit | off | on | pin | unpin | close | reopen | delete | restore");
			if (sub === "add") {
				const title = str(a.flags.title) ?? rest.join(" ");
				if (!title) throw new ApiFailure(400, "wmem note add --title <text>");
				const scope = str(a.flags.scope) ? await findNoteScope(str(a.flags.scope) as string) : "global";
				const n = await api<NoteView>("POST", "/api/notes", { ...noteFields(a), title, scope, pinned: a.flags.pinned === true });
				return show(n, () => out(`added ${n.id} to ${n.scopeName}`));
			}
			if (sub === "edit") {
				const id = rest[0];
				if (!id) throw new ApiFailure(400, "wmem note edit <id> --title … --body …");
				const patch = noteFields(a);
				if (str(a.flags.scope)) patch.scope = await findNoteScope(str(a.flags.scope) as string);
				if (!Object.keys(patch).length) throw new ApiFailure(400, "nothing to change: --title, --body, --when, --index, --type, --scope");
				const n = await api<NoteView>("PATCH", `/api/notes/${id}`, patch);
				return show(n, () => printNote(n));
			}
			const toggles: Record<string, Record<string, unknown>> = {
				off: { enabled: false },
				on: { enabled: true },
				pin: { pinned: true },
				unpin: { pinned: false },
				close: { status: "deprecated" },
				reopen: { status: "active" },
			};
			if (sub in toggles) {
				if (!rest[0]) throw new ApiFailure(400, `wmem note ${sub} <id>`);
				const n = await api<NoteView>("PATCH", `/api/notes/${rest[0]}`, toggles[sub]);
				return show(n, () => out(`${n.id}: ${n.reach} — ${n.title}`));
			}
			if (sub === "delete") {
				if (!rest[0]) throw new ApiFailure(400, "wmem note delete <id>");
				await api("DELETE", `/api/notes/${rest[0]}`);
				return out(`deleted ${rest[0]}`);
			}
			if (sub === "restore") {
				if (!rest[0] || !rest[1]) throw new ApiFailure(400, "wmem note restore <id> <commit>");
				const n = await api<NoteView>("POST", `/api/notes/${rest[0]}/restore`, { commit: rest[1] });
				return show(n, () => printNote(n));
			}
			const n = await get<NoteView>(`/api/notes/${sub}`);
			if (a.flags.history) {
				const h = await get<NoteHistoryEntry[]>(`/api/notes/${sub}/history`);
				return show(h, () => {
					for (const e of h) out(`${dim(e.commit.slice(0, 8))} ${e.date.slice(0, 16).replace("T", " ")} ${e.author.padEnd(18)} ${e.type.padEnd(8)} ${e.message.split("\n")[0]} ${dim(Object.keys(e.changes).join(", "))}`);
				});
			}
			return show(n, () => printNote(n));
		}

		case "search": {
			const query = [sub, ...rest].filter(Boolean).join(" ");
			if (!query) throw new ApiFailure(400, "wmem search <query>");
			const r = await get<SearchResult>(`/api/search${qs({ q: query, projects: a.flags.all ? "all" : "current", scope: a.flags.notes ? "notes" : a.flags.sessions ? "sessions" : "all", cwd: str(a.flags.cwd) ?? process.cwd(), limit: str(a.flags.limit) })}`);
			return show(r, () => out(r.text));
		}

		case "read": {
			if (!sub) throw new ApiFailure(400, "wmem read <m-id | s:session#entry>");
			const r = await get<{ text: string }>(`/api/read${qs({ ref: sub })}`);
			return show(r, () => out(r.text));
		}

		case "remember": {
			const text = [sub, ...rest].filter(Boolean).join(" ");
			if (!text) throw new ApiFailure(400, "wmem remember <what future sessions should know>");
			const item = await api<InboxItem>("POST", "/api/inbox", { text, source: process.env.WMEM_CLIENT === "pi" ? "agent" : "user", scope: a.flags.global ? "global" : undefined, kind: str(a.flags.kind), cwd: str(a.flags.cwd) ?? process.cwd() });
			return show(item, () => out(`saved to the inbox (${item.id}): the next dream reviews it; it becomes memory once you accept it`));
		}

		case "inbox": {
			if (sub === "rm" || sub === "dismiss") {
				if (!rest[0]) throw new ApiFailure(400, "wmem inbox rm <id>");
				await api("DELETE", `/api/inbox/${rest[0]}`);
				return out(`dismissed ${rest[0]}`);
			}
			const items = await get<InboxItem[]>("/api/inbox");
			return show(items, () => {
				if (!items.length) return out("The inbox is empty.");
				for (const i of items) out(`${dim(i.id)} ${dim(i.ts.slice(0, 16).replace("T", " "))} ${dim(`[${i.source}${i.kind ? ` ${i.kind}` : ""} → ${i.scope === "global" ? "global" : (i.projectName ?? "project")}]`)} ${i.text}`);
			});
		}

		case "history": {
			const log = await get<CommitInfo[]>(`/api/history${qs({ limit: str(a.flags.limit) ?? 30 })}`);
			return show(log, () => {
				for (const e of log) out(`${dim(e.hash.slice(0, 8))} ${e.date.slice(0, 16).replace("T", " ")} ${e.author.padEnd(18)} ${e.message.split("\n")[0]}`);
			});
		}

		case "reviews": {
			const list = await get<Array<ReviewView>>("/api/reviews");
			return show(list, () => {
				for (const r of list) out(`${r.id}  ${r.status.padEnd(7)} ${dim(r.createdAt.slice(0, 10))} ${r.title} ${dim(`· ${r.accepted} accepted, ${r.rejected} rejected${r.pending ? `, ${r.pending} to decide` : ""}`)}`);
				if (!list.length) out("No reviews yet.");
			});
		}

		case "review": {
			const keysOrAll = () => {
				if (a.flags.all) return undefined;
				if (!rest.length) throw new ApiFailure(400, `wmem review ${sub} <key…> | --all`);
				return rest.map((k) => (k.includes(":") ? k : `note:${k}`));
			};
			if (!sub || sub === "show") {
				const v = await get<ReviewView | null>("/api/review");
				return show(v, () => printReview(v, a.flags.short !== true));
			}
			if (sub === "accept" || sub === "reject") {
				const v = await api<ReviewView>("POST", `/api/reviews/open/${sub}`, { keys: keysOrAll(), reason: str(a.flags.reason) });
				return show(v, () => out(`${sub}ed. ${v.status === "open" ? `${v.pending} left to decide` : `review ${v.status}`} (${v.accepted} accepted, ${v.rejected} rejected)`));
			}
			if (sub === "edit") {
				if (!rest[0]) throw new ApiFailure(400, "wmem review edit <key> --title … --body …");
				const edit = noteFields(a);
				if (str(a.flags.scope)) edit.scope = await findNoteScope(str(a.flags.scope) as string);
				if (!Object.keys(edit).length) throw new ApiFailure(400, "nothing to change: --title, --body, --when, --index, --type, --scope");
				const key = rest[0].includes(":") ? rest[0] : `note:${rest[0]}`;
				const v = await api<ReviewView>("POST", "/api/reviews/open/accept", { keys: [key], edit });
				return show(v, () => out(`edited and accepted ${key}. ${v.status === "open" ? `${v.pending} left to decide` : `review ${v.status}`}`));
			}
			if (sub === "comment") {
				const text = rest.join(" ");
				if (!text) throw new ApiFailure(400, "wmem review comment <text> [--note <id>]");
				const v = await api<ReviewView>("POST", "/api/reviews/open/comments", { body: text, noteId: str(a.flags.note) });
				return show(v, () => out("comment kept: `wmem dream review` applies it now, otherwise the next dream does"));
			}
			if (sub === "apply" || sub === "drop") {
				if (!rest[0]) throw new ApiFailure(400, `wmem review ${sub} <agents id>`);
				await api("POST", `/api/agents/${rest[0].replace(/^agents:/, "")}/${sub === "apply" ? "apply" : "reject"}`, {});
				return out(sub === "apply" ? "applied to the working copy (not committed)" : "dropped");
			}
			if (sub === "close") {
				const v = await api<ReviewView>("POST", "/api/reviews/open/close", {});
				return show(v, () => out(`review ${v.status}`));
			}
			throw new ApiFailure(400, `unknown: wmem review ${sub}`);
		}

		case "dream": {
			const mode = sub ?? "status";
			if (mode === "status") {
				const s = await get<DreamStatus>("/api/dreams?limit=10");
				return show(s, () => {
					out(s.running ? `running: ${s.running.id} (${s.running.kind}), started ${ago(s.running.startedAt)}` : "no dream is running");
					out(`schedule: ${s.schedule.enabled ? "on" : "off"} — ${s.due.due ? "due" : "not due"}: ${s.due.reason}`);
					if (s.runs.length) out();
					for (const r of s.runs) out(printRun(r));
				});
			}
			if (["run", "review", "dry", "reindex"].includes(mode)) {
				const r = await api<RunInfo & { log: string }>("POST", "/api/dreams", { mode, sinceDays: str(a.flags.since) ? Number(a.flags.since) : undefined, maxSessions: str(a.flags.max) ? Number(a.flags.max) : undefined });
				return show(r, () => out(`dream ${r.id} (${r.kind}) started\nlog: ${r.log}\nfollow: wmem dream log --follow`));
			}
			if (mode === "log") {
				const id = await latestRun(rest[0]);
				if (!a.flags.follow) return out((await get<string>(`/api/dreams/${id}/log${qs({ tail: str(a.flags.tail) ?? 200 })}`)).trimEnd());
				let seen = 0;
				for (;;) {
					const text = await get<string>(`/api/dreams/${id}/log?tail=100000`);
					if (text.length > seen) process.stdout.write(text.slice(seen));
					seen = text.length;
					const run = await get<RunInfo>(`/api/dreams/${id}`);
					if (run.status !== "running") return out(dim(`— ${run.status}${run.error ? `: ${run.error}` : ""}`));
					await new Promise((r) => setTimeout(r, 2000));
				}
			}
			if (mode === "report") {
				const id = await latestRun(rest[0]);
				if (json) return out(JSON.stringify(await get(`/api/dreams/${id}`), null, 2));
				return out(await get<string>(`/api/dreams/${id}?format=md`));
			}
			if (mode === "cancel") {
				const id = await latestRun(rest[0]);
				await api("POST", `/api/dreams/${id}/cancel`, {});
				return out(`cancelled ${id}`);
			}
			if (mode === "schedule") {
				const on = rest[0] === "on";
				if (rest[0] !== "on" && rest[0] !== "off") throw new ApiFailure(400, "wmem dream schedule on|off");
				const cfg = await get<{ schedule: Record<string, unknown> }>("/api/config");
				await api("PUT", "/api/config", { schedule: { ...cfg.schedule, enabled: on } });
				return out(`scheduled dreams: ${on ? "on" : "off"}`);
			}
			throw new ApiFailure(400, `unknown: wmem dream ${mode}`);
		}

		case "import": {
			const r = await api<Record<string, unknown> & { warnings: string[] }>("POST", "/api/import", { from: str(a.flags.from), overwrite: a.flags.overwrite === true, prune: a.flags.prune === true });
			return show(r, () => {
				out(`imported from ${r.from}: ${r.notes} notes in ${r.scopes} scopes, ${r.skills} skills, ${r.prompts} prompt overrides`);
				out(`state: ${r.sessions} sessions already read, ${r.inbox} inbox items, ${r.rejected} rejected titles, ${r.runs} past dreams${r.digests ? ", session digests copied" : ""}${r.settings ? ", settings taken from pi-dream" : ""}`);
				if (r.commit) out(dim(`commit ${String(r.commit).slice(0, 8)}`));
				for (const w of r.warnings) out(`⚠ ${w}`);
			});
		}

		case "export": {
			if (!sub) throw new ApiFailure(400, "wmem export <dir>");
			const dir = resolve(sub);
			const { notes } = await get<{ notes: NoteView[] }>("/api/notes");
			const used = new Set<string>();
			for (const n of notes) {
				const folder = join(dir, "scopes", n.scope, "notes");
				mkdirSync(folder, { recursive: true });
				let name = slugify(n.title);
				for (let i = 2; used.has(`${n.scope}/${name}`); i++) name = `${slugify(n.title)}-${i}`;
				used.add(`${n.scope}/${name}`);
				writeFileSync(join(folder, `${name}.md`), serializeNote(n), "utf-8");
			}
			return out(`${notes.length} notes written to ${dir}/scopes`);
		}

		case "config": {
			const cfg = await get<Record<string, unknown>>("/api/config");
			if (!sub) return out(JSON.stringify(cfg, null, 2));
			const path = sub.split(".");
			const read = (o: unknown) => path.reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);
			if (!rest.length) return out(JSON.stringify(read(cfg), null, 2));
			let value: unknown = rest.join(" ");
			try {
				value = JSON.parse(value as string);
			} catch {
				// a plain string
			}
			const patch: Record<string, unknown> = {};
			let cur = patch;
			let src: unknown = cfg;
			path.forEach((k, i) => {
				src = src && typeof src === "object" ? (src as Record<string, unknown>)[k] : undefined;
				if (i === path.length - 1) cur[k] = value;
				else cur = cur[k] = { ...(src && typeof src === "object" ? (src as object) : {}) } as Record<string, unknown>;
			});
			const next = await api<Record<string, unknown>>("PUT", "/api/config", patch);
			return out(`${sub} = ${JSON.stringify(read(next))}${path[0] === "port" || path[0] === "doltPort" ? " (takes effect when the server restarts)" : ""}`);
		}

		case "push": {
			const r = await api<{ message: string }>("POST", "/api/push", {});
			return out(r.message);
		}

		case "sql": {
			// `dolt` talks to the running server: a query, or an interactive SQL shell.
			const cfg = loadConfig();
			const db = a.flags.state ? "wmem_state" : "wmem";
			const query = [sub, ...rest].filter(Boolean).join(" ");
			const args = ["--host", "127.0.0.1", "--port", String(cfg.doltPort), "--no-tls", "-u", "root", "-p", "", "--use-db", db, "sql", ...(query ? ["-q", query] : [])];
			const r = spawnSync(process.env.WMEM_DOLT_BIN || "dolt", args, { stdio: "inherit" });
			if (r.error) throw new ApiFailure(500, `could not run dolt: ${r.error.message}`);
			process.exitCode = r.status ?? 0;
			return;
		}

		case "service":
			return service(sub ?? "status");

		case "herdr":
			if (sub === "install") return herdrInstall();
			throw new ApiFailure(400, "wmem herdr install");

		default:
			throw new ApiFailure(400, `unknown command "${cmd}" — wmem help`);
	}
}

// ── launchd ──────────────────────────────────────────────────────────────

function service(action: string): void {
	if (process.platform !== "darwin") throw new ApiFailure(400, "wmem service is for macOS (launchd); elsewhere run `wmem serve` under your own supervisor");
	const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
	const paths = homePaths();
	const target = `gui/${process.getuid?.() ?? 501}`;
	const launchctl = (...args: string[]) => spawnSync("launchctl", args, { encoding: "utf-8" });
	const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
	switch (action) {
		case "install": {
			mkdirSync(paths.logs, { recursive: true });
			mkdirSync(dirname(plist), { recursive: true });
			const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir() };
			for (const k of ["WMEM_HOME", "PI_CODING_AGENT_DIR", "LANG"]) if (process.env[k]) env[k] = process.env[k] as string;
			const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${esc(process.execPath)}</string>
		<string>${esc(join(HERE, "cli.ts"))}</string>
		<string>serve</string>
	</array>
	<key>WorkingDirectory</key><string>${esc(REPO)}</string>
	<key>EnvironmentVariables</key>
	<dict>
${Object.entries(env).map(([k, v]) => `\t\t<key>${k}</key><string>${esc(v)}</string>`).join("\n")}
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>10</integer>
	<key>StandardOutPath</key><string>${esc(join(paths.logs, "server.log"))}</string>
	<key>StandardErrorPath</key><string>${esc(join(paths.logs, "server.log"))}</string>
</dict>
</plist>
`;
			launchctl("bootout", `${target}/${LABEL}`);
			writeFileSync(plist, xml);
			const r = launchctl("bootstrap", target, plist);
			if (r.status !== 0) throw new ApiFailure(500, `launchctl bootstrap failed: ${r.stderr.trim()}`);
			return out(`installed ${plist}\nthe server starts at login and restarts if it dies; log: ${join(paths.logs, "server.log")}`);
		}
		case "uninstall": {
			launchctl("bootout", `${target}/${LABEL}`);
			rmSync(plist, { force: true });
			return out("removed the launchd agent (the server is stopped)");
		}
		case "restart": {
			const r = launchctl("kickstart", "-k", `${target}/${LABEL}`);
			if (r.status !== 0) throw new ApiFailure(500, `not installed: wmem service install (${r.stderr.trim()})`);
			return out("restarted");
		}
		case "status": {
			const r = launchctl("print", `${target}/${LABEL}`);
			if (r.status !== 0) return out("not installed as a service (wmem service install)");
			const state = /^\s*state = (.+)$/m.exec(r.stdout)?.[1] ?? "?";
			const pid = /^\s*pid = (\d+)$/m.exec(r.stdout)?.[1];
			return out(`launchd: ${state}${pid ? ` (pid ${pid})` : ""} — ${plist}`);
		}
		default:
			throw new ApiFailure(400, "wmem service install|uninstall|status|restart");
	}
}

// ── the Herdr mod ────────────────────────────────────────────────────────

function herdrInstall(): void {
	const home = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
	const src = join(REPO, "packages", "herdr-mod");
	const dst = join(home, "mods", "wierd-mem");
	if (!existsSync(join(src, "main.js"))) throw new ApiFailure(500, `the mod is missing in ${src}`);
	if (!existsSync(home)) throw new ApiFailure(404, `no Herdr app home at ${home}`);
	mkdirSync(dst, { recursive: true });
	for (const name of readdirSync(src)) {
		if (name.endsWith(".d.ts") || name === "jsconfig.json" || name === "README.md" || name.startsWith(".")) continue;
		cpSync(join(src, name), join(dst, name), { recursive: true });
	}
	// The mod reads the server's address from here (the port can be changed in config.json).
	writeFileSync(join(dst, "server.json"), `${JSON.stringify({ url: base() })}\n`);
	out(`installed the mod to ${dst}`);
	const check = spawnSync("herdr-app", ["check", dst], { encoding: "utf-8" });
	if (check.error) out("herdr-app is not on PATH: check the mod with `herdr-app check` yourself");
	else out(check.status === 0 ? "herdr-app check: ok" : `herdr-app check failed:\n${check.stdout}${check.stderr}`);
	const readme = join(src, "README.md");
	if (existsSync(readme)) out(dim(`how to put it into a layout: ${readme}`));
	void readFileSync;
}

main().catch((err) => {
	if (err instanceof ApiFailure) {
		process.stderr.write(`${err.message}\n`);
		process.exit(err.status === 0 ? 3 : 1);
	}
	process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	process.exit(1);
});
