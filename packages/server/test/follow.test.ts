/**
 * A project's memory follows its key: a folder that had sessions (and notes)
 * as `local:<root>` gets a git remote, and everything of its old scope moves
 * to the remote's — on the approved branch and, for what is only proposed,
 * on the dreams branch. Needs `git` on PATH.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContextInfo, keyToDir, makeNote, type Note, projectScope, type ReviewView, today } from "@wierd-memory/core";
import { App, SYSTEM_AUTHOR } from "../src/app.ts";
import { MAIN } from "../src/git.ts";
import { handleApi } from "../src/http.ts";

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, ...GIT_ENV } }).trim();

let app: App;
let home: string;
let memDir: string;
/** The project folder: a git repository without a remote at first. */
let proj: string;
let oldKey = "";
let oldScope = "";
const newKey = "github.com/o/follow";
const newScope = projectScope(newKey);

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
	const res = await handleApi(app, new Request(`http://127.0.0.1:${app.cfg.port}${path}`, { method, headers: { "x-wmem-client": "test", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }));
	const text = await res.text();
	return { status: res.status, data: (text ? JSON.parse(text) : text) as T };
}

const note = (scope: string, title: string, extra: Partial<Note> = {}): Note => makeNote({ id: extra.id ?? `m-${Math.random().toString(16).slice(2, 8).padEnd(6, "0")}`, scope, title, body: `${title}.`, index: "always", ...extra }, today());

/** Write on a branch and commit, as a dream or a hand edit would. */
async function onBranch(ref: string, fn: () => Promise<void>, message: string): Promise<void> {
	await app.lock(async () => {
		await fn();
		await app.repo.commit(ref, message, SYSTEM_AUTHOR);
		if (ref === MAIN) await app.afterMainChange();
	});
}

const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

beforeAll(async () => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "wmem-follow-")));
	proj = join(home, "proj");
	mkdirSync(proj, { recursive: true });
	sh(proj, "init", "-q");
	oldKey = `local:${proj}`;
	oldScope = projectScope(oldKey);
	writeFileSync(join(home, "config.json"), JSON.stringify({ port: 17534 }));
	app = await App.start({ home, noSchedule: true, log: () => {} });
	memDir = join(home, "memory");
}, 60_000);

afterAll(async () => {
	await app?.stop();
	rmSync(home, { recursive: true, force: true });
});

describe("a folder that gets a git remote", () => {
	const ids = { a: "m-a00001", b: "m-b00002", c: "m-c00003", proposed: "m-d00004", target: "m-e00005" };

	it("starts with memory under local:<root>", async () => {
		const ctx = (await call<ContextInfo>("GET", `/api/context?cwd=${encodeURIComponent(proj)}`)).data;
		expect(ctx.project.key).toBe(oldKey);
		await onBranch(
			MAIN,
			async () => {
				await app.mem.ensureScope(MAIN, { id: oldScope, key: oldKey, root: proj });
				await app.mem.ensureScope(MAIN, { id: newScope, key: newKey });
				await app.mem.setCharter(MAIN, oldScope, "Только про сборку.");
				await app.mem.upsertSkill(MAIN, { scope: oldScope, name: "release-it", description: "How to release", body: "Run make release." });
				// The remote's scope already has a note of the same file name (a dream wrote there before the move).
				await app.mem.upsert(MAIN, [note(oldScope, "Сборка через make", { id: ids.a }), note(oldScope, "Тесты через bun test", { id: ids.b }), note(oldScope, "Деплой по пятницам", { id: ids.c }), note(newScope, "Сборка через make", { id: ids.target })]);
			},
			"the project's notes",
		);
		// What a dream proposed there: a new note, and an edit of an approved one.
		await onBranch(
			app.reviewBranch,
			async () => {
				const b = (await app.mem.note(ids.b, app.reviewBranch)) as Note;
				await app.mem.upsert(app.reviewBranch, [note(oldScope, "Линтер перед коммитом", { id: ids.proposed }), { ...b, body: "bun test --watch" }], { like: MAIN });
			},
			"a dream",
		);
		const v = (await call<ReviewView>("GET", "/api/review")).data;
		expect(v.items.map((i) => `${i.kind}:${i.note.id}:${i.scope}`).sort()).toEqual([`added:${ids.proposed}:${oldScope}`, `updated:${ids.b}:${oldScope}`]);
		// Nothing moves while the folder has no remote.
		expect(await app.followRemotes()).toEqual([]);
	});

	it("moves the scope on both branches when the remote appears", async () => {
		const before = (await call<ReviewView>("GET", "/api/review")).data;
		sh(proj, "remote", "add", "origin", "git@github.com:o/follow.git");
		const moves = await app.followRemotes();
		expect(moves.map((m) => [m.from, m.to])).toEqual([[oldScope, newScope]]);

		// The approved branch: one commit, every note kept with its id; a taken file name gets a suffix.
		const log = await app.history(3);
		expect(log[0].message).toStartWith(`scope ${oldKey} → ${newKey}: the folder got a git remote`);
		expect(log[0].author).toBe("wierd-memory");
		expect(existsSync(join(memDir, "scopes", oldScope))).toBe(false);
		const main = await app.mem.notes(MAIN);
		expect(main.map((n) => `${n.id}:${n.scope}`).sort()).toEqual([ids.a, ids.b, ids.c, ids.target].map((id) => `${id}:${newScope}`));
		const dir = join(memDir, "scopes", newScope);
		expect(files(join(dir, "notes"))).toEqual(["deploy-po-pyatnitsam.md", "sborka-cherez-make-2.md", "sborka-cherez-make.md", "testy-cherez-bun-test.md"].sort());
		expect(app.mem.fileOf(ids.target)).toEndWith("/sborka-cherez-make.md");
		expect(app.mem.fileOf(ids.a)).toEndWith("/sborka-cherez-make-2.md");
		expect(log[0].message).toContain("renamed (the name was taken)");
		expect(readFileSync(join(dir, "charter.md"), "utf-8")).toContain("Только про сборку.");
		expect(existsSync(join(dir, "skills", "release-it", "SKILL.md"))).toBe(true);
		expect(JSON.parse(readFileSync(join(dir, "scope.json"), "utf-8"))).toEqual({ key: newKey, root: proj });
		// The move is a rename: git sees the files as moved, not rewritten.
		const renames = sh(memDir, "show", "--name-status", "-M100%", "--format=", "HEAD").split("\n").filter((l) => /\/notes\//.test(l));
		expect(renames.map((l) => l.split("\t")[0])).toEqual(["R100", "R100", "R100"]);

		// The dreams branch: what was proposed is proposed in the new scope, the same items with the same ids.
		const v = (await call<ReviewView>("GET", "/api/review")).data;
		expect(v.items.map((i) => `${i.kind}:${i.note.id}:${i.scope}`).sort()).toEqual([`added:${ids.proposed}:${newScope}`, `updated:${ids.b}:${newScope}`]);
		expect(v.items.find((i) => i.note.id === ids.b)?.note.body).toBe("bun test --watch");
		expect(before.items.map((i) => i.key).sort()).toEqual(v.items.map((i) => i.key).sort());
		expect(existsSync(join(app.repo.wt(app.reviewBranch), "scopes", oldScope))).toBe(false);
		// Only what is proposed differs between the branches, at the same paths.
		expect(sh(memDir, "diff", "--name-status", "main...dreams").split("\n").sort()).toEqual([`A\tscopes/${newScope}/notes/linter-pered-kommitom.md`, `M\tscopes/${newScope}/notes/testy-cherez-bun-test.md`]);
	});

	it("is done once", async () => {
		const head = await app.repo.head(MAIN);
		const dreams = await app.repo.head(app.reviewBranch);
		expect(await app.followRemotes()).toEqual([]);
		expect([await app.repo.head(MAIN), await app.repo.head(app.reviewBranch)]).toEqual([head, dreams]);
	});

	it("gives sessions there the moved memory, keeps each note's history and lets the review go on", async () => {
		const ctx = (await call<ContextInfo>("GET", `/api/context?cwd=${encodeURIComponent(proj)}`)).data;
		expect([ctx.project.key, ctx.scope]).toEqual([newKey, newScope]);
		expect(ctx.injection.ids).toEqual(expect.arrayContaining([ids.a, ids.b, ids.c]));
		const hist = (await call<Array<{ type: string; message: string }>>("GET", `/api/notes/${ids.a}/history`)).data;
		expect(hist.map((h) => h.type)).toEqual(["modified", "added"]);
		expect(hist[0].message).toContain("the folder got a git remote");
		const v = (await call<ReviewView>("GET", "/api/review")).data;
		const accepted = (await call<ReviewView>("POST", "/api/review/accept", { keys: v.items.map((i) => i.key), versions: Object.fromEntries(v.items.map((i) => [i.key, i.version])) })).data;
		expect(accepted.pending).toBe(0);
		expect((await app.mem.note(ids.proposed, MAIN))?.scope).toBe(newScope);
		expect(existsSync(join(memDir, "scopes", oldScope))).toBe(false);
		expect(sh(memDir, "diff", "--name-status", "main", "dreams")).toBe("");
	});

	it("moves a scope that only a dream proposed, before the next dream starts", async () => {
		const other = join(home, "other");
		mkdirSync(other);
		sh(other, "init", "-q");
		const key = `local:${other}`;
		const scope = projectScope(key);
		await onBranch(
			app.reviewBranch,
			async () => {
				await app.mem.ensureScope(app.reviewBranch, { id: scope, key, root: other });
				await app.mem.upsert(app.reviewBranch, [note(scope, "Первая заметка проекта", { id: "m-f00006" })], { like: MAIN });
			},
			"a dream",
		);
		sh(other, "remote", "add", "origin", "https://github.com/o/other.git");
		const run = await app.dreams.begin("dry");
		const ws = await app.dreams.workspace(run.id);
		const to = projectScope("github.com/o/other");
		expect(ws.notes.find((n) => n.id === "m-f00006")?.scope).toBe(to);
		expect(ws.scopes.some((s) => s.id === scope)).toBe(false);
		expect(existsSync(join(app.repo.wt(app.reviewBranch), "scopes", scope))).toBe(false);
		expect((await app.mem.scopes(app.reviewBranch)).find((s) => s.id === to)?.key).toBe("github.com/o/other");
		const v = (await call<ReviewView>("GET", "/api/review")).data;
		expect(v.items.map((i) => `${i.kind}:${i.scope}`)).toEqual([`added:${to}`]);
		// (not `cancel`: a run begun without a pid of its own is this very process)
		await app.dreams.fail(run.id, "a test");
	});

	it("files inbox items under the folder's current key", async () => {
		const item = await app.state.addInbox({ source: "user", text: "Запомни", cwd: proj, projectKey: oldKey });
		const got = (await call<Array<{ id: string; projectKey: string; scopeId: string }>>("GET", "/api/inbox")).data.find((i) => i.id === item.id);
		expect([got?.projectKey, got?.scopeId]).toEqual([newKey, newScope]);
		expect(keyToDir(newKey)).toBe("github.com__o__follow");
	});
});
