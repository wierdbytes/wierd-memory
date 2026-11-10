/**
 * The server on a real git repository: hand edits, a dream's proposals, a
 * review decided item by item, the review branch kept in step with the
 * approved one, a remote. Needs `git` on PATH.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyOp,
	type DreamSubmit,
	type DreamWorkspace,
	type Evidence,
	type Op,
	type ReportData,
	type ReportItem,
	type ReviewView,
	type StatusInfo,
	today,
	Workspace,
} from "@wierd-memory/core";
import { App } from "../src/app.ts";
import { handleApi } from "../src/http.ts";
import { parseNote } from "../src/notefile.ts";

let app: App;
let home: string;
/** The memory repository of the server under test. */
let memDir: string;
// An identity of its own: the commits the tests make with git must not depend on the machine's git config (CI has none).
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, ...GIT_ENV } }).trim();
const ev: Evidence[] = [{ s: "01a1b2c3-0000-7000-8000-000000000001", e: ["aaaa1111"], date: "2026-11-06", kind: "user" }];

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
	const res = await handleApi(
		app,
		new Request(`http://127.0.0.1:${app.cfg.port}${path}`, {
			method,
			headers: { "x-wmem-client": "test", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		}),
	);
	const text = await res.text();
	let data: unknown = text;
	try {
		data = JSON.parse(text);
	} catch {
		// plain text
	}
	return { status: res.status, data: data as T };
}

function report(runId: string, items: ReportItem[] = []): ReportData {
	return {
		runId,
		date: today(),
		language: "Russian",
		models: { cards: "a/b", analyze: "a/c", verify: "a/d" },
		usage: { analyze: { calls: 1, input: 10, output: 5, cacheRead: 0, cost: 0.12, failures: 0 } },
		sessions: [{ sessionId: ev[0].s, date: "2026-11-06", project: "o/r", title: "A session", outcome: "success", learnings: 2 }],
		sessionTitles: { [ev[0].s]: "A session" },
		inbox: 0,
		feedback: 0,
		unhandled: [],
		items,
		rejected: [{ ref: "op9", op: "add", title: "Something the check threw out", reason: "unsupported — not in the transcript" }],
		agents: [],
		indexes: [],
		votes: 0,
		problems: [],
		scopeTitles: { global: "global" },
	};
}

/** What a dream would hand in after applying `ops` to the workspace the server gave it. */
async function dream(ops: Op[], extra: Partial<DreamSubmit> = {}, during?: (ws: DreamWorkspace) => Promise<void>): Promise<{ runId: string; result: { status: string; reviewId?: string; items?: number }; ids: Record<string, string> }> {
	const run = (await call<{ id: string }>("POST", "/api/dream/begin", { mode: "run" })).data;
	const wsData = (await call<DreamWorkspace>("GET", `/api/dream/workspace?run=${run.id}`)).data;
	const ws = new Workspace(wsData.notes, today(), { pending: wsData.pending, scopes: wsData.scopes });
	const items: ReportItem[] = [];
	const ids: Record<string, string> = {};
	for (const op of ops) {
		const res = applyOp(ws, op, { evidence: ev, projectScope: "projects/github.com__o__r" });
		if (!res.ok) throw new Error(`${op.ref}: ${res.reason}`);
		const c = res.change;
		ids[op.ref] = c.newId ?? c.noteId ?? "";
		items.push({ kind: c.kind, scope: c.scope, id: c.newId ?? c.noteId, title: c.title, evidence: ev, why: [`because ${op.ref}`], check: { verdict: "supported", reason: "", corrected: false }, risky: [], old: c.kind === "superseded" ? { id: c.noteId, title: "old" } : undefined });
	}
	if (during) await during(wsData);
	const sub: DreamSubmit = { runId: run.id, status: "ok", changes: ws.changes(), votes: {}, report: report(run.id, items), marks: {}, inboxDone: [], commentsDone: [], agents: [], sessions: 1, cost: 0.12, ...extra };
	const r = await call<{ status: string; reviewId?: string; items?: number }>("POST", "/api/dream/submit", sub);
	if (r.status !== 200) throw new Error(JSON.stringify(r.data));
	return { runId: run.id, result: r.data, ids };
}

const review = async () => (await call<ReviewView | null>("GET", "/api/review")).data;
const kinds = (v: ReviewView | null) => (v?.items ?? []).map((i) => `${i.kind}:${i.note.title}`).sort();

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "wmem-test-"));
	writeFileSync(join(home, "config.json"), JSON.stringify({ port: 17533 }));
	app = await App.start({ home, noSchedule: true, log: () => {} });
	memDir = join(home, "memory");
}, 60_000);

afterAll(async () => {
	await app?.stop();
	rmSync(home, { recursive: true, force: true });
});

describe("approved memory by hand", () => {
	let a = "";
	let b = "";
	let c = "";

	it("adds notes, each as a commit", async () => {
		a = (await call<{ id: string }>("POST", "/api/notes", { scope: "global", title: "Отвечать по-русски", body: "Всегда.", type: "preference", index: "always" })).data.id;
		b = (await call<{ id: string }>("POST", "/api/notes", { scope: "global", title: "Dotfiles живут в chezmoi", body: "chezmoi apply", index: "pointer", when: "правка dotfiles" })).data.id;
		c = (await call<{ id: string }>("POST", "/api/notes", { scope: "projects/github.com__o__r", title: "Тесты запускаются через make test", body: "make test", index: "always" })).data.id;
		expect(a).toMatch(/^m-[0-9a-f]{6}$/);
		const log = (await call<Array<{ message: string; author: string }>>("GET", "/api/history?limit=3")).data;
		expect(log[0].message).toContain(`add ${c}`);
		expect(log[0].message).toContain("via test");
		const scopes = (await call<Array<{ id: string; name: string; counts: { active: number }; index: { ids: string[] } }>>("GET", "/api/scopes")).data;
		expect(scopes.map((s) => [s.name, s.counts.active])).toEqual([["Global", 2], ["r", 1]]);
		expect(scopes[0].index.ids).toEqual([a, b]);
	});

	it("gives a session its memory section", async () => {
		const ctx = (await call<{ injection: { text: string; ids: string[]; memver: string }; scope: string | null }>("GET", `/api/context?cwd=${encodeURIComponent(home)}`)).data;
		expect(ctx.injection.text).toContain(`- Отвечать по-русски [${a}]`);
		expect(ctx.injection.text).toContain(`- правка dotfiles → [${b}] Dotfiles живут в chezmoi`);
		expect(ctx.injection.ids).toEqual([a, b]);
		expect(ctx.injection.memver).toHaveLength(8);
	});

	it("turns a note off and on: agents do not see it meanwhile", async () => {
		const off = (await call<{ reach: string; enabled: boolean }>("PATCH", `/api/notes/${a}`, { enabled: false })).data;
		expect([off.reach, off.enabled]).toEqual(["off", false]);
		const ctx = (await call<{ injection: { text: string } }>("GET", `/api/context?cwd=${encodeURIComponent(home)}`)).data;
		expect(ctx.injection.text).not.toContain("Отвечать по-русски");
		expect((await call<{ notes: unknown[] }>("GET", "/api/search?q=русски&scope=notes&projects=all")).data.notes).toEqual([]);
		expect((await call<{ notes: unknown[] }>("GET", "/api/search?q=русски&scope=notes&projects=all&off=1")).data.notes.length).toBe(1);
		expect((await call<{ text: string }>("GET", `/api/read?ref=${a}`)).data.text).toContain("turned off by the user");
		const on = (await call<{ reach: string }>("PATCH", `/api/notes/${a}`, { enabled: true })).data;
		expect(on.reach).toBe("always");
		expect((await call<{ text: string }>("GET", `/api/read?ref=${a}`)).data.text).toContain("Отвечать по-русски");
	});

	it("edits, keeps history, restores an old version", async () => {
		const edited = (await call<{ title: string; evidence: Evidence[]; updated: string }>("PATCH", `/api/notes/${b}`, { title: "Dotfiles живут в chezmoi, без автокоммита", body: "chezmoi apply; коммит руками" })).data;
		expect(edited.title).toContain("без автокоммита");
		expect(edited.evidence.filter((e) => e.s === "manual").length).toBe(1);
		const hist = (await call<Array<{ commit: string; type: string; changes: Record<string, unknown[]>; message: string }>>("GET", `/api/notes/${b}/history`)).data;
		expect(hist.length).toBe(2);
		expect(hist[0].type).toBe("modified");
		expect(Object.keys(hist[0].changes)).toEqual(expect.arrayContaining(["title", "body"]));
		expect(hist[1].type).toBe("added");
		const restored = (await call<{ title: string }>("POST", `/api/notes/${b}/restore`, { commit: hist[1].commit })).data;
		expect(restored.title).toBe("Dotfiles живут в chezmoi");
		expect((await call("PATCH", "/api/notes/m-ffffff", { title: "x" })).status).toBe(404);
	});

	it("refuses cross-origin and non-JSON writes", async () => {
		expect((await call("POST", "/api/notes", { scope: "global", title: "evil" }, { origin: "https://evil.example" })).status).toBe(403);
		const res = await handleApi(app, new Request(`http://127.0.0.1:${app.cfg.port}/api/notes`, { method: "POST", headers: { "content-type": "text/plain", "content-length": "5" }, body: "title" }));
		expect(res.status).toBe(415);
		expect((await call("POST", "/api/notes", { scope: "global", title: "fine" }, { origin: `http://127.0.0.1:${app.cfg.port}` })).status).toBe(200);
	});

	it("keeps an inbox", async () => {
		const item = (await call<{ id: string }>("POST", "/api/inbox", { text: "Запомни: деплой только по пятницам", cwd: home, source: "user" })).data;
		expect((await call<Array<{ id: string }>>("GET", "/api/inbox")).data.map((i) => i.id)).toEqual([item.id]);
		expect((await call<StatusInfo>("GET", "/api/status")).data.inbox).toBe(1);
		await call("DELETE", `/api/inbox/${item.id}`);
		expect((await call<unknown[]>("GET", "/api/inbox")).data).toEqual([]);
	});
});

describe("a dream's proposals go to review", () => {
	let reviewId = "";
	let ids: Record<string, string> = {};
	let main: Array<{ id: string; title: string; body: string; status: string; scope: string }> = [];
	const byTitle = (t: string) => main.find((n) => n.title.startsWith(t));
	const loadMain = async () => {
		main = (await call<{ notes: typeof main }>("GET", "/api/notes")).data.notes;
	};

	it("nothing reaches approved memory before a decision", async () => {
		await loadMain();
		const dot = byTitle("Dotfiles") as { id: string };
		const tests = byTitle("Тесты") as { id: string };
		const before = (await call<StatusInfo>("GET", "/api/status")).data;
		const d = await dream([
			{ op: "add", ref: "new1", scope: "global", type: "pitfall", title: "Не запускать find от корня", body: "Долго и шумно.", index: "always", rationale: "", evidence: [] },
			{ op: "add", ref: "new2", scope: "project", type: "fact", title: "CI гоняет линтер отдельно", body: "job lint", index: "none", rationale: "", evidence: [] },
			{ op: "update", ref: "upd", id: dot.id, body: "chezmoi apply -v", rationale: "", evidence: [] },
			{ op: "supersede", ref: "sup", id: tests.id, replacement: { title: "Тесты запускаются через bun test", body: "bun test" }, rationale: "", evidence: [] },
		]);
		ids = d.ids;
		reviewId = d.result.reviewId as string;
		expect(d.result).toMatchObject({ status: "ok", items: 4 });
		const after = (await call<StatusInfo>("GET", "/api/status")).data;
		expect(after.memver).toBe(before.memver);
		expect(after.notes.active).toBe(before.notes.active);
		expect(after.review?.pending).toBe(4);
		const v = (await review()) as ReviewView;
		expect(v.id).toBe(reviewId);
		expect(kinds(v)).toEqual(["added:CI гоняет линтер отдельно", "added:Не запускать find от корня", "superseded:Тесты запускаются через bun test", "updated:Dotfiles живут в chezmoi"]);
		const upd = v.items.find((i) => i.kind === "updated");
		expect(upd?.fields).toEqual(expect.arrayContaining(["body"]));
		expect(upd?.before?.body).toBe("chezmoi apply");
		expect(upd?.why).toEqual(["because upd"]);
		expect(upd?.check?.verdict).toBe("supported");
		expect(v.items.find((i) => i.kind === "superseded")?.ids.length).toBe(2);
		expect(v.items.find((i) => i.note.title.startsWith("Не запускать"))?.reach).toBe("always");
		expect(v.rejectedByCheck.length).toBe(1);
		expect(v.sessionTitles[ev[0].s]).toBe("A session");
		// agents still get the approved version
		const ctx = (await call<{ injection: { text: string } }>("GET", `/api/context?cwd=${encodeURIComponent(home)}`)).data;
		expect(ctx.injection.text).not.toContain("find от корня");
	});

	it("hand edits of approved memory flow into the open review", async () => {
		const dot = byTitle("Dotfiles") as { id: string };
		const ru = byTitle("Отвечать") as { id: string };
		// a note the review does not touch
		await call("PATCH", `/api/notes/${ru.id}`, { title: "Отвечать по-русски, коротко" });
		// another column of a note the review does touch
		await call("PATCH", `/api/notes/${dot.id}`, { when: "любая правка dotfiles", pinned: true });
		const v = (await review()) as ReviewView;
		expect(v.items.length).toBe(4);
		const upd = v.items.find((i) => i.kind === "updated");
		expect(upd?.fields.filter((f) => f !== "updated" && f !== "evidence")).toEqual(["body"]);
		expect([upd?.note.when, upd?.note.pinned, upd?.note.body]).toEqual(["любая правка dotfiles", true, "chezmoi apply -v"]);
		const proposed = (await call<{ notes: Array<{ id: string; title: string }> }>("GET", "/api/notes?ref=review")).data.notes;
		expect(proposed.find((n) => n.id === ru.id)?.title).toBe("Отвечать по-русски, коротко");
	});

	it("accepts one item after editing it", async () => {
		const r = await call<ReviewView>("POST", `/api/reviews/${reviewId}/accept`, { keys: [`note:${ids.new1}`], edit: { title: "Никогда не запускать find/grep от корня", index: "pointer", when: "поиск по диску" } });
		expect(r.status).toBe(200);
		expect(r.data.pending).toBe(3);
		expect(r.data.decisions.map((d) => [d.decision, d.noteId])).toEqual([["edited", ids.new1]]);
		const n = (await call<{ title: string; index: string; reach: string; evidence: Evidence[] }>("GET", `/api/notes/${ids.new1}`)).data;
		expect([n.title, n.index, n.reach]).toEqual(["Никогда не запускать find/grep от корня", "pointer", "pointer"]);
		expect(n.evidence.some((e) => e.s === `review:${reviewId}` && e.kind === "reviewer")).toBe(true);
		const log = (await call<Array<{ message: string }>>("GET", "/api/history?limit=1")).data;
		expect(log[0].message).toContain(`accept added ${ids.new1}`);
		expect(log[0].message).toContain(`review ${reviewId}`);
	});

	it("rejects one item: it leaves the review and is remembered as rejected", async () => {
		const r = await call<ReviewView>("POST", `/api/reviews/${reviewId}/reject`, { keys: [`note:${ids.sup}`], reason: "make test is right" });
		expect(r.data.pending).toBe(2);
		await loadMain();
		expect(byTitle("Тесты запускаются через make test")?.status).toBe("active");
		expect(main.some((n) => n.id === ids.sup)).toBe(false);
		expect(await app.state.rejectedTitles()).toEqual(["Тесты запускаются через bun test"]);
		expect((await call("POST", `/api/reviews/${reviewId}/reject`, { keys: [`note:${ids.sup}`] })).status).toBe(404);
	});

	it("a later dream adds to the open review and sees what is pending", async () => {
		const d = await dream([
			{ op: "add", ref: "new3", scope: "global", type: "fact", title: "Сессии pi лежат в ~/.pi/agent/sessions", body: "", index: "none", rationale: "", evidence: [] },
			// the pending note of the first dream, changed by the second one
			{ op: "update", ref: "upd2", id: ids.new2, body: "job lint, отдельный workflow", rationale: "", evidence: [] },
		]);
		expect(d.result.reviewId).toBe(reviewId);
		const v = (await review()) as ReviewView;
		expect(v.runs.length).toBe(2);
		expect(kinds(v)).toEqual(["added:CI гоняет линтер отдельно", "added:Сессии pi лежат в ~/.pi/agent/sessions", "updated:Dotfiles живут в chezmoi"]);
		const pending = v.items.find((i) => i.note.id === ids.new2);
		expect(pending?.note.body).toBe("job lint, отдельный workflow");
		expect(pending?.why).toEqual(["because new2", "because upd2"]);
		expect(pending?.runs.length).toBe(2);
	});

	it("what the reviewer decides while a dream runs is not undone by it", async () => {
		const d = await dream([{ op: "update", ref: "upd3", id: ids.new2, title: "CI гоняет линтер отдельным job", rationale: "", evidence: [] }], {}, async () => {
			await call("POST", `/api/reviews/${reviewId}/reject`, { keys: [`note:${ids.new2}`] });
		});
		expect(d.result.reviewId).toBe(reviewId);
		expect(kinds(await review())).toEqual(["added:Сессии pi лежат в ~/.pi/agent/sessions", "updated:Dotfiles живут в chezmoi"]);
	});

	it("keeps comments for the next dream", async () => {
		const dot = byTitle("Dotfiles") as { id: string };
		const v = (await call<ReviewView>("POST", `/api/reviews/${reviewId}/comments`, { body: "перенеси в проект chezmoi", noteId: dot.id })).data;
		expect(v.comments.length).toBe(1);
		const run = (await call<{ id: string }>("POST", "/api/dream/begin", { mode: "review" })).data;
		const ws = (await call<DreamWorkspace>("GET", `/api/dream/workspace?run=${run.id}`)).data;
		expect(ws.review?.comments.map((c) => c.body)).toEqual(["перенеси в проект chezmoi"]);
		expect(ws.pending.length).toBe(1);
		expect(ws.state.rejected.length).toBe(2);
		const sub: DreamSubmit = { runId: run.id, status: "noop", changes: { notes: [], removed: [], scopes: [], skills: [] }, votes: {}, report: report(run.id), marks: {}, inboxDone: [], commentsDone: [{ id: ws.review?.comments[0].id as string, unhandled: "no such project" }], agents: [], sessions: 0, cost: 0 };
		expect((await call<{ status: string }>("POST", "/api/dream/submit", sub)).data.status).toBe("noop");
		const after = (await review()) as ReviewView;
		expect(after.comments[0].unhandled).toBe("no such project");
		expect(after.warnings.some((w) => w.includes("no such project"))).toBe(true);
	});

	it("accepting the rest closes the review and removes its branch", async () => {
		const r = await call<ReviewView>("POST", `/api/reviews/${reviewId}/accept`, {});
		expect(r.data.status).toBe("merged");
		expect([r.data.pending, r.data.accepted, r.data.rejected]).toEqual([0, 3, 2]);
		expect(await review()).toBeNull();
		expect(await app.repo.branches()).toEqual([]);
		await loadMain();
		expect(byTitle("Dotfiles")?.body).toBe("chezmoi apply -v");
		expect(byTitle("Сессии pi")).toBeTruthy();
		const list = (await call<Array<{ id: string; status: string }>>("GET", "/api/reviews")).data;
		expect(list.map((x) => [x.id, x.status])).toEqual([[reviewId, "merged"]]);
		const closed = (await call<ReviewView>("GET", `/api/reviews/${reviewId}`)).data;
		expect(closed.decisions.length).toBe(5);
		expect((await call("POST", `/api/reviews/${reviewId}/accept`, {})).status).toBe(409);
	});

	it("a review closed without accepting anything rejects what it held", async () => {
		const d = await dream([{ op: "add", ref: "n", scope: "global", type: "fact", title: "Совсем лишняя заметка", body: "", index: "none", rationale: "", evidence: [] }]);
		expect(d.result.reviewId).not.toBe(reviewId);
		const r = await call<ReviewView>("POST", `/api/reviews/${d.result.reviewId}/close`, {});
		expect(r.data.status).toBe("closed");
		expect(await app.state.rejectedTitles()).toContain("Совсем лишняя заметка");
		expect(await app.repo.branches()).toEqual([]);
	});

	it("votes, session marks and inbox are taken even when nothing is proposed", async () => {
		const item = (await call<{ id: string }>("POST", "/api/inbox", { text: "x", cwd: home })).data;
		const dot = byTitle("Dotfiles") as { id: string };
		const d = await dream([], { status: "noop", votes: { [dot.id]: { helpful: 2, harmful: 0 } }, marks: { "/s/1.jsonl": { size: 5, mtimeMs: 1, at: "2026-11-09T00:00:00Z", ok: true, failures: 0 } }, inboxDone: [item.id] });
		expect(d.result.status).toBe("noop");
		expect((await app.state.stats()).get(dot.id)).toEqual({ helpful: 2, harmful: 0 });
		expect(Object.keys(await app.state.marks())).toEqual(["/s/1.jsonl"]);
		expect(await app.state.inbox("pending")).toEqual([]);
		expect(await review()).toBeNull();
		const dreams = (await call<{ runs: Array<{ status: string }>; running: unknown }>("GET", "/api/dreams")).data;
		expect(dreams.running).toBeNull();
		expect(dreams.runs[0].status).toBe("noop");
	});

	it("proposes skills and AGENTS.md edits through the same review", async () => {
		const repo = join(home, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(repo, "AGENTS.md"), "# Repo\n\nRun make test.\n");
		const d = await dream([{ op: "skill", ref: "sk", scope: "global", name: "release-it", description: "How to release", body: "1. bump\n2. tag", rationale: "", evidence: [] }], {
			agents: [{ projectKey: "github.com/o/r", repoRoot: repo, rel: "AGENTS.md", summary: "tests run with bun", edits: [{ old: "Run make test.", new: "Run bun test." }], rationale: ["seen twice"] }],
		});
		const v = (await call<ReviewView>("GET", `/api/reviews/${d.result.reviewId}`)).data;
		expect(v.items.map((i) => [i.kind, i.key])).toEqual([["skill", "skill:global/release-it"]]);
		expect(v.agents.map((a) => [a.status, a.rel])).toEqual([["pending", "AGENTS.md"]]);
		expect(v.pending).toBe(2);
		await call("POST", `/api/reviews/${v.id}/accept`, { keys: ["skill:global/release-it"] });
		expect(readFileSync(join(memDir, "scopes", "global", "skills", "release-it", "SKILL.md"), "utf-8")).toContain("description: \"How to release\"");
		const ctx = (await call<{ skills: string[] }>("GET", `/api/context?cwd=${encodeURIComponent(home)}`)).data;
		expect(ctx.skills).toEqual([join(memDir, "scopes", "global", "skills")]);
		expect(((await review()) as ReviewView).status).toBe("open");
		await call("POST", `/api/agents/${v.agents[0].id}/apply`, {});
		expect(readFileSync(join(repo, "AGENTS.md"), "utf-8")).toBe("# Repo\n\nRun bun test.\n");
		expect(await review()).toBeNull();
		expect((await call<ReviewView>("GET", `/api/reviews/${v.id}`)).data.status).toBe("merged");
		await call("DELETE", "/api/skills?scope=global&name=release-it");
		expect(existsSync(join(memDir, "scopes", "global", "skills", "release-it"))).toBe(false);
	});
});

describe("dreams", () => {
	it("says so when the dream process cannot be started", async () => {
		app.cfg.dream.piCommand = "/nonexistent/pi";
		const r = await call<{ error: string }>("POST", "/api/dreams", { mode: "run" });
		expect(r.status).toBe(500);
		expect(r.data.error).toContain("could not start the dream");
		const s = (await call<{ running: unknown; runs: Array<{ status: string; error?: string }> }>("GET", "/api/dreams")).data;
		expect(s.running).toBeNull();
		expect(s.runs[0].status).toBe("error");
		expect(s.runs[0].error).toContain("could not start /nonexistent/pi");
		app.cfg.dream.piCommand = "pi";
	});

	it("re-checks whether one is due when the settings change", async () => {
		expect((await call<{ due: { reason: string } }>("GET", "/api/dreams")).data.due.reason).toBe("schedule disabled");
		await call("PUT", "/api/config", { schedule: { enabled: true, minHoursBetween: 0, minNewSessions: 1000 } });
		expect((await call<{ due: { reason: string } }>("GET", "/api/dreams")).data.due.reason).toContain("< 1000");
		await call("PUT", "/api/config", { schedule: { enabled: false, minHoursBetween: 20, minNewSessions: 3 } });
	});
});

describe("memory is a git repository", () => {
	const notesDir = () => join(memDir, "scopes", "global", "notes");
	const fileOf = async (id: string) => (await call<{ file: string }>("GET", `/api/notes/${id}`)).data.file;

	it("keeps each note as a file on the approved branch, one commit per change", async () => {
		expect(sh(memDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		expect(sh(memDir, "status", "--porcelain")).toBe("");
		const n = (await call<{ id: string; file: string }>("POST", "/api/notes", { scope: "global", title: "Коммиты подписывать не нужно", body: "Проверено.", index: "pointer", when: "коммит" })).data;
		expect(n.file).toBe(join(notesDir(), "kommity-podpisyvat-ne-nuzhno.md"));
		const text = readFileSync(n.file, "utf-8");
		expect(text).toStartWith(`---\nid: ${n.id}\ntitle: "Коммиты подписывать не нужно"\ntype: fact\nstatus: active\nindex: pointer\nwhen: "коммит"\n`);
		expect(text).toEndWith("---\n\nПроверено.\n");
		expect(sh(memDir, "log", "-1", "--format=%an|%s")).toMatch(new RegExp(`\\|add ${n.id}: Коммиты подписывать не нужно$`));
		expect(sh(memDir, "status", "--porcelain")).toBe("");
		// the file keeps its name when the title changes, and moves with the note to another scope
		await call("PATCH", `/api/notes/${n.id}`, { title: "Коммиты не подписываются" });
		expect(await fileOf(n.id)).toBe(n.file);
		await call("PATCH", `/api/notes/${n.id}`, { scope: "projects/github.com__o__r" });
		expect(await fileOf(n.id)).toBe(join(memDir, "scopes/projects/github.com__o__r/notes/kommity-podpisyvat-ne-nuzhno.md"));
		expect(existsSync(n.file)).toBe(false);
		expect(JSON.parse(readFileSync(join(memDir, "scopes/projects/github.com__o__r/scope.json"), "utf-8"))).toEqual({ key: "github.com/o/r" });
		// history follows the file across the move
		const hist = (await call<Array<{ type: string; changes: Record<string, unknown[]> }>>("GET", `/api/notes/${n.id}/history`)).data;
		expect(hist.map((h) => h.type)).toEqual(["modified", "modified", "added"]);
		expect(hist[0].changes.scope).toEqual(["global", "projects/github.com__o__r"]);
		expect(hist[1].changes.title).toEqual(["Коммиты подписывать не нужно", "Коммиты не подписываются"]);
		await call("DELETE", `/api/notes/${n.id}`);
		expect(existsSync(await fileOf(n.id).catch(() => "/nonexistent"))).toBe(false);
		// a deleted note still has its history, and can be put back
		const after = (await call<Array<{ type: string; commit: string }>>("GET", `/api/notes/${n.id}/history`)).data;
		expect(after.map((h) => h.type)).toEqual(["removed", "modified", "modified", "added"]);
		expect((await call<{ title: string }>("POST", `/api/notes/${n.id}/restore`, { commit: after[1].commit })).data.title).toBe("Коммиты не подписываются");
		const changes = (await call<{ changes: Array<{ type: string; after?: { id: string } }> }>("GET", `/api/history/${after[1].commit}`)).data.changes;
		expect(changes.map((c) => [c.type, c.after?.id])).toEqual([["modified", n.id]]);
	});

	it("takes in notes edited or written by hand in an editor", async () => {
		const ru = (await call<{ notes: Array<{ id: string; title: string; file: string }> }>("GET", "/api/notes?scope=global")).data.notes.find((n) => n.title.startsWith("Отвечать")) as { id: string; file: string };
		writeFileSync(ru.file, readFileSync(ru.file, "utf-8").replace(/\n\n[\s\S]*$/, "\n\nВсегда, даже если вопрос на английском.\n"));
		writeFileSync(join(notesDir(), "ruchnaya.md"), "---\ntitle: Написано руками в редакторе\nindex: always\ntype: preference\n---\n\nБез id и дат.\n");
		writeFileSync(join(notesDir(), "bez-shapki.md"), "# Просто текст\n\nбез front matter\n");
		const before = (await call<StatusInfo>("GET", "/api/status")).data;
		await app.refresh();
		expect(sh(memDir, "status", "--porcelain")).toBe("");
		expect(sh(memDir, "log", "-1", "--format=%s")).toBe("edit by hand: 3 notes");
		const after = (await call<StatusInfo>("GET", "/api/status")).data;
		expect(after.memver).not.toBe(before.memver);
		expect(after.rev).toBeGreaterThan(before.rev);
		expect((await call<{ body: string }>("GET", `/api/notes/${ru.id}`)).data.body).toBe("Всегда, даже если вопрос на английском.");
		const notes = (await call<{ notes: Array<{ id: string; title: string; reach: string; created: string; file: string }> }>("GET", "/api/notes?scope=global")).data.notes;
		const hand = notes.find((n) => n.title === "Написано руками в редакторе");
		expect(hand?.id).toMatch(/^m-[0-9a-f]{6}$/);
		expect([hand?.reach, hand?.created]).toEqual(["always", today()]);
		expect(readFileSync(hand?.file as string, "utf-8")).toContain(`id: ${hand?.id}\n`);
		expect(notes.find((n) => n.title === "Просто текст")?.id).toMatch(/^m-/);
		// a commit made with git itself is noticed too
		rmSync(join(notesDir(), "bez-shapki.md"));
		sh(memDir, "commit", "-qam", "drop a note with git");
		await app.refresh();
		expect((await call<{ notes: Array<{ title: string }> }>("GET", "/api/notes?scope=global")).data.notes.some((n) => n.title === "Просто текст")).toBe(false);
		expect((await call<Array<{ message: string }>>("GET", "/api/history?limit=1")).data[0].message).toBe("drop a note with git");
	});

	it("reads a note file leniently", () => {
		const text = `---\nid: m-7f3a2c\ntitle: "Заголовок: с двоеточием"\ntype: procedure\nstatus: active\nindex: pointer\nwhen: "когда нужно"\npinned: true\ncreated: "2026-11-08"\nupdated: "2026-11-09"\nevidence:\n  - {"s": "abc", "e": ["e1"], "date": "2026-11-06", "at": "2026-11-06T14:05Z", "kind": "user"}\ncustom: 1\n---\n\nТело заметки.\n`;
		const p = parseNote(text, "global", "2026-11-10");
		expect(p.note).toMatchObject({ id: "m-7f3a2c", title: "Заголовок: с двоеточием", type: "procedure", index: "pointer", when: "когда нужно", pinned: true, created: "2026-11-08", updated: "2026-11-09", body: "Тело заметки.", extra: { custom: 1 } });
		expect(p.note.evidence).toEqual([{ s: "abc", e: ["e1"], date: "2026-11-06", at: "2026-11-06T14:05Z", kind: "user" }]);
		expect(p.incomplete).toBe(false);
		const bare = parseNote("# Просто текст\n\nбез front matter", "global", "2026-11-10");
		expect([bare.note.id, bare.note.title, bare.note.created, bare.incomplete]).toEqual(["", "Просто текст", "2026-11-10", true]);
	});

	it("a review is a branch: git shows exactly what is proposed", async () => {
		const d = await dream([
			{ op: "add", ref: "g1", scope: "global", type: "fact", title: "Предложение для проверки ветки", body: "x", index: "none", rationale: "", evidence: [] },
			{ op: "add", ref: "g2", scope: "project:github.com/new/proj", type: "fact", title: "Первая заметка нового проекта", body: "y", index: "none", rationale: "", evidence: [] },
		]);
		const v = (await review()) as ReviewView;
		expect(v.branch).toBe(`review/${d.result.reviewId}`);
		expect(sh(memDir, "branch", "--list", "review/*").replace(/^[+* ]+/, "")).toBe(v.branch);
		const proposed = () => sh(memDir, "diff", "--name-status", `main...${v.branch}`).split("\n").sort();
		expect(proposed()).toEqual(["A\tscopes/global/notes/predlozhenie-dlya-proverki-vetki.md", "A\tscopes/projects/github.com__new__proj/notes/pervaya-zametka-novogo-proekta.md", "A\tscopes/projects/github.com__new__proj/scope.json"]);
		expect(sh(memDir, "log", "-1", "--format=%an|%s", v.branch)).toMatch(/^wierd-memory dream\|dream .*: \+2$/);
		// nothing of it is in the approved folder, and the project is not a scope yet
		expect(existsSync(join(memDir, "scopes/projects/github.com__new__proj"))).toBe(false);
		expect(v.items.find((i) => i.scope === "projects/github.com__new__proj")?.scopeName).toBe("proj");
		// a hand edit of approved memory is merged into the review branch: the difference stays the proposal alone
		const ru = (await call<{ notes: Array<{ id: string; title: string }> }>("GET", "/api/notes?scope=global")).data.notes.find((n) => n.title.startsWith("Отвечать")) as { id: string };
		await call("PATCH", `/api/notes/${ru.id}`, { pinned: true });
		await call("PUT", "/api/scopes/global/charter", { charter: "Только важное." });
		expect(((await review()) as ReviewView).items.length).toBe(2);
		expect(sh(memDir, "merge-base", "main", v.branch)).toBe(sh(memDir, "rev-parse", "main"));
		expect(sh(memDir, "log", "-1", "--format=%s|%P", v.branch)).toMatch(/^in step with main [0-9a-f]{8}\|[0-9a-f]{40} [0-9a-f]{40}$/);
		expect(proposed().length).toBe(3);
		expect(sh(memDir, "show", `${v.branch}:scopes/global/charter.md`)).toBe("Только важное.");
		// accepting the project's first note brings its folder along; the rest stays proposed
		await call("POST", `/api/reviews/${v.id}/accept`, { keys: [`note:${d.ids.g2}`] });
		expect(JSON.parse(readFileSync(join(memDir, "scopes/projects/github.com__new__proj/scope.json"), "utf-8")).key).toBe("github.com/new/proj");
		expect(proposed()).toEqual(["A\tscopes/global/notes/predlozhenie-dlya-proverki-vetki.md"]);
		expect(sh(memDir, "status", "--porcelain")).toBe("");
		await call("POST", `/api/reviews/${v.id}/reject`, {});
		expect(sh(memDir, "branch", "--list", "review/*")).toBe("");
		expect(readdirSync(join(memDir, ".local", "worktrees"))).toEqual([]);
		await call("PUT", "/api/scopes/global/charter", { charter: null });
	});

	it("keeps what goes on around memory in files under .local, out of git", async () => {
		expect(sh(memDir, "check-ignore", ".local/state.json")).toBe(".local/state.json");
		const state = JSON.parse(readFileSync(join(memDir, ".local", "state.json"), "utf-8"));
		expect(Object.keys(state.sessions)).toEqual(["/s/1.jsonl"]);
		expect(state.rejected.map((r: { title: string }) => r.title)).toContain("Совсем лишняя заметка");
		expect(Object.values(state.inbox).every((i) => ["done", "dismissed"].includes((i as { status: string }).status))).toBe(true);
		const reviews = readdirSync(join(memDir, ".local", "reviews")).map((f) => JSON.parse(readFileSync(join(memDir, ".local", "reviews", f), "utf-8")));
		expect(reviews.length).toBeGreaterThanOrEqual(3);
		const first = reviews.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
		expect([first.status, first.decisions.length, first.comments.length]).toEqual(["merged", 5, 1]);
		const run = JSON.parse(readFileSync(join(memDir, ".local", "runs", first.runs[0], "run.json"), "utf-8"));
		expect([run.kind, run.status, run.reviewId]).toEqual(["run", "ok", first.id]);
		expect(JSON.parse(readFileSync(join(memDir, ".local", "runs", first.runs[0], "report.json"), "utf-8")).items.length).toBe(4);
		expect(readFileSync(join(memDir, ".local", "inbox", `${today()}.jsonl`), "utf-8").trim().split("\n").length).toBeGreaterThanOrEqual(2);
	});
});

describe("a remote", () => {
	let other: App;
	let dir: string;
	let bare: string;
	let mem: string;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "wmem-remote-"));
		bare = join(dir, "remote.git");
		sh(dir, "init", "-q", "--bare", "-b", "main", bare);
		// a memory repository with a note written elsewhere
		const seed = join(dir, "seed");
		sh(dir, "init", "-q", "-b", "main", seed);
		sh(seed, "remote", "add", "origin", bare);
		mkdirSync(join(seed, "scopes/global/notes"), { recursive: true });
		writeFileSync(join(seed, ".gitignore"), ".local/\n.DS_Store\n");
		writeFileSync(join(seed, "scopes/global/notes/staraya.md"), `---\nid: m-aaaaaa\ntitle: "Старая заметка"\ntype: fact\nstatus: active\nindex: always\ncreated: "2026-11-01"\nupdated: "2026-11-01"\n---\n\nтело\n`);
		sh(seed, "add", "-A");
		sh(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "notes");
		sh(seed, "push", "-q", "origin", "HEAD:main");
		mem = join(dir, "home", "memory");
		mkdirSync(join(dir, "home"), { recursive: true });
		sh(dir, "clone", "-q", bare, mem);
		writeFileSync(join(dir, "home", "config.json"), JSON.stringify({ port: 17543, memory: { remote: "origin", sync: true } }));
		other = await App.start({ home: join(dir, "home"), noSchedule: true, log: () => {} });
	}, 60_000);

	afterAll(async () => {
		await other?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	const remoteHead = (branch: string) => sh(bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}`);

	it("starts from the cloned repository, with the files as they are", async () => {
		const notes = await other.views();
		expect(notes.map((n) => [n.id, n.title, n.reach])).toEqual([["m-aaaaaa", "Старая заметка", "always"]]);
		expect(sh(mem, "status", "--porcelain")).toBe("");
		expect(sh(mem, "log", "--format=%s")).toBe("notes");
		expect((await other.status()).remote).toMatchObject({ name: "origin", url: bare, sync: true });
	});

	it("pushes approved memory and the open review, and drops the review's branch when it is over", async () => {
		await other.createNote({ scope: "global", title: "Новая заметка", body: "b" });
		expect(await other.sync()).toContain("pushed 1");
		expect(remoteHead("main")).toBe(sh(mem, "rev-parse", "main"));
		const run = await other.dreams.begin("run");
		const ws = await other.dreams.workspace(run.id);
		const w = new Workspace(ws.notes, today(), { pending: ws.pending, scopes: ws.scopes });
		applyOp(w, { op: "add", ref: "a", scope: "global", title: "Предложенная", rationale: "", evidence: [] }, { evidence: ev });
		const res = await other.reviews.submit({ runId: run.id, status: "ok", changes: w.changes(), votes: {}, report: report(run.id), marks: {}, inboxDone: [], commentsDone: [], agents: [], sessions: 0, cost: 0 });
		await other.sync();
		const branch = `review/${res.reviewId}`;
		expect(remoteHead(branch)).toBe(sh(mem, "rev-parse", branch));
		expect(((await other.reviews.view()) as ReviewView).compareUrl).toBeUndefined(); // not GitHub
		await other.reviews.accept(res.reviewId as string, undefined, undefined, "test");
		await other.sync();
		expect(() => remoteHead(branch)).toThrow();
		expect(remoteHead("main")).toBe(sh(mem, "rev-parse", "main"));
		expect(sh(bare, "log", "-1", "--format=%s", "main")).toContain("accept added");
	});

	it("takes in what the remote has: a merge made elsewhere", async () => {
		const elsewhere = join(dir, "elsewhere");
		sh(dir, "clone", "-q", "-b", "main", bare, elsewhere);
		writeFileSync(join(elsewhere, "scopes/global/notes/s-drugoy-mashiny.md"), `---\nid: m-bbbbbb\ntitle: "С другой машины"\ntype: fact\nstatus: active\nindex: none\ncreated: "2026-11-02"\nupdated: "2026-11-02"\n---\n\nтело\n`);
		sh(elsewhere, "add", "-A");
		sh(elsewhere, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a note from elsewhere");
		sh(elsewhere, "push", "-q", "origin", "main");
		// meanwhile a change here: both sides have a commit of their own
		await other.patchNote("m-aaaaaa", { pinned: true });
		expect(await other.sync()).toContain("took in 1 commit");
		expect((await other.views()).map((n) => n.id).sort()).toContain("m-bbbbbb");
		expect(sh(mem, "status", "--porcelain")).toBe("");
		expect(remoteHead("main")).toBe(sh(mem, "rev-parse", "main"));
		expect(sh(bare, "log", "--format=%s", "-3", "main").split("\n")).toEqual(expect.arrayContaining(["a note from elsewhere"]));
	});

	it("moves to another approved branch, one the remote has", async () => {
		await other.sync();
		const before = (await other.views()).map((n) => [n.id, n.title, n.pinned]).sort();
		const rejected = await other.state.rejectedTitles();
		sh(mem, "push", "-q", "origin", "main:notes");
		await other.stop();
		writeFileSync(join(dir, "home", "config.json"), JSON.stringify({ port: 17543, memory: { branch: "notes", remote: "origin", sync: true } }));
		other = await App.start({ home: join(dir, "home"), noSchedule: true, log: () => {} });
		expect(sh(mem, "rev-parse", "--abbrev-ref", "HEAD")).toBe("notes");
		expect(sh(mem, "rev-parse", "--abbrev-ref", "notes@{upstream}")).toBe("origin/notes");
		expect((await other.views()).map((n) => [n.id, n.title, n.pinned]).sort()).toEqual(before);
		expect(sh(mem, "status", "--porcelain")).toBe("");
		expect((await other.status()).git.branch).toBe("notes");
		// the state beside the repository is the same one
		expect(await other.state.rejectedTitles()).toEqual(rejected);
	});
});
