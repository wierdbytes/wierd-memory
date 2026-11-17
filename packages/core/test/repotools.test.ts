import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { globRegex, RepoTools, repoToolsRoot } from "../src/index.ts";

let base: string;
let root: string;
let plain: string;
let removal = "";

const limits = { maxCalls: 100, maxOutputChars: 1_000_000 };
const tools = (opts: { rg?: false } = {}) => new RepoTools([{ name: "github.com/o/demo", root }], limits, opts);
/** The text of a call without the "calls left" line. */
const text = async (t: RepoTools, name: string, args: unknown) => {
	const r = await t.call(name, args);
	return { ...r, text: r.text.replace(/\n\[tool calls left: [^\]]*\]$/, "") };
};

beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "wmem-tools-"));
	root = join(base, "demo");
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" }).toString();
	for (const dir of ["scripts", "src", "dist", "node_modules/x", "docs"]) mkdirSync(join(root, dir), { recursive: true });
	writeFileSync(join(root, "scripts", "bash-tool.ts"), "/**\n * bash in a herdr pane.\n * The output is capped at 50 lines: longer output goes to a temp file the agent reads.\n */\nexport const cap = 50;\n");
	writeFileSync(join(root, "src", "app.ts"), Array.from({ length: 30 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n") + "\n");
	writeFileSync(join(root, "src", "old.ts"), "export function legacyThing() {\n\treturn 'legacy';\n}\n");
	writeFileSync(join(root, ".gitignore"), "dist/\n.env\n*.local.md\n");
	writeFileSync(join(root, "dist", "bundle.js"), "// capped at 50 lines (built)\n");
	writeFileSync(join(root, "node_modules", "x", "index.js"), "// capped at 50 lines (dependency)\n");
	git("init", "-q");
	git("add", "-A");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
	git("rm", "-q", "src/old.ts");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "drop legacyThing: newThing does it now");
	removal = git("rev-parse", "--short", "HEAD").trim();
	// Not in git: what reviewers found that the docs index never saw.
	mkdirSync(join(root, "companies"));
	writeFileSync(join(root, "companies", "targets.md"), "# Targets\n\n## Как обновлять список\n\nРаз в неделю сверять с вакансиями.\n");
	writeFileSync(join(root, "scripts", "notes.local.md"), "capped at 50 lines (a local note)\n");
	writeFileSync(join(root, ".env"), "API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123\n");
	writeFileSync(join(root, "logo.bin"), Buffer.from([1, 2, 0, 3, 4]));
	// Links: one inside the project, one out of it.
	mkdirSync(join(base, "outside"));
	writeFileSync(join(base, "outside", "secret.txt"), "capped at 50 lines outside\n");
	symlinkSync(join(base, "outside"), join(root, "escape"));
	symlinkSync(join(root, "src", "app.ts"), join(root, "inner.ts"));
	// A folder outside git: nothing tells build outputs, so the usual ones are skipped.
	plain = join(base, "plain");
	for (const dir of ["mods/limits", "build", "node_modules/y"]) mkdirSync(join(plain, dir), { recursive: true });
	writeFileSync(join(plain, "AGENTS.md"), "# Plain\n");
	writeFileSync(join(plain, "mods", "limits", "main.js"), "// limits: shows the 5-hour and weekly usage of the account\n");
	writeFileSync(join(plain, "build", "main.js"), "// limits: built copy\n");
	writeFileSync(join(plain, "node_modules", "y", "main.js"), "// limits: a dependency\n");
});

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("repository tools", () => {
	it("read: numbered lines, a part of a long file, nothing that is not text", async () => {
		const t = tools();
		const r = await text(t, "read", { path: "src/app.ts", offset: 10, limit: 3 });
		expect(r.isError).toBe(false);
		expect(r.text).toBe("src/app.ts — lines 10–12 of 30\n10: export const line10 = 10;\n11: export const line11 = 11;\n12: export const line12 = 12;\n… 18 more line(s): read with offset=13");
		// untracked and ignored files are readable: every file of the project
		expect((await text(t, "read", { path: "companies/targets.md" })).text).toContain("Как обновлять список");
		expect((await text(t, "read", { path: "./scripts/bash-tool.ts" })).text).toContain("3:  * The output is capped at 50 lines");
		expect((await text(t, "read", { path: join(root, "src", "app.ts"), limit: 1 })).text).toContain("1: export const line1 = 1;");
		expect((await text(t, "read", { path: "logo.bin" })).text).toBe("Error: logo.bin is a binary file");
		expect((await text(t, "read", { path: "src" })).text).toBe("Error: src is a folder: use ls or find");
		expect((await text(t, "read", { path: "src/old.ts" })).text).toContain("does not exist");
		// credentials never reach the model
		const env = await text(t, "read", { path: ".env" });
		expect(env.text).toContain("API_KEY=[REDACTED]");
		expect(env.text).not.toContain("sk-ant-");
	});

	it("keeps every path inside the project", async () => {
		const t = tools();
		for (const path of ["../outside/secret.txt", join(base, "outside", "secret.txt"), "/etc/hosts", "~/.ssh/config", "src/../../outside/secret.txt"]) {
			const r = await text(t, "read", { path });
			expect([path, r.isError, r.text]).toEqual([path, true, expect.stringContaining("outside the project")]);
		}
		// a symlink out of the project is refused, one inside it is followed
		expect((await text(t, "read", { path: "escape/secret.txt" })).text).toBe("Error: escape/secret.txt is a symlink that leads outside the project");
		expect((await text(t, "ls", { path: "escape" })).text).toContain("symlink that leads outside");
		expect((await text(t, "read", { path: "inner.ts", limit: 1 })).text).toContain("line1 = 1");
		// git's own files: a remote URL can hold a token
		expect((await text(t, "read", { path: ".git/config" })).text).toContain(".git is git's own data");
		expect((await text(t, "grep", { pattern: "x", path: ".git" })).isError).toBe(true);
		// searches do not follow the link out either
		for (const s of [t, tools({ rg: false })]) {
			expect((await text(s, "grep", { pattern: "lines outside", all: true })).text).toStartWith("no matches");
			expect((await text(s, "find", { pattern: "secret*", all: true })).text).toStartWith("no files match");
		}
	});

	for (const rg of [undefined, false] as const) {
		it(`grep${rg === false ? " (git grep, without ripgrep)" : ""}: comments and untracked files; ignored ones on request; dependencies never`, async () => {
			const t = tools({ rg });
			const hits = (await text(t, "grep", { pattern: "capped at 50 lines" })).text.split("\n");
			expect(hits).toEqual(["scripts/bash-tool.ts:3: * The output is capped at 50 lines: longer output goes to a temp file the agent reads."]);
			// all: what .gitignore excludes too, but not build outputs (dist/) or dependencies
			expect((await text(t, "grep", { pattern: "capped at 50 lines", all: true })).text.split("\n")).toEqual([
				"scripts/bash-tool.ts:3: * The output is capped at 50 lines: longer output goes to a temp file the agent reads.",
				"scripts/notes.local.md:1:capped at 50 lines (a local note)",
			]);
			expect((await text(t, "grep", { pattern: "обновлять", path: "companies" })).text).toBe("companies/targets.md:3:## Как обновлять список");
			expect((await text(t, "grep", { pattern: "OBNOVL|ОБНОВЛЯТЬ", ignore_case: true, glob: "*.md" })).text).toContain("companies/targets.md:3:");
			expect((await text(t, "grep", { pattern: "line1[0-2] =", path: "src", glob: "*.ts" })).text.split("\n")).toHaveLength(3);
			expect((await text(t, "grep", { pattern: "a.b(", literal: true })).text).toStartWith("no matches");
			expect((await text(t, "grep", { pattern: "legacyThing" })).text).toContain("files .gitignore excludes were not searched");
		});
	}

	it("grep: a bad pattern is an error the model reads", async () => {
		const r = await text(tools(), "grep", { pattern: "a(" });
		expect(r.isError).toBe(true);
		expect(await text(tools(), "grep", {})).toEqual({ text: "Error: pattern is required", isError: true });
	});

	it("find and ls: untracked files listed, ignored ones on request, dependencies never", async () => {
		const t = tools();
		expect((await text(t, "find", { pattern: "*.md" })).text).toBe("companies/targets.md");
		expect((await text(t, "find", { pattern: "*.md", all: true })).text).toBe("companies/targets.md\nscripts/notes.local.md");
		expect((await text(t, "find", { pattern: "bash-tool" })).text).toBe("scripts/bash-tool.ts");
		expect((await text(t, "find", { pattern: "src/**/*.ts" })).text).toBe("src/app.ts");
		expect((await text(t, "find", { pattern: "*.js" })).text).toContain("no files match");
		expect((await text(t, "find", { pattern: "*.js", all: true })).text).toContain("no files match");
		// a build output is still readable by its path
		expect((await text(t, "read", { path: "dist/bundle.js" })).text).toContain("(built)");
		expect((await text(t, "find", { pattern: "*", path: "src" })).text).toBe("src/app.ts");
		const ls = (await text(t, "ls", {})).text.split("\n");
		expect(ls).toContain("node_modules/ (not searched)");
		expect(ls).toContain(`escape -> ${join(base, "outside")}`);
		expect(ls).toContain("companies/");
		expect(ls.some((l) => l.startsWith(".git/"))).toBe(false);
		expect(ls.find((l) => l.startsWith(".gitignore"))).toBe(".gitignore (22 bytes)");
	});

	it("git_log and git_show: when and why something went away, and what it was", async () => {
		const t = tools();
		const bySearch = (await text(t, "git_log", { search: "legacyThing" })).text;
		expect(bySearch).toContain(`${removal} `);
		expect(bySearch).toContain("drop legacyThing: newThing does it now");
		expect(bySearch).toContain("D\tsrc/old.ts");
		// a path that is gone still has its history
		expect((await text(t, "git_log", { path: "src/old.ts" })).text.split("\n")).toHaveLength(2);
		expect((await text(t, "git_log", { message: "NEWTHING" })).text).toContain(removal);
		expect((await text(t, "git_log", { search: "never-there" })).text).toBe('no commits adding or removing "never-there"');
		const show = (await text(t, "git_show", { commit: removal })).text;
		expect(show).toContain("drop legacyThing: newThing does it now");
		expect(show).toContain("src/old.ts");
		expect((await text(t, "git_show", { commit: removal, path: "src/old.ts" })).text).toContain("-export function legacyThing() {");
		// no options through the commit argument
		for (const commit of ["--output=/tmp/x", "-p", "HEAD..main", "a b"]) expect((await text(t, "git_show", { commit })).isError).toBe(true);
		expect((await text(t, "git_show", { commit: "deadbeef" })).isError).toBe(true);
	});

	it("a folder outside git: searches skip build outputs and dependencies, git tools say there is no history", async () => {
		for (const rg of [undefined, false] as const) {
			const t = new RepoTools([{ name: "local:plain", root: plain }], limits, { rg });
			expect((await text(t, "grep", { pattern: "limits:" })).text).toBe("mods/limits/main.js:1:// limits: shows the 5-hour and weekly usage of the account");
			expect((await text(t, "find", { pattern: "main.js" })).text).toBe("mods/limits/main.js");
			expect((await text(t, "git_log", {})).text).toBe("Error: local:plain is not a git repository");
		}
	});

	it("reads other projects only by their key, and absolute paths in them", async () => {
		const t = new RepoTools(
			[
				{ name: "github.com/o/demo", root },
				{ name: "local:plain", root: plain },
			],
			limits,
		);
		expect(t.defs.find((d) => d.name === "read")?.parameters).toMatchObject({ properties: { project: { type: "string" } } });
		expect(tools().defs.find((d) => d.name === "read")?.parameters).not.toMatchObject({ properties: { project: {} } });
		expect((await text(t, "read", { path: "mods/limits/main.js", project: "local:plain" })).text).toStartWith("local:plain: mods/limits/main.js — lines 1–1 of 1");
		expect((await text(t, "read", { path: join(plain, "AGENTS.md") })).text).toContain("# Plain");
		expect((await text(t, "read", { path: "AGENTS.md", project: "github.com/x/other" })).text).toContain('unknown project "github.com/x/other"');
		expect(t.projects).toEqual([
			{ project: "github.com/o/demo", root },
			{ project: "local:plain", root: plain },
		]);
	});

	it("keeps to its budget: calls, output per call and per session", async () => {
		const t = new RepoTools([{ name: "demo", root }], { maxCalls: 2, maxOutputChars: 100_000 });
		const first = await t.call("ls", {});
		expect(first.text).toEndWith("[tool calls left: 1]");
		await t.call("nope", {});
		expect(t.left()).toBe(0);
		const refused = await t.call("read", { path: "src/app.ts" });
		expect(refused).toEqual({ text: "Refused: this pass has used 2 tool calls. No more tool calls: reply with your answer now.", isError: true });
		expect(t.stats).toMatchObject({ calls: 2, byTool: { ls: 1, nope: 1 }, errors: 1, capped: true });
		expect(t.trace.map((x) => [x.tool, !!x.error])).toEqual([
			["ls", false],
			["nope", true],
			["read", true],
		]);
		// one call's output is cut; the session's runs out
		const small = new RepoTools([{ name: "demo", root }], { maxCalls: 10, maxOutputChars: 900, callChars: 600 });
		const cut = await small.call("read", { path: "src/app.ts" });
		expect(cut.text).toContain("[output cut at 600 characters");
		expect(cut.text.length).toBeLessThan(700);
		const rest = await small.call("read", { path: "src/app.ts" });
		expect(rest.text).toContain("[output cut at");
		expect(small.left()).toBe(0);
		expect((await small.call("ls", {})).text).toContain("the tool output budget");
		expect(small.stats.outputChars).toBeLessThanOrEqual(900);
	});

	it("is only given real project folders", () => {
		expect(repoToolsRoot(root)).toBe(root);
		expect(repoToolsRoot(homedir())).toBeUndefined();
		expect(repoToolsRoot("/")).toBeUndefined();
		expect(repoToolsRoot(join(base, "missing"))).toBeUndefined();
		expect(repoToolsRoot(join(root, ".gitignore"))).toBeUndefined();
		expect(() => new RepoTools([{ name: "x", root: join(base, "missing") }], limits)).toThrow();
	});

	it("matches globs like a shell", () => {
		expect(globRegex("*.swift").test("PullToSearch.swift")).toBe(true);
		expect(globRegex("*.swift").test("a/PullToSearch.swift")).toBe(false);
		expect(globRegex("**/*.swift").test("PullToSearch.swift")).toBe(true);
		expect(globRegex("**/*.swift").test("App/Views/PullToSearch.swift")).toBe(true);
		expect(globRegex("mods/*/main.{js,ts}").test("mods/limits/main.ts")).toBe(true);
		expect(globRegex("mods/*/main.{js,ts}").test("mods/a/b/main.ts")).toBe(false);
		expect(globRegex("README.MD").test("readme.md")).toBe(true);
		expect(globRegex("[ab].txt").test("b.txt")).toBe(true);
	});
});
