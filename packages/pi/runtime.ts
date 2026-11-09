/**
 * In-session side of wierd-mem: what a normal pi session sees.
 *
 * - The approved memory for the session's project is asked of the server once
 *   and frozen: the `<memory>` section stays byte-identical turn after turn,
 *   so the provider's prompt cache keeps hitting. Resumed sessions replay the
 *   recorded section instead of asking again.
 * - Search, read and inbox back the memory tools; `/memory` and `/dream` show
 *   and drive the server.
 * - The server is the only one that writes memory and runs dreams; when it is
 *   not running the session simply goes without memory (and says so in `/memory`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ContextInfo, type DreamStatus, homePaths, type InboxItem, type InboxKind, type RunInfo, type SearchResult, SESSION_EVENT, type StatusInfo } from "@wierd-mem/core";
import { ApiError, Client, ServerDown } from "./client.ts";

export const EVENT = SESSION_EVENT;

interface Snapshot {
	text?: string;
	ids: string[];
	tokens: number;
	memver?: string;
	projectKey: string;
}

interface InjectRecord extends Snapshot {
	event: "inject";
}

export function disabledByEnv(): boolean {
	return process.env.WMEM_DISABLE === "1" || process.env.WMEM_CHILD === "1" || process.env.PI_DREAM_CHILD === "1";
}

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Runtime {
	client = new Client();
	private snapshot: Snapshot | undefined;
	private context: Promise<ContextInfo | undefined> | undefined;
	private contextCwd = "";

	constructor(private pi: ExtensionAPI) {}

	active(): boolean {
		return !disabledByEnv() && this.pi.getFlag("no-memory") !== true;
	}

	// ── session lifecycle ────────────────────────────────────────────────

	async onSessionStart(reason: string, ctx: ExtensionContext): Promise<void> {
		this.client = new Client();
		this.snapshot = undefined;
		this.context = undefined;
		if (!this.active()) {
			const keep = this.pi.getActiveTools().filter((n) => !n.startsWith("memory_"));
			this.pi.setActiveTools(keep);
			return;
		}
		if (reason === "resume" || reason === "fork" || reason === "reload") {
			const rec = this.recorded(ctx);
			if (rec) this.snapshot = { text: rec.text, ids: rec.ids, tokens: rec.tokens, memver: rec.memver, projectKey: rec.projectKey };
		}
		void this.contextFor(ctx.cwd);
		if (ctx.hasUI) setTimeout(() => void this.notifyReview(ctx).catch(() => undefined), 2500).unref?.();
	}

	/** What the server knows about a session in `cwd` (started in the background at session start). */
	private contextFor(cwd: string): Promise<ContextInfo | undefined> {
		if (!this.context || this.contextCwd !== cwd) {
			this.contextCwd = cwd;
			this.context = (async () => {
				if (!(await this.client.ensure())) return undefined;
				try {
					return await this.client.get<ContextInfo>(`/api/context?cwd=${encodeURIComponent(cwd)}`, 5000);
				} catch {
					return undefined;
				}
			})();
		}
		return this.context;
	}

	private recorded(ctx: ExtensionContext): InjectRecord | undefined {
		const branch = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type === "custom" && e.customType === EVENT && (e.data as InjectRecord | undefined)?.event === "inject") return e.data as InjectRecord;
		}
		return undefined;
	}

	/** The `<memory>` section for this session (built on the first turn, then frozen). */
	async memorySection(ctx: ExtensionContext): Promise<string | undefined> {
		if (!this.active()) return undefined;
		if (!this.snapshot) {
			// A session never waits long for memory: a slow or absent server means none this time.
			const info = await Promise.race([this.contextFor(ctx.cwd), new Promise<undefined>((r) => setTimeout(() => r(undefined), 2500))]);
			if (!info) return undefined; // not frozen: the next turn asks again
			const text = info.inject ? (info.injection.text ?? undefined) : undefined;
			this.snapshot = { text, ids: text ? info.injection.ids : [], tokens: text ? info.injection.tokens : 0, memver: info.injection.memver, projectKey: info.project.key };
			if (text) this.pi.appendEntry(EVENT, { event: "inject", ...this.snapshot } satisfies InjectRecord);
		}
		return this.snapshot.text;
	}

	async resourcesFor(cwd: string): Promise<string[]> {
		const info = await Promise.race([this.contextFor(cwd), new Promise<undefined>((r) => setTimeout(() => r(undefined), 2500))]);
		return (info?.skills ?? []).filter((d) => existsSync(d));
	}

	// ── tools ────────────────────────────────────────────────────────────

	private async guarded(fn: () => Promise<string>): Promise<string> {
		try {
			return await fn();
		} catch (err) {
			if (err instanceof ServerDown) {
				if (await this.client.ensure()) {
					try {
						return await fn();
					} catch (again) {
						return `Memory is unavailable: ${why(again)}`;
					}
				}
				return `Memory is unavailable: ${err.message}`;
			}
			return `Memory is unavailable: ${why(err)}`;
		}
	}

	search(ctx: ExtensionContext, query: string, scope: "all" | "notes" | "sessions", projects: "current" | "all", limit: number): Promise<string> {
		return this.guarded(async () => {
			const p = new URLSearchParams({ q: query, scope, projects, cwd: ctx.cwd, limit: String(limit), exclude: ctx.sessionManager.getSessionId() });
			return (await this.client.get<SearchResult>(`/api/search?${p}`)).text;
		});
	}

	read(ref: string): Promise<string> {
		return this.guarded(async () => (await this.client.get<{ text: string }>(`/api/read?ref=${encodeURIComponent(ref.trim())}`)).text);
	}

	async inbox(ctx: ExtensionContext, text: string, source: "agent" | "user", kind?: InboxKind, scope?: "global" | "project"): Promise<string> {
		await this.client.ensure();
		const item = await this.client.post<InboxItem>("/api/inbox", {
			text: text.trim(),
			source,
			kind,
			scope,
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
			entryId: ctx.sessionManager.getLeafId() ?? undefined,
		});
		return item.id;
	}

	// ── dreams, status ───────────────────────────────────────────────────

	async startDream(mode: string, opts: { sinceDays?: number; maxSessions?: number } = {}): Promise<RunInfo & { log: string }> {
		await this.client.ensure();
		return this.client.post<RunInfo & { log: string }>("/api/dreams", { mode, ...opts });
	}

	async dreamLog(lines = 40): Promise<string> {
		const s = await this.client.get<DreamStatus>("/api/dreams?limit=1");
		const run = s.running ?? s.runs[0];
		if (!run) return "no dreams yet";
		const text = await this.client.get<string>(`/api/dreams/${run.id}/log?tail=${lines}`);
		return `dream ${run.id} (${run.status}):\n${text.trimEnd() || "(empty log)"}`;
	}

	/** Once per finished dream: tell the user there is something to review (or that the dream failed). */
	private async notifyReview(ctx: ExtensionContext): Promise<void> {
		if (!(await this.client.up(800))) return;
		const s = await this.client.get<StatusInfo>("/api/status", 4000);
		const last = s.dream.last;
		if (!last?.finishedAt) return;
		const file = join(homePaths().home, "notified.json");
		let seen = "";
		try {
			seen = (JSON.parse(readFileSync(file, "utf-8")) as { runId?: string }).runId ?? "";
		} catch {
			// first time
		}
		if (seen === last.id) return;
		try {
			mkdirSync(homePaths().home, { recursive: true });
			writeFileSync(file, JSON.stringify({ runId: last.id }));
		} catch {
			// best effort
		}
		if (last.status === "error") ctx.ui.notify(`wierd-mem: the last dream failed — ${last.error ?? ""} (/dream log)`, "warning");
		else if (s.review?.pending) ctx.ui.notify(`wierd-mem: ${s.review.pending} memory change(s) wait for your review — ${s.url}/#/review`, "info");
	}

	async status(ctx: ExtensionContext): Promise<string> {
		const snap = this.snapshot;
		const session = `session:  ${snap ? (snap.text ? `${snap.ids.length} notes, ~${snap.tokens} tokens, memory ${snap.memver ?? "?"}` : "nothing to inject") : "nothing injected yet (the first turn asks the server)"}`;
		if (!this.active()) return `wierd-mem is off for this run (--no-memory / WMEM_DISABLE)\ncwd:      ${ctx.cwd}`;
		try {
			await this.client.ensure();
			const s = await this.client.get<StatusInfo>("/api/status", 5000);
			const d = s.dream;
			return [
				`server:   ${s.url} (wierd-mem ${s.version}, dolt ${s.dolt.version} on :${s.dolt.port})`,
				`memory:   ${s.notes.active} notes in ${s.notes.scopes} scopes${s.notes.off ? `, ${s.notes.off} off` : ""} · at ${s.memver}`,
				session,
				`project:  ${snap?.projectKey ?? "(resolving)"}`,
				`inbox:    ${s.inbox} pending`,
				`dream:    ${d.running ? `running (${d.running.id})` : `${d.due.due ? "due" : "not due"} (${d.due.reason})`}`,
				`last:     ${d.last ? `${d.last.status} ${d.last.finishedAt ?? d.last.startedAt}${d.last.error ? ` — ${d.last.error}` : ""}` : "never"}`,
				`review:   ${s.review ? `${s.review.pending} to decide — ${s.url}/#/review` : "nothing to review"}`,
				`cwd:      ${ctx.cwd}`,
			].join("\n");
		} catch (err) {
			return [`server:   ${err instanceof ServerDown || err instanceof ApiError ? err.message : why(err)}`, session, `cwd:      ${ctx.cwd}`].join("\n");
		}
	}
}
