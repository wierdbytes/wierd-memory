/**
 * The HTTP API (`/api/*`, JSON). `docs/api.md` describes every route.
 *
 * The server listens on 127.0.0.1 only and has no accounts: whoever can reach
 * the port is the user. A page of another site open in the browser must not
 * be: requests that change something need a JSON body type and, when the
 * browser names an origin, that origin must be this server.
 */

import type { DreamSubmit, EvidenceRef, InboxInput, NoteCreate, NoteEdit, NotePatch, RunInfo } from "@wierd-memory/core";
import { GLOBAL_SCOPE, INBOX_KINDS, oneOf, projectScope, renderReport, resolveProject, defaultPrompt, PROMPT_NAMES, DEFAULT_GLOBAL_CHARTER, DEFAULT_PROJECT_CHARTER } from "@wierd-memory/core";
import { type App, bad, HttpError, notFound, scopeShortName } from "./app.ts";
import { MAIN } from "./git.ts";
import { importPiDreamState } from "./importer.ts";

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Ctx {
	app: App;
	req: Request;
	url: URL;
	params: Record<string, string>;
	q: URLSearchParams;
	/** Which client this is (`web`, `herdr`, `cli`, `pi`): goes into commit messages. */
	actor: string;
	body: <T = Record<string, unknown>>() => Promise<T>;
}

interface Route {
	method: string;
	parts: string[];
	handler: Handler;
}

const routes: Route[] = [];
const route = (method: string, path: string, handler: Handler) => routes.push({ method, parts: path.split("/").filter(Boolean), handler });

function match(r: Route, method: string, parts: string[]): Record<string, string> | undefined {
	if (r.method !== method || r.parts.length !== parts.length) return undefined;
	const params: Record<string, string> = {};
	for (let i = 0; i < parts.length; i++) {
		const p = r.parts[i];
		if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(parts[i]);
		else if (p !== parts[i]) return undefined;
	}
	return params;
}

const int = (v: string | null, fallback: number, min: number, max: number) => {
	const n = Number(v);
	return v !== null && v !== "" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

// ── status, live updates ─────────────────────────────────────────────────

route("GET", "/api/status", ({ app }) => app.status());

route("GET", "/api/wait", async ({ app, q }) => ({ rev: await app.wait(int(q.get("rev"), 0, 0, Number.MAX_SAFE_INTEGER), int(q.get("timeout"), 25, 1, 55) * 1000) }));

route("GET", "/api/events", ({ app, req }) => {
	let off = () => {};
	let ping: ReturnType<typeof setInterval> | undefined;
	const stream = new ReadableStream({
		start(controller) {
			const enc = new TextEncoder();
			const send = (data: unknown) => {
				try {
					controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					// closed
				}
			};
			send({ rev: app.rev, kind: "hello" });
			off = app.subscribe(send);
			ping = setInterval(() => {
				try {
					controller.enqueue(enc.encode(": ping\n\n"));
				} catch {
					// closed
				}
			}, 20_000);
			req.signal.addEventListener("abort", () => {
				off();
				if (ping) clearInterval(ping);
				try {
					controller.close();
				} catch {
					// closed
				}
			});
		},
		cancel() {
			off();
			if (ping) clearInterval(ping);
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
});

// ── a session's context ──────────────────────────────────────────────────

route("GET", "/api/context", ({ app, q }) => {
	const cwd = q.get("cwd");
	if (!cwd) throw bad("cwd is required");
	return app.context(cwd);
});

// ── scopes, notes ────────────────────────────────────────────────────────

route("GET", "/api/scopes", ({ app }) => app.scopesInfo());

route("PUT", "/api/scopes/:id/charter", async ({ app, params, body, actor }) => {
	const b = await body<{ charter?: string | null }>();
	await app.setCharter(params.id, b.charter ?? null, actor);
	return { ok: true };
});

route("GET", "/api/notes", async ({ app, q }) => {
	let ref = MAIN;
	if (q.get("ref") === "review") ref = (await app.state.openReview())?.branch ?? MAIN;
	let notes = await app.views(ref);
	const scope = q.get("scope");
	if (scope) notes = notes.filter((n) => n.scope === scope);
	const status = q.get("status");
	if (status) notes = notes.filter((n) => n.status === status);
	return { notes };
});

route("POST", "/api/notes", async ({ app, body, actor }) => app.createNote(await body<NoteCreate>(), actor));
route("GET", "/api/notes/:id", ({ app, params }) => app.view(params.id));
route("PATCH", "/api/notes/:id", async ({ app, params, body, actor }) => app.patchNote(params.id, await body<NotePatch>(), actor));
route("DELETE", "/api/notes/:id", async ({ app, params, actor }) => {
	await app.deleteNote(params.id, actor);
	return { ok: true };
});
route("GET", "/api/notes/:id/history", ({ app, params }) => app.noteHistory(params.id));
route("POST", "/api/notes/:id/restore", async ({ app, params, body, actor }) => {
	const b = await body<{ commit?: string }>();
	if (!b.commit) throw bad("commit is required");
	return app.restoreNote(params.id, b.commit, actor);
});

// ── search, reading, evidence ────────────────────────────────────────────

route("GET", "/api/search", ({ app, q }) => {
	const query = q.get("q")?.trim();
	if (!query) throw bad("q is required");
	const scope = q.get("scope");
	const projects = q.get("projects");
	return app.searcher.search({
		query,
		scope: scope === "notes" || scope === "sessions" ? scope : "all",
		projects: projects === "all" ? "all" : "current",
		cwd: q.get("cwd") ?? undefined,
		limit: int(q.get("limit"), 6, 1, 30),
		excludeSession: q.get("exclude") ?? undefined,
		includeOff: q.get("off") === "1",
	});
});

route("GET", "/api/read", async ({ app, q }) => {
	const ref = q.get("ref");
	if (!ref) throw bad("ref is required");
	return { text: await app.searcher.read(ref) };
});

route("POST", "/api/evidence", async ({ app, body }) => {
	const b = await body<{ refs?: EvidenceRef[] }>();
	return app.searcher.evidence(Array.isArray(b.refs) ? b.refs.slice(0, 200) : []);
});

// ── inbox ────────────────────────────────────────────────────────────────

async function inboxView(app: App, status: "pending" | "done" | "dismissed" | "all") {
	const items = await app.state.inbox(status);
	return items.map((i) => ({
		...i,
		scopeId: i.scope === "global" ? GLOBAL_SCOPE : i.projectKey ? projectScope(i.projectKey) : null,
		projectName: i.projectKey ? scopeShortName(i.projectKey) : null,
	}));
}

route("GET", "/api/inbox", ({ app, q }) => {
	const s = q.get("status");
	return inboxView(app, s === "done" || s === "dismissed" || s === "all" ? s : "pending");
});

route("POST", "/api/inbox", async ({ app, body, actor }) => {
	const b = await body<InboxInput>();
	const text = typeof b.text === "string" ? b.text.trim() : "";
	if (!text) throw bad("text is required");
	const cwd = typeof b.cwd === "string" ? b.cwd : "";
	const proj = cwd ? await resolveProject(cwd) : undefined;
	const item = await app.state.addInbox({
		source: b.source === "agent" || (b.source === undefined && actor === "pi") ? "agent" : "user",
		text,
		kind: oneOf(INBOX_KINDS, b.kind) ? b.kind : undefined,
		scope: b.scope === "global" || b.scope === "project" ? b.scope : cwd ? undefined : "global",
		cwd,
		projectKey: proj?.key ?? "",
		sessionId: b.sessionId,
		sessionFile: b.sessionFile,
		entryId: b.entryId,
	});
	app.bump("inbox");
	return item;
});

route("DELETE", "/api/inbox/:id", async ({ app, params }) => {
	if (!(await app.state.inboxItem(params.id))) throw notFound(`inbox item ${params.id}`);
	await app.state.setInboxStatus([params.id], "dismissed");
	app.bump("inbox");
	return { ok: true };
});

// ── review ───────────────────────────────────────────────────────────────

route("GET", "/api/review", ({ app }) => app.reviews.view());
route("GET", "/api/reviews", ({ app, q }) => app.reviews.list(int(q.get("limit"), 50, 1, 500)));
route("GET", "/api/reviews/:id", ({ app, params }) => app.reviews.view(params.id));

route("POST", "/api/reviews/:id/accept", async ({ app, params, body, actor }) => {
	const b = await body<{ keys?: string[]; edit?: NoteEdit }>();
	return app.reviews.accept(params.id, Array.isArray(b.keys) ? b.keys : undefined, b.edit, actor);
});

route("POST", "/api/reviews/:id/reject", async ({ app, params, body, actor }) => {
	const b = await body<{ keys?: string[]; reason?: string }>();
	return app.reviews.reject(params.id, Array.isArray(b.keys) ? b.keys : undefined, typeof b.reason === "string" ? b.reason : undefined, actor);
});

route("POST", "/api/reviews/:id/close", ({ app, params, actor }) => app.reviews.close(params.id, actor));

route("POST", "/api/reviews/:id/comments", async ({ app, params, body, actor }) => {
	const b = await body<{ body?: string; noteId?: string }>();
	return app.reviews.comment(params.id, String(b.body ?? ""), b.noteId || undefined, actor);
});

route("DELETE", "/api/reviews/:id/comments/:cid", ({ app, params }) => app.reviews.removeComment(params.id, params.cid));

route("POST", "/api/agents/:id/apply", async ({ app, params, body }) => {
	const b = await body<{ edits?: Array<{ old: string; new: string }> }>();
	await app.reviews.applyAgents(params.id, Array.isArray(b.edits) ? b.edits : undefined);
	return app.reviews.view().catch(() => null);
});

route("POST", "/api/agents/:id/reject", async ({ app, params }) => {
	await app.reviews.rejectAgents(params.id);
	return app.reviews.view().catch(() => null);
});

// ── dreams ───────────────────────────────────────────────────────────────

route("GET", "/api/dreams", ({ app, q }) => app.dreams.status(int(q.get("limit"), 30, 1, 500)));

route("POST", "/api/dreams", async ({ app, body, actor }) => {
	const b = await body<{ mode?: string; sinceDays?: number; maxSessions?: number }>();
	const kind = (b.mode ?? "run") as RunInfo["kind"];
	const opts: { sinceDays?: number; maxSessions?: number } = {};
	if (typeof b.sinceDays === "number" && Number.isFinite(b.sinceDays)) opts.sinceDays = b.sinceDays;
	if (typeof b.maxSessions === "number" && b.maxSessions > 0) opts.maxSessions = Math.round(b.maxSessions);
	return app.dreams.start(kind, opts, actor === "pi" ? "agent" : "user");
});

route("GET", "/api/dreams/:id", async ({ app, params, q }) => {
	const run = await app.state.run(params.id);
	if (!run) throw notFound(`run ${params.id}`);
	if (q.get("format") === "md") return new Response(run.report ? renderReport(run.report) : "no report\n", { headers: { "content-type": "text/markdown; charset=utf-8" } });
	return run;
});

route("GET", "/api/dreams/:id/log", ({ app, params, q }) => new Response(app.dreams.logTail(params.id, int(q.get("tail"), 200, 1, 100_000)), { headers: { "content-type": "text/plain; charset=utf-8" } }));

route("POST", "/api/dreams/:id/cancel", async ({ app, params }) => {
	await app.dreams.cancel(params.id);
	return { ok: true };
});

// The dream runner's side.
route("POST", "/api/dream/begin", async ({ app, body }) => {
	const b = await body<{ mode?: string; sinceDays?: number; maxSessions?: number; pid?: number }>();
	const opts: { sinceDays?: number; maxSessions?: number } = {};
	if (typeof b.sinceDays === "number" && Number.isFinite(b.sinceDays)) opts.sinceDays = b.sinceDays;
	if (typeof b.maxSessions === "number" && b.maxSessions > 0) opts.maxSessions = Math.round(b.maxSessions);
	return app.dreams.begin((b.mode ?? "run") as RunInfo["kind"], opts, typeof b.pid === "number" ? b.pid : undefined);
});

route("GET", "/api/dream/workspace", ({ app, q }) => {
	const run = q.get("run");
	if (!run) throw bad("run is required");
	return app.dreams.workspace(run);
});

route("POST", "/api/dream/submit", async ({ app, body }) => app.reviews.submit(await body<DreamSubmit>()));

route("POST", "/api/dream/fail", async ({ app, body }) => {
	const b = await body<{ runId?: string; error?: string }>();
	if (!b.runId) throw bad("runId is required");
	await app.dreams.fail(b.runId, String(b.error ?? "failed"));
	return { ok: true };
});

// ── history ──────────────────────────────────────────────────────────────

route("GET", "/api/history", ({ app, q }) => app.history(int(q.get("limit"), 100, 1, 2000)));

route("GET", "/api/history/:hash", async ({ app, params }) => ({ changes: await app.mem.commitChanges(params.hash) }));

// ── settings ─────────────────────────────────────────────────────────────

route("GET", "/api/config", ({ app }) => app.cfg);
route("PUT", "/api/config", async ({ app, body }) => app.updateConfig(await body()));

route("GET", "/api/prompts", async ({ app }) => {
	const overrides = await app.mem.prompts(MAIN);
	return {
		prompts: PROMPT_NAMES.map((name) => ({ name, default: defaultPrompt(name), override: overrides[name] ?? null })),
		charters: { global: DEFAULT_GLOBAL_CHARTER, project: DEFAULT_PROJECT_CHARTER, projectOverride: overrides.project_charter ?? null },
	};
});

route("PUT", "/api/prompts/:name", async ({ app, params, body, actor }) => {
	const b = await body<{ body?: string | null }>();
	await app.setPrompt(params.name, b.body ?? null, actor);
	return { ok: true };
});

route("GET", "/api/skills", ({ app }) => app.mem.skills(MAIN));

route("DELETE", "/api/skills", async ({ app, q, actor }) => {
	const scope = q.get("scope");
	const name = q.get("name");
	if (!scope || !name) throw bad("scope and name are required");
	await app.deleteSkill(scope, name, actor);
	return { ok: true };
});

route("POST", "/api/sync", async ({ app }) => ({ message: await app.sync() }));

route("POST", "/api/import", async ({ app, body }) => {
	const b = await body<{ from?: string }>();
	return importPiDreamState(app, { from: b.from });
});

// ── dispatch ─────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data ?? null), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function sameOrigin(req: Request, url: URL): boolean {
	const origin = req.headers.get("origin");
	if (!origin) return true; // not a browser (curl, pi, the Herdr mod)
	try {
		const o = new URL(origin);
		return ["127.0.0.1", "localhost", "[::1]"].includes(o.hostname) && o.port === url.port;
	} catch {
		return false;
	}
}

export async function handleApi(app: App, req: Request): Promise<Response> {
	const url = new URL(req.url);
	const parts = url.pathname.split("/").filter(Boolean);
	const method = req.method.toUpperCase();
	try {
		if (method !== "GET" && method !== "HEAD") {
			if (!sameOrigin(req, url)) throw new HttpError(403, "cross-origin requests are not allowed");
			const type = req.headers.get("content-type") ?? "";
			const hasBody = Number(req.headers.get("content-length") ?? "0") > 0;
			if (hasBody && !type.includes("application/json")) throw new HttpError(415, "send JSON (content-type: application/json)");
		}
		for (const r of routes) {
			const params = match(r, method, parts);
			if (!params) continue;
			let parsed: unknown;
			const ctx: Ctx = {
				app,
				req,
				url,
				params,
				q: url.searchParams,
				actor: (req.headers.get("x-wmem-client") ?? "").replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 40),
				body: async <T>() => {
					if (parsed === undefined) {
						const text = await req.text();
						try {
							parsed = text.trim() ? JSON.parse(text) : {};
						} catch {
							throw bad("the body is not valid JSON");
						}
						if (!parsed || typeof parsed !== "object") throw bad("the body must be a JSON object");
					}
					return parsed as T;
				},
			};
			const out = await r.handler(ctx);
			return out instanceof Response ? out : json(out);
		}
		throw new HttpError(404, `no route ${method} ${url.pathname}`);
	} catch (err) {
		if (err instanceof HttpError) return json({ error: err.message }, err.status);
		const message = err instanceof Error ? err.message : String(err);
		app.log(`${method} ${url.pathname}: ${err instanceof Error ? (err.stack ?? message) : message}`);
		return json({ error: message }, 500);
	}
}
