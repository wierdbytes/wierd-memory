/**
 * A whole dream against a real server and its git repository, with scripted models: sessions
 * on disk → digests → cards → curator → fact check → the review.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { type DreamSubmit, keyToDir, projectScope, RepoProbe, type Stage, type StageModel, type StageUsage } from "@wierd-memory/core";
import { App } from "../../server/src/app.ts";
import { type DreamApi, dream, type DreamLlm, loadDigestIndex, parseRunArgs } from "../pipeline.ts";

let app: App;
let home: string;
let proj: string;
const S1 = "01a1b2c3-0000-7000-8000-0000000000a1";
const S2 = "01a1b2c3-0000-7000-8000-0000000000a2";

function session(dir: string, id: string, cwd: string, turns: Array<[string, string, string]>): string {
	const lines = [JSON.stringify({ type: "session", id, cwd, timestamp: "2026-11-08T10:00:00.000Z" })];
	let parent: string | null = null;
	for (const [entry, role, text] of turns) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: entry,
				parentId: parent,
				timestamp: "2026-11-08T10:05:00.000Z",
				message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }], provider: "test", model: "m" },
			}),
		);
		parent = entry;
	}
	const file = join(dir, `2026-11-08T10-00-00_${id}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	const old = new Date(Date.now() - 3 * 3600_000);
	utimesSync(file, old, old);
	return file;
}

interface CuratorInput {
	notes: { global: Array<{ id: string; title: string; pending?: boolean }>; project: Array<{ id: string; title: string; pending?: boolean }> };
	inbox: Array<{ s: string; text: string }>;
	limits: { max_new_notes: number };
	repo_docs: string[] | null;
}

/** Models that answer from the input they are given. */
class Script implements DreamLlm {
	usage: Partial<Record<Stage, StageUsage>> = {};
	calls: Array<{ stage: Stage; system: string; user: string }> = [];
	/** `amend`: what the pipeline sent the reply back for (asked once more, like Llm.json). */
	review: (input: { comments: Array<{ id: string; note?: string; body: string }> }, amend?: string) => unknown = () => ({ ops: [] });
	/** Replaces the scripted curator when set. */
	curator?: (input: CuratorInput, amend?: string) => unknown;
	/** What replies were sent back for, in order. */
	amends: string[] = [];

	totalCost(): number {
		return Object.values(this.usage).reduce((s, u) => s + (u?.cost ?? 0), 0);
	}

	async json<T>(stage: Stage, _spec: StageModel, system: string, user: string, validate: (v: unknown) => T, opts?: { amend?: (value: T) => string | undefined }): Promise<T> {
		const call = (amend?: string) => {
			this.calls.push({ stage, system, user });
			const u = (this.usage[stage] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0, failures: 0 });
			u.calls++;
			u.cost += 0.01;
			return validate(this.answer(stage, system, user, amend));
		};
		// Like Llm.json: a usable reply that should change is sent back once, and the next one is taken as it is.
		const first = call();
		const amend = opts?.amend?.(first);
		if (!amend) return first;
		this.amends.push(amend);
		return call(amend);
	}

	private answer(stage: Stage, system: string, user: string, amend?: string): unknown {
		if (stage === "cards") {
			const entries = [...user.matchAll(/^\[([0-9a-f]+)\] USER: (.*)$/gm)];
			return {
				title: `Про ${entries[0]?.[2].slice(0, 30)}`,
				summary: "s",
				outcome: { status: "success", signals: [] },
				feedback: [],
				learnings: entries.filter((m) => /всегда|никогда/i.test(m[2])).map((m) => ({ kind: "preference", scope: "project", statement: m[2], evidence: [`[${m[1]}]`, "ffff9999"], source: "user", confidence: "high" })),
				memory_feedback: [],
			};
		}
		if (stage === "analyze" && system.includes("left comments")) return this.review(JSON.parse(user), amend);
		if (stage === "analyze" && this.curator) return this.curator(JSON.parse(user), amend);
		if (stage === "analyze") {
			const input = JSON.parse(user) as { sessions: Array<{ session: string; learnings: Array<{ statement: string; evidence: string[] }> }>; notes: { project: Array<{ id: string; title: string; body: string; off?: boolean }> }; inbox: Array<{ s: string; text: string }> };
			const ops: unknown[] = [];
			for (const s of input.sessions)
				for (const l of s.learnings) ops.push({ op: "add", ref: `op${ops.length + 1}`, scope: "project", type: "preference", title: l.statement, body: "Подробности.", index: "always", rationale: "сказано пользователем", evidence: [{ s: s.session, e: l.evidence }] });
			for (const i of input.inbox) ops.push({ op: "add", ref: `op${ops.length + 1}`, scope: "global", type: "fact", title: i.text, body: "", index: "none", rationale: "из inbox", evidence: [{ s: i.s, e: [] }] });
			const existing = input.notes.project.find((n) => n.title.includes("make test") && !n.body.includes("make clean"));
			if (existing) ops.push({ op: "update", ref: `op${ops.length + 1}`, id: existing.id, body: "make test; при падении — make clean", rationale: "уточнение", evidence: [{ s: input.sessions[0].session, e: input.sessions[0].learnings[0].evidence }] });
			ops.push({ op: "add", ref: "bogus", scope: "project", title: "Выдумано", rationale: "", evidence: [{ s: input.sessions[0]?.session ?? "x", e: ["00000000"] }] });
			ops.push({ op: "add", ref: "unsupported", scope: "project", title: "Не подтвердится", rationale: "", evidence: [{ s: input.sessions[0].session, e: input.sessions[0].learnings[0].evidence }] });
			return { ops };
		}
		const input = JSON.parse(user) as { proposals: Array<{ ref: string; proposal?: { title?: string } }> };
		return {
			verdicts: input.proposals.map((p) =>
				p.ref === "unsupported"
					? { ref: p.ref, verdict: "unsupported", unsafe: false, reason: "нет в сессии" }
					: p.proposal?.title?.includes("Никогда")
						? { ref: p.ref, verdict: "partial", unsafe: false, reason: "слишком общо", fix: { title: `${p.proposal.title} (в этом проекте)` } }
						: { ref: p.ref, verdict: "supported", unsafe: false, reason: "" },
			),
		};
	}
}

const api = (): DreamApi => ({ workspace: (run) => app.dreams.workspace(run), submit: (sub: DreamSubmit) => app.reviews.submit(sub) });
const run = async (llm: Script, mode: "run" | "review" | "dry" | "reindex" = "run") => {
	const r = await app.dreams.begin(mode);
	return { id: r.id, out: await dream(r.id, { api: api(), llm, log: () => {}, signal: new AbortController().signal }) };
};

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "wmem-dream-"));
	proj = join(home, "proj");
	mkdirSync(proj, { recursive: true });
	writeFileSync(join(proj, "package.json"), "{}");
	const sessions = join(home, "sessions", "--proj--");
	mkdirSync(sessions, { recursive: true });
	process.env.PI_CODING_AGENT_SESSION_DIR = join(home, "sessions");
	session(sessions, S1, proj, [
		["aaaa0001", "user", "Всегда запускай линтер перед коммитом"],
		["aaaa0002", "assistant", "Хорошо, запускаю линтер."],
		["aaaa0003", "user", "спасибо"],
	]);
	session(sessions, S2, proj, [
		["bbbb0001", "user", "Никогда не трогай vendor/"],
		["bbbb0002", "assistant", "Понял."],
	]);
	// Room for every scripted add; the limit has its own test.
	writeFileSync(join(home, "config.json"), JSON.stringify({ port: 17633, dream: { maxNewNotesPerPass: 10 } }));
	app = await App.start({ home, noSchedule: true, log: () => {} });
}, 60_000);

afterAll(async () => {
	await app?.stop();
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
	rmSync(home, { recursive: true, force: true });
});

describe("a dream", () => {
	const scope = () => `projects/local__${proj.split("/").filter(Boolean).join("__")}`.replace(/[^A-Za-z0-9._/-]/g, "_");
	let existing = "";

	it("reads new sessions and proposes notes with checked evidence", async () => {
		existing = (await app.createNote({ scope: scope(), title: "Тесты запускаются через make test", body: "make test", index: "pointer", when: "тесты" })).id;
		await app.patchNote(existing, { enabled: true });
		const inbox = await app.state.addInbox({ source: "user", text: "Релизы только по пятницам", cwd: proj, projectKey: `local:${proj}`, scope: "global" });
		const llm = new Script();
		const { id, out } = await run(llm);
		expect(out.status).toBe("ok");
		expect(out.sessions).toBe(2);
		expect(out.result?.items).toBe(4);
		const v = await app.reviews.view();
		const got = v.items.map((i) => `${i.kind}:${i.note.title}`).sort();
		expect(got).toEqual(["added:Всегда запускай линтер перед коммитом", "added:Никогда не трогай vendor/ (в этом проекте)", "added:Релизы только по пятницам", "updated:Тесты запускаются через make test"]);
		const lint = v.items.find((i) => i.note.title.startsWith("Всегда"));
		// only the entry that exists is cited; it is the user's own message
		expect(lint?.note.evidence).toEqual([{ s: S1, e: ["aaaa0001"], date: "2026-11-08", at: "2026-11-08T10:05Z", kind: "user" }]);
		expect(lint?.check).toEqual({ verdict: "supported", reason: "", corrected: false });
		expect(lint?.why).toEqual(["сказано пользователем"]);
		expect(lint?.scope).toBe(scope());
		const vendor = v.items.find((i) => i.note.title.startsWith("Никогда"));
		expect(vendor?.check?.corrected).toBe(true);
		expect(v.items.find((i) => i.note.title.startsWith("Релизы"))?.note.evidence[0]).toMatchObject({ s: `inbox:${inbox.id}`, kind: "user" });
		expect(v.rejectedByCheck.map((r) => [r.ref, r.reason.split(" ")[0]]).sort()).toEqual([["bogus", "entry"], ["unsupported", "unsupported"]]);
		expect(v.sessionTitles[S1]).toContain("Про Всегда");
		// bookkeeping
		expect(Object.values(await app.state.marks()).map((m) => m.ok)).toEqual([true, true]);
		expect(await app.state.inbox("pending")).toEqual([]);
		expect(existsSync(join(home, "memory", ".local", "cards", `${S1}.json`))).toBe(true);
		expect(existsSync(join(home, "memory", ".local", "digests", "index.json"))).toBe(true);
		expect(readFileSync(join(home, "memory", ".local", "runs", id, "report.md"), "utf-8")).toContain("# dream ");
		const stored = await app.state.run(id);
		expect([stored?.status, stored?.sessions]).toEqual(["ok", 2]);
		expect(v.runInfos.map((r) => r.id)).toEqual([id]);
		expect(stored?.report?.usage.cards?.calls).toBe(2);
		// approved memory is untouched
		expect((await app.mem.notes()).length).toBe(1);
		// the curator saw the project's notes, the charter and the budgets
		const curator = llm.calls.find((c) => c.stage === "analyze");
		expect(curator?.system).toContain("This project (local:");
		expect(JSON.parse(curator?.user ?? "{}").notes.project[0].id).toBe(existing);
		// past sessions are searchable now
		const found = await app.searcher.search({ query: "линтер", scope: "sessions", projects: "all" });
		expect(found.sessions[0]?.ref).toBe(`s:${S1}#aaaa0001`);
		expect((await app.searcher.evidence([{ s: S1, e: ["aaaa0001"] }])).sessions[S1].entries.aaaa0001).toEqual({ role: "USER", text: "Всегда запускай линтер перед коммитом" });
		expect(await app.searcher.read(`s:${S1}#aaaa0002`)).toContain("запускаю линтер");
	});

	it("does nothing when there is nothing new", async () => {
		const llm = new Script();
		const { out } = await run(llm);
		expect(out.status).toBe("noop");
		expect(llm.calls).toEqual([]);
		expect((await app.reviews.view()).items.length).toBe(4);
	});

	it("applies review comments in a comments-only pass", async () => {
		const v = await app.reviews.view();
		const lint = v.items.find((i) => i.note.title.startsWith("Всегда"))?.note.id as string;
		const vendor = v.items.find((i) => i.note.title.startsWith("Никогда"))?.note.id as string;
		await app.reviews.comment("сделай короче", lint);
		await app.reviews.comment("это не нужно", vendor);
		await app.reviews.comment("и перекрась кнопку", undefined);
		const comments = await app.state.comments();
		const llm = new Script();
		llm.review = () => ({
			ops: [
				{ op: "update", ref: "r1", id: lint, title: "Линтер перед коммитом", rationale: "по комментарию", evidence: [{ s: `comment:${comments[0].id}`, e: [] }] },
				{ op: "deprecate", ref: "r2", id: vendor, rationale: "по комментарию", evidence: [{ s: `comment:${comments[1].id}`, e: [] }] },
			],
			unhandled: [{ comment: comments[2].id, reason: "не про память" }],
		});
		const { out } = await run(llm, "review");
		expect(out.status).toBe("ok");
		expect(JSON.parse(llm.calls[0].user).comments.map((c: { note?: string }) => c.note)).toEqual([lint, vendor, undefined]);
		const after = await app.reviews.view();
		expect(after.items.map((i) => `${i.kind}:${i.note.title}`).sort()).toEqual(["added:Линтер перед коммитом", "added:Релизы только по пятницам", "updated:Тесты запускаются через make test"]);
		const edited = after.items.find((i) => i.note.id === lint);
		expect(edited?.reviewer).toBe(true);
		expect(edited?.note.evidence.at(-1)).toMatchObject({ s: `comment:${comments[0].id}`, e: [], kind: "reviewer" });
		expect(after.waitingComments).toBe(0);
		expect(after.comments.map((c) => [!!c.processedRun, c.unhandled])).toEqual([[true, undefined], [true, undefined], [true, "не про память"]]);
		// nothing left to apply: the next comments-only pass is a no-op
		expect((await run(new Script(), "review")).out.status).toBe("noop");
	});

	it("leaves alone what the user turned off, and a dry run writes nothing", async () => {
		const accepted = await app.reviews.accept({ all: true }, "test");
		expect([accepted.pending, accepted.runInfos.length]).toEqual([0, 0]);
		const notes = await app.mem.notes();
		expect(notes.length).toBe(3);
		const lint = notes.find((n) => n.title === "Линтер перед коммитом") as { id: string };
		await app.patchNote(lint.id, { enabled: false });
		// a new session repeats what the turned-off note says
		session(join(home, "sessions", "--proj--"), "01a1b2c3-0000-7000-8000-0000000000a3", proj, [["cccc0001", "user", "Всегда: линтер перед коммитом"]]);
		const dry = await run(new Script(), "dry");
		expect(dry.out.status).toBe("noop");
		expect(Object.keys(await app.state.marks()).length).toBe(2); // a dry run marks nothing as read
		const llm = new Script();
		const { id, out } = await run(llm);
		const curator = JSON.parse(llm.calls.find((c) => c.stage === "analyze")?.user ?? "{}");
		expect(curator.notes.project.find((n: { id: string }) => n.id === lint.id)?.off).toBe(true);
		expect(out.status).toBe("noop");
		expect((await app.reviews.view()).pending).toBe(0);
		const report = (await app.state.run(id))?.report;
		expect(report?.rejected.some((r) => r.reason.includes("turned off"))).toBe(true);
	});

	it("keeps to the limit of new notes and shows the curator the project's docs", async () => {
		writeFileSync(join(proj, "README.md"), "# Proj\n\n## Build\n\n```sh\n# not a heading\n```\n\n### Release\n");
		mkdirSync(join(proj, "docs"), { recursive: true });
		writeFileSync(join(proj, "docs", "guide.md"), "# Guide\n## Deploy\n");
		const item = await app.state.addInbox({ source: "user", text: "Четыре заметки", cwd: proj, projectKey: `local:${proj}`, scope: "project" });
		app.cfg.dream.maxNewNotesPerPass = 2;
		const llm = new Script();
		let seen: CuratorInput | undefined;
		llm.curator = (input) => {
			seen = input;
			return { ops: ["Первая", "Вторая", "Третья", "Четвёртая"].map((t, i) => ({ op: "add", ref: `a${i + 1}`, scope: "project", type: "fact", title: `${t} заметка о сборке проекта`, body: "", index: "none", rationale: "из inbox", evidence: [{ s: `inbox:${item.id}`, e: [] }] })) };
		};
		try {
			const { id } = await run(llm);
			expect(seen?.limits).toEqual({ max_new_notes: 2 });
			expect(llm.calls.find((c) => c.stage === "analyze")?.system).toContain("At most 2 new notes");
			expect(seen?.repo_docs).toEqual(["README.md: # Proj · ## Build · ### Release", "docs/guide.md: # Guide · ## Deploy"]);
			// only what is under the limit reaches the fact check
			expect(JSON.parse(llm.calls.find((c) => c.stage === "verify")?.user ?? "{}").proposals.map((p: { ref: string }) => p.ref)).toEqual(["a1", "a2"]);
			const report = (await app.state.run(id))?.report;
			expect(report?.items.map((i) => i.kind)).toEqual(["added", "added"]);
			expect(report?.rejected.map((r) => [r.ref, r.reason.startsWith("over the limit of 2 new note(s)")])).toEqual([["a3", true], ["a4", true]]);
			expect((await app.reviews.view()).items.map((i) => i.note.title).sort()).toEqual(["Вторая заметка о сборке проекта", "Первая заметка о сборке проекта"]);
		} finally {
			app.cfg.dream.maxNewNotesPerPass = 10;
		}
	});

	it("withdraws its own earlier proposals without evidence or a fact check", async () => {
		const proposed = (await app.reviews.view()).items.map((i) => i.note);
		const first = proposed.find((n) => n.title.startsWith("Первая"))?.id as string;
		const second = proposed.find((n) => n.title.startsWith("Вторая"))?.id as string;
		const approved = (await app.mem.notes()).find((n) => n.title.startsWith("Тесты"))?.id as string;
		// an inbox item, so that the project gets a pass
		await app.state.addInbox({ source: "agent", text: "Ещё раз про сборку", cwd: proj, projectKey: `local:${proj}`, scope: "project" });
		const llm = new Script();
		let seen: CuratorInput | undefined;
		llm.curator = (input) => {
			seen = input;
			return {
				ops: [
					{ op: "deprecate", ref: "w1", id: first, rationale: "дубликат README", evidence: [] },
					{ op: "deprecate", ref: "w2", id: second, rationale: "", evidence: [] },
					// an approved note still needs evidence and the fact check
					{ op: "deprecate", ref: "d1", id: approved, rationale: "устарело", evidence: [] },
				],
			};
		};
		const { id } = await run(llm);
		// project passes mark what is only proposed
		const pendingIds = seen?.notes.project.filter((n) => n.pending).map((n) => n.id).sort();
		expect(pendingIds).toEqual([first, second].sort());
		expect(seen?.notes.project.find((n) => n.id === approved)?.pending).toBeUndefined();
		expect(llm.calls.some((c) => c.stage === "verify")).toBe(false);
		const report = (await app.state.run(id))?.report;
		expect(report?.items).toHaveLength(1);
		expect(report?.items[0]).toMatchObject({ kind: "removed", id: first, why: ["дубликат README"], evidence: [] });
		expect(report?.items[0].note).toContain("withdrawn");
		expect(report?.rejected.map((r) => [r.ref, r.reason])).toEqual([
			["w2", "withdrawing a proposal needs a rationale"],
			["d1", "no evidence cited"],
		]);
		const v = await app.reviews.view();
		expect(v.items.map((i) => i.note.id)).toEqual([second]);
		expect((await app.mem.notes()).find((n) => n.id === approved)?.status).toBe("active");
		// leave nothing proposed for the tests after this one
		await app.reviews.reject({ all: true }, "test");
		expect((await app.reviews.view()).pending).toBe(0);
	});

	it("sends notes over the length limits back once and marks what is still over for the reviewer", async () => {
		const words = (n: number) => Array.from({ length: n }, (_, i) => `слово${i}`).join(" ");
		const count = (s: string | undefined) => (s ?? "").split(" ").length;
		const approved = (await app.mem.notes()).find((n) => n.title.startsWith("Тесты"))?.id as string;
		// Approved notes that are long already: a change that does not write their text is not held to the limits.
		const longA = (await app.createNote({ scope: scope(), title: "Длинная одобренная заметка про выпуск", body: words(130), index: "none" })).id;
		const longB = (await app.createNote({ scope: scope(), title: "Длинная одобренная заметка про деплой", body: words(140), index: "none" })).id;
		await app.reviews.comment("сократи", longA);
		const comment = (await app.state.comments()).find((c) => c.noteId === longA)?.id as string;
		const item = await app.state.addInbox({ source: "user", text: "Про длину заметок", cwd: proj, projectKey: `local:${proj}`, scope: "project" });
		const ev = [{ s: `inbox:${item.id}`, e: [] }];
		const longTitle = `Заголовок ${"очень ".repeat(30)}длинный`;
		const add = (ref: string, title: string, body: string) => ({ op: "add", ref, scope: "project", type: "fact", title, body, index: "none", rationale: "из inbox", evidence: ev });
		const llm = new Script();
		llm.review = (_input, amend) => ({ ops: [{ op: "update", ref: "r1", id: longA, body: words(amend ? 100 : 125), rationale: "по комментарию", evidence: [{ s: `comment:${comment}`, e: [] }] }], unhandled: [] });
		llm.curator = (_input, amend) => ({
			ops: [
				// shortened when asked
				add("a1", "Заметка, которую куратор сократит", words(amend ? 90 : 134)),
				add("a2", "Короткая заметка", words(20)),
				// still over after the request
				add("a3", longTitle, words(10)),
				{ op: "update", ref: "u1", id: approved, body: words(130), rationale: "дописано", evidence: ev },
				{ op: "update", ref: "u2", id: longB, index: "pointer", when: "деплой", rationale: "нужна чаще", evidence: ev },
			],
		});
		const { id } = await run(llm);
		// each pass was asked once, about what it wrote over the limits and nothing else
		expect(llm.amends).toHaveLength(2);
		expect(llm.amends[0]).toStartWith(`Over the length limits of a note — r1 (update ${longA}): body is 125 words, limit 120. Shorten it:`);
		const curatorAsk = llm.amends[1];
		for (const s of ["a1 (add): body is 134 words, limit 120", `a3 (add): title is ${[...longTitle].length} chars, limit 160`, `u1 (update ${approved}): body is 130 words, limit 120`]) expect(curatorAsk).toContain(s);
		for (const s of ["a2", "u2", longB]) expect(curatorAsk).not.toContain(s);
		// the curator's prompt asks an update to rewrite the note, not to add to it
		expect(llm.calls.find((c) => c.stage === "analyze" && c.system.includes("memory curator") && !c.system.includes("left comments"))?.system).toContain("An update rewrites the note to the current understanding");
		const v = await app.reviews.view();
		const byTitle = (t: string) => v.items.find((i) => i.note.title === t);
		const byId = (nid: string) => v.items.find((i) => i.note.id === nid);
		expect([count(byTitle("Заметка, которую куратор сократит")?.note.body), byTitle("Заметка, которую куратор сократит")?.remark]).toEqual([90, undefined]);
		expect(byTitle("Короткая заметка")?.remark).toBeUndefined();
		// kept as it is (never cut), with a remark
		expect(byTitle(longTitle)?.remark).toBe(`over the length limits: title is ${[...longTitle].length} chars, limit 160`);
		expect([count(byId(approved)?.note.body), byId(approved)?.remark]).toEqual([130, "over the length limits: body is 130 words, limit 120"]);
		expect([count(byId(longA)?.note.body), byId(longA)?.remark]).toEqual([100, undefined]);
		expect([byId(longB)?.kind, count(byId(longB)?.note.body), byId(longB)?.remark]).toEqual(["updated", 140, undefined]);
		// the dream's report says it too
		const report = (await app.state.run(id))?.report;
		expect(report?.items.find((i) => i.id === approved)?.note).toBe("over the length limits: body is 130 words, limit 120");
		expect(readFileSync(join(home, "memory", ".local", "runs", id, "report.md"), "utf-8")).toContain("  - over the length limits: body is 130 words, limit 120");
		// leave nothing proposed, and approved memory as it was
		await app.reviews.reject({ all: true }, "test");
		await app.deleteNote(longA);
		await app.deleteNote(longB);
		expect((await app.reviews.view()).pending).toBe(0);
	});

	it("refiles a folder's sessions and memory when it gets a git remote", async () => {
		const key = "github.com/o/proj";
		const dir = keyToDir(key);
		const oldDir = keyToDir(`local:${proj}`);
		const moved = (await app.mem.notes()).filter((n) => n.scope === scope()).map((n) => n.id);
		expect(moved.length).toBe(2);
		expect(existsSync(join(home, "memory", ".local", "digests", oldDir))).toBe(true);
		execFileSync("git", ["init", "-q"], { cwd: proj });
		execFileSync("git", ["remote", "add", "origin", "git@github.com:o/proj.git"], { cwd: proj });
		await run(new Script(), "reindex");
		// The digests are rebuilt under the new key (their records too), the old folder is gone.
		const index = loadDigestIndex(join(home, "memory", ".local", "digests", "index.json"));
		expect(Object.values(index).map((r) => [r.projectKey, r.dir])).toEqual([[key, dir], [key, dir], [key, dir]]);
		expect(existsSync(join(home, "memory", ".local", "digests", dir, `${S1}.txt`))).toBe(true);
		expect(existsSync(join(home, "memory", ".local", "digests", oldDir))).toBe(false);
		expect(readFileSync(join(home, "memory", ".local", "digests", dir, `${S1}.txt`), "utf-8")).toContain(`project ${key}`);
		// The scope moved before the dream started.
		expect((await app.mem.notes()).filter((n) => n.scope === projectScope(key)).map((n) => n.id)).toEqual(moved);
		expect((await app.mem.scopes()).some((s) => s.id === scope())).toBe(false);
		// "This project" in search is the new key's.
		const found = await app.searcher.search({ query: "линтер", scope: "sessions", cwd: proj });
		expect(found.sessions.map((s) => [s.sessionId, s.here])).toContainEqual([S1, true]);
		// The next dream files a new session's learnings under the new key, next to the moved notes.
		session(join(home, "sessions", "--proj--"), "01a1b2c3-0000-7000-8000-0000000000a4", proj, [["dddd0001", "user", "Всегда пиши changelog"]]);
		const llm = new Script();
		await run(llm);
		const curator = JSON.parse(llm.calls.find((c) => c.stage === "analyze")?.user ?? "{}");
		expect(curator.project.key).toBe(key);
		expect(curator.notes.project.map((n: { id: string }) => n.id).sort()).toEqual([...moved].sort());
		const v = await app.reviews.view();
		expect(v.items.map((i) => `${i.kind}:${i.scope}:${i.note.title}`)).toEqual([`added:${projectScope(key)}:Всегда пиши changelog`]);
	});

	it("files a session from a removed worktree under the key pi-memory recorded at its start", async () => {
		const key = "github.com/o/proj";
		const gone = join(home, "proj-wt-gone");
		const id = "01a1b2c3-0000-7000-8000-0000000000a5";
		const dir = join(home, "sessions", "--proj-wt-gone--");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `2026-11-08T10-00-00_${id}.jsonl`);
		writeFileSync(
			file,
			`${[
				{ type: "session", id, cwd: gone, timestamp: "2026-11-08T10:00:00.000Z" },
				{ type: "custom", customType: "wierd-memory", id: "eeee0000", parentId: null, data: { event: "inject", ids: [], projectKey: key } },
				{ type: "message", id: "eeee0001", parentId: "eeee0000", timestamp: "2026-11-08T10:05:00.000Z", message: { role: "user", content: "проверь строки" } },
			]
				.map((e) => JSON.stringify(e))
				.join("\n")}\n`,
		);
		const indexPath = join(home, "memory", ".local", "digests", "index.json");
		await run(new Script(), "reindex");
		expect(loadDigestIndex(indexPath)[file]).toMatchObject({ projectKey: key, dir: keyToDir(key), recordedKey: key });
		// A digest made before the key was recorded in the index: filed as `local:<cwd>`, it is looked up in the session once.
		const index = loadDigestIndex(indexPath);
		const localDir = keyToDir(`local:${gone}`);
		index[file] = { ...index[file], projectKey: `local:${gone}`, dir: localDir, recordedKey: undefined };
		mkdirSync(join(home, "memory", ".local", "digests", localDir), { recursive: true });
		writeFileSync(join(home, "memory", ".local", "digests", localDir, `${id}.txt`), "old\n");
		writeFileSync(indexPath, JSON.stringify(index));
		await run(new Script(), "reindex");
		expect(loadDigestIndex(indexPath)[file]).toMatchObject({ projectKey: key, dir: keyToDir(key), recordedKey: key });
		expect(existsSync(join(home, "memory", ".local", "digests", localDir))).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	it("parses the runner's arguments", () => {
		expect(parseRunArgs("--run-id 20261109-1200-abcd --max 5 --since 3")).toEqual({ runId: "20261109-1200-abcd", maxSessions: 5, sinceDays: 3 });
		expect(parseRunArgs("--dry")).toEqual({ mode: "dry" });
		expect(parseRunArgs("--review-only --max x")).toEqual({ mode: "review" });
	});

	// From here on the project is a git repository (github.com/o/proj): the checkout can be searched.
	const KEY = "github.com/o/proj";
	type Checked = { ref: string; repo_docs?: Array<{ path: string; heading: string; snippet: string }>; gone?: string[] };
	/** The scripted models, with a fact check that answers from what the checkout says. */
	class RepoAware extends Script {
		override async json<T>(stage: Stage, spec: StageModel, system: string, user: string, validate: (v: unknown) => T, opts?: { amend?: (value: T) => string | undefined }): Promise<T> {
			if (stage !== "verify") return super.json(stage, spec, system, user, validate, opts);
			this.calls.push({ stage, system, user });
			const input = JSON.parse(user) as { proposals: Checked[] };
			return validate({
				verdicts: input.proposals.map((p) =>
					p.gone?.length ? { ref: p.ref, verdict: "contradicted", unsafe: false, reason: "кода больше нет" } : p.repo_docs?.length ? { ref: p.ref, verdict: "documented", unsafe: false, reason: `сказано в ${p.repo_docs[0].path}` } : { ref: p.ref, verdict: "supported", unsafe: false, reason: "" },
				),
			});
		}
	}
	type RepoNote = { id: string; title: string; pending?: boolean; repo_check?: { gone: string[]; docs: Array<{ path: string }> } };
	type RepoInput = { recheck?: boolean; sessions: Array<{ session: string; learnings: Array<{ statement: string; evidence: string[]; docs?: Array<{ path: string; heading: string; snippet: string }> }> }>; inbox: unknown[]; notes: { project: RepoNote[] } };
	let stale = "";

	it("shows the curator and the fact check what the checkout says", async () => {
		mkdirSync(join(proj, "docs"), { recursive: true });
		writeFileSync(join(proj, "docs", "lint.md"), "# Линтер\n\n## Перед коммитом\n\nВсегда запускай линтер перед каждым коммитом проекта: `bun run lint` проверяет весь проект.\n");
		// Only what the repository had counts as gone: its history says so.
		const commit = (message: string) => {
			execFileSync("git", ["-C", proj, "add", "Cards.swift"]);
			execFileSync("git", ["-C", proj, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message, "--", "Cards.swift"]);
		};
		writeFileSync(join(proj, "Cards.swift"), "struct PhoneCardView {}\nstruct PhoneListGestures {}\n");
		commit("cards");
		// A proposal about code the checkout has: it passes and waits for review.
		const item = await app.state.addInbox({ source: "user", text: "Жесты карточек", cwd: proj, projectKey: KEY, scope: "project" });
		const first = new RepoAware();
		first.curator = () => ({
			ops: [{ op: "add", ref: "g1", scope: "project", type: "fact", title: "Жесты списка обрабатывает `PhoneListGestures`", body: "Карточка — `PhoneCardView`; поле `transportType` из вывода devicectl.", index: "none", rationale: "из inbox", evidence: [{ s: `inbox:${item.id}`, e: [] }] }],
		});
		await run(first);
		const checked = JSON.parse(first.calls.find((c) => c.stage === "verify")?.user ?? "{}").proposals as Checked[];
		expect(checked.map((p) => [p.ref, p.gone])).toEqual([["g1", undefined]]);
		stale = (await app.reviews.view()).items.find((i) => i.note.title.includes("PhoneListGestures"))?.note.id as string;
		expect(stale).toBeTruthy();
		// The code moves on while it waits; a new session repeats what docs/lint.md says.
		writeFileSync(join(proj, "Cards.swift"), "struct PhoneCardView {}\n");
		commit("no more gestures");
		session(join(home, "sessions", "--proj--"), "01a1b2c3-0000-7000-8000-0000000000a6", proj, [["ffff0001", "user", "Всегда запускай линтер перед коммитом проекта"]]);
		const llm = new RepoAware();
		let seen: RepoInput | undefined;
		llm.curator = (raw) => {
			const input = raw as unknown as RepoInput;
			seen = input;
			const s = input.sessions[0];
			return { ops: [{ op: "add", ref: "l1", scope: "project", type: "preference", title: s.learnings[0].statement, body: "", index: "always", rationale: "сказано", evidence: [{ s: s.session, e: s.learnings[0].evidence }] }] };
		};
		const { id } = await run(llm);
		expect(seen?.recheck).toBeUndefined();
		expect(seen?.sessions[0].learnings[0].docs?.[0]).toMatchObject({ path: "docs/lint.md", heading: "## Перед коммитом" });
		expect(seen?.sessions[0].learnings[0].docs?.[0].snippet).toContain("bun run lint");
		// what still waits for review is held against the checkout; approved notes are not
		expect(seen?.notes.project.find((n) => n.id === stale)?.repo_check?.gone).toEqual(["PhoneListGestures"]);
		expect(seen?.notes.project.filter((n) => !n.pending).some((n) => n.repo_check)).toBe(false);
		const verified = JSON.parse(llm.calls.find((c) => c.stage === "verify")?.user ?? "{}").proposals as Checked[];
		expect(verified[0].repo_docs?.[0].path).toBe("docs/lint.md");
		const report = (await app.state.run(id))?.report;
		expect(report?.items).toEqual([]);
		expect(report?.rejected.map((r) => [r.ref, r.reason])).toEqual([["l1", "documented — сказано в docs/lint.md"]]);
	});

	it("rechecks the waiting proposals of a project no session spoke of, once per finding", async () => {
		const notes = (await app.reviews.view()).items.map((i) => i.note);
		const changelog = notes.find((n) => n.title.includes("changelog"))?.id as string;
		const approved = (await app.mem.notes()).find((n) => n.title.startsWith("Тесты"))?.id as string;
		expect([!!changelog, !!approved, notes.some((n) => n.id === stale)]).toEqual([true, true, true]);
		// Nothing new: the stale proposal still gets a pass, which may leave it.
		const idle = new RepoAware();
		let seen: RepoInput | undefined;
		idle.curator = (input) => {
			seen = input as unknown as RepoInput;
			return { ops: [] };
		};
		await run(idle);
		expect([seen?.recheck, seen?.sessions, seen?.inbox]).toEqual([true, [], []]);
		expect(seen?.notes.project.find((n) => n.id === stale)?.repo_check?.gone).toEqual(["PhoneListGestures"]);
		// Asked once: the same finding on the same proposal is not asked about again.
		const again = new RepoAware();
		await run(again);
		expect(again.calls).toEqual([]);
		// Forgotten: asked again, and only withdrawals and updates of this project's proposals count.
		rmSync(join(home, "memory", ".local", "rechecks.json"));
		const llm = new RepoAware();
		llm.curator = () => ({
			ops: [
				{ op: "deprecate", ref: "w1", id: stale, rationale: "PhoneListGestures больше нет в коде", evidence: [] },
				{ op: "update", ref: "u1", id: changelog, body: "К каждому изменению — запись в changelog.", rationale: "точнее", evidence: [] },
				{ op: "add", ref: "a1", scope: "project", type: "fact", title: "Новая заметка без сессий", body: "", index: "none", rationale: "—", evidence: [] },
				{ op: "deprecate", ref: "d1", id: approved, rationale: "—", evidence: [] },
			],
		});
		const { id } = await run(llm);
		// the update is checked against the proposal's own session
		const verified = JSON.parse(llm.calls.find((c) => c.stage === "verify")?.user ?? "{}").proposals as Array<Checked & { excerpts: string }>;
		expect(verified.map((p) => p.ref)).toEqual(["u1"]);
		expect(verified[0].excerpts).toContain("Всегда пиши changelog");
		const report = (await app.state.run(id))?.report;
		expect(report?.items.map((i) => [i.kind, i.id])).toEqual([
			["removed", stale],
			["updated", changelog],
		]);
		expect(report?.rejected.map((r) => [r.ref, r.reason.includes("recheck")])).toEqual([
			["a1", true],
			["d1", true],
		]);
		const v = await app.reviews.view();
		expect(v.items.map((i) => i.note.id).sort()).toEqual([changelog].sort());
		expect(v.items[0].note.body).toBe("К каждому изменению — запись в changelog.");
		expect((await app.mem.notes()).find((n) => n.id === approved)?.status).toBe("active");
		// The docs now say what the remaining proposal says: a hint for the next pass, never a recheck by itself.
		writeFileSync(join(proj, "docs", "contributing.md"), "# Как вносить изменения\n\n## Правило\n\nВсегда пиши changelog: к каждому изменению — запись в changelog.\n");
		const remaining = v.items[0].note;
		expect(new RepoProbe(proj).docs(`${remaining.title} ${remaining.body}`)[0]?.path).toBe("docs/contributing.md");
		const quiet = new RepoAware();
		await run(quiet);
		expect(quiet.calls).toEqual([]);
	});
});
