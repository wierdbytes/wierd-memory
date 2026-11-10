/**
 * A whole dream against a real server and its git repository, with scripted models: sessions
 * on disk → digests → cards → curator → fact check → the review.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DreamSubmit, Stage, StageModel, StageUsage } from "@wierd-memory/core";
import { App } from "../../server/src/app.ts";
import { type DreamApi, dream, type DreamLlm, parseRunArgs } from "../pipeline.ts";

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

/** Models that answer from the input they are given. */
class Script implements DreamLlm {
	usage: Partial<Record<Stage, StageUsage>> = {};
	calls: Array<{ stage: Stage; system: string; user: string }> = [];
	review: (input: { comments: Array<{ id: string; note?: string; body: string }> }) => unknown = () => ({ ops: [] });

	totalCost(): number {
		return Object.values(this.usage).reduce((s, u) => s + (u?.cost ?? 0), 0);
	}

	async json<T>(stage: Stage, _spec: StageModel, system: string, user: string, validate: (v: unknown) => T): Promise<T> {
		this.calls.push({ stage, system, user });
		const u = (this.usage[stage] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0, failures: 0 });
		u.calls++;
		u.cost += 0.01;
		return validate(this.answer(stage, system, user));
	}

	private answer(stage: Stage, system: string, user: string): unknown {
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
		if (stage === "analyze" && system.includes("left comments")) return this.review(JSON.parse(user));
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
	writeFileSync(join(home, "config.json"), JSON.stringify({ port: 17633 }));
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

	it("parses the runner's arguments", () => {
		expect(parseRunArgs("--run-id 20261109-1200-abcd --max 5 --since 3")).toEqual({ runId: "20261109-1200-abcd", maxSessions: 5, sinceDays: 3 });
		expect(parseRunArgs("--dry")).toEqual({ mode: "dry" });
		expect(parseRunArgs("--review-only --max x")).toEqual({ mode: "review" });
	});
});
