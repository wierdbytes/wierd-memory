import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chunkMarkdown, codeRefs, listRepoDocs, RepoProbe, repoDocFiles } from "../src/index.ts";

let root: string;
let plain: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "wmem-probe-"));
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
	for (const dir of ["docs", "scripts", "Sources/App", "packages/a/src"]) mkdirSync(join(root, dir), { recursive: true });
	writeFileSync(join(root, "README.md"), "# Demo\n\nA demo app.\n\n## Build\n\nRun `scripts/device.sh` to install the app on a connected phone.\n");
	writeFileSync(
		join(root, "docs", "live-activity.md"),
		"# Live Activity\n\n## Pitfalls\n\nThe live activity widget stops updating when the push token expires; request a new push token on every app launch.\n\n```sh\n# not a heading: a comment\nxcrun simctl push booted\n```\n",
	);
	writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## 1.0\n\nPush token refresh on launch for the live activity widget.\n");
	writeFileSync(join(root, "AGENTS.md"), "# Agents\n\nRelease builds are signed by the keychain profile `demo-release`; never commit the provisioning profile.\n");
	writeFileSync(join(root, "scripts", "device.sh"), "#!/bin/sh\necho device\n");
	writeFileSync(join(root, "Sources", "App", "PhoneCardView.swift"), "struct PhoneCardView { let snake_case_name = 1 }\n");
	writeFileSync(join(root, "packages", "a", "src", "app.ts"), "export function listThings() {}\n");
	writeFileSync(join(root, ".gitignore"), "packages/*/dist/\n");
	// What the repository had and removed since.
	writeFileSync(join(root, "Sources", "App", "Old.swift"), "struct PhoneListGestures {}\nstruct KeyPanelLayer { let gone_name_x = 1 }\n");
	writeFileSync(join(root, "scripts", "old.sh"), "#!/bin/sh\n");
	writeFileSync(join(root, "docs", "BUILD.md"), "Build it.\n");
	git("init", "-q");
	git("add", "-A");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
	git("rm", "-q", "Sources/App/Old.swift", "scripts/old.sh", "docs/BUILD.md");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "remove");
	// Untracked (not ignored) files count too: the code of the work in progress.
	writeFileSync(join(root, "Sources", "App", "Draft.swift"), "struct DraftPanelView {}\n");
	plain = mkdtempSync(join(tmpdir(), "wmem-probe-plain-"));
	mkdirSync(join(plain, "scripts"));
	writeFileSync(join(plain, "scripts", "run.sh"), "");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(plain, { recursive: true, force: true });
});

describe("repository probe", () => {
	it("lists the doc files with the context file; listRepoDocs leaves it out", () => {
		expect(repoDocFiles(root)).toEqual(["README.md", "AGENTS.md", "CHANGELOG.md", "docs/live-activity.md"]);
		expect(listRepoDocs(root)).toEqual(["README.md: # Demo · ## Build", "CHANGELOG.md", "docs/live-activity.md: # Live Activity · ## Pitfalls"]);
	});

	it("cuts Markdown by sections, not inside code blocks", () => {
		const text = `# A\n\nintro\n\n## B\n\n${"word ".repeat(60)}\n${"more ".repeat(60)}\n\n\`\`\`\n# not a heading\n${"code ".repeat(50)}\n\`\`\`\n### C\nlast`;
		const chunks = chunkMarkdown(text, 400);
		expect(chunks.map((c) => c.heading)).toEqual(["# A", "## B", "## B", "### C"]);
		// the code block stays whole, with its comment line
		expect(chunks[2].text.startsWith("more")).toBe(true);
		expect(chunks[2].text).toContain("# not a heading");
		expect(chunks[2].text.endsWith("```")).toBe(true);
	});

	it("finds the section that already says it, and nothing for an unrelated text", () => {
		const probe = new RepoProbe(root);
		const hits = probe.docs("Live activity widget stops updating: the push token expires, request a new push token on app launch");
		expect(hits[0]).toMatchObject({ path: "docs/live-activity.md", heading: "## Pitfalls" });
		expect(hits[0].snippet).toContain("push token");
		// the changelog is history, not documentation
		expect(hits.some((h) => h.path === "CHANGELOG.md")).toBe(false);
		// the context file is searched too
		expect(probe.docs("release builds signed keychain profile demo-release provisioning")[0]?.path).toBe("AGENTS.md");
		expect(probe.docs("the user prefers short answers in Russian")).toEqual([]);
		// a long text about something else that shares a few everyday words of the docs: no hit
		const other = "Podcast decks: the phone app intro covers the push topic, the hosts on the cover, music cues, a new launch date every week and the research sources for the news";
		expect(new RepoProbe(root, { minCoverage: 0 }).docs(other).length).toBeGreaterThan(0);
		expect(probe.docs(other)).toEqual([]);
	});

	it("picks the code references a text makes", () => {
		const refs = codeRefs(
			"Use `PhoneCardView` (see `Sources/App/PhoneCardView.swift:12`), `./scripts/device.sh --fast`, `cfg.dream.maxNewNotesPerPass`, `snake_case_name`, `listThings()`. KeyPanelLayer, GitHub, TypeScript, iPhone, `bun test`, `config.json`, https://example.com/a/b, owner/repo, ~/x/y.md, /api/notes.",
		);
		expect(refs).toEqual([
			{ token: "PhoneCardView", kind: "ident" },
			{ token: "Sources/App/PhoneCardView.swift", kind: "rel" },
			{ token: "scripts/device.sh", kind: "rel" },
			{ token: "maxNewNotesPerPass", kind: "ident" },
			{ token: "snake_case_name", kind: "ident" },
			{ token: "listThings", kind: "ident" },
			{ token: "KeyPanelLayer", kind: "ident" },
			{ token: "owner/repo", kind: "rel" },
			{ token: "~/x/y.md", kind: "abs" },
			{ token: "/api/notes", kind: "abs" },
		]);
	});

	it("says which of them the repository had and has no more, and keeps quiet when unsure", async () => {
		const probe = new RepoProbe(root);
		// in the code now (tracked or not), or removed from it
		expect(await probe.gone("`PhoneCardView` and `DraftPanelView` stay; `PhoneListGestures` was removed, KeyPanelLayer and `gone_name_x` too.")).toEqual(["PhoneListGestures", "gone_name_x", "KeyPanelLayer"]);
		// never in this repository: a field of a tool's output, an error string of another program
		expect(await probe.gone("`transportType` of `devicectl --json-output`, `XCTDaemonErrorDomain`, `CardShape`.")).toEqual([]);
		// paths: removed ones are gone; one relative to its package, another repository's, a build output are not
		expect(await probe.gone("`scripts/device.sh` stays, `scripts/old.sh` and `docs/BUILD.md` are gone; `src/app.ts`, `docs/labels.md`, owner/repo, `packages/a/dist/bundle.js`.")).toEqual(["scripts/old.sh", "docs/BUILD.md"]);
		// absolute paths: inside the checkout by its history; outside, a file missing from a folder that is there
		expect(await probe.gone(`\`${join(root, "scripts", "old.sh")}\` and \`${join(root, "README.md")}\``)).toEqual([join(root, "scripts", "old.sh")]);
		expect(await probe.gone("`/usr/bin/definitely-not-a-binary-wmem`, `/usr/definitely-not-here-wmem/x`, /api/notes, /tmp/nothing/here, `~/definitely-not-here-wmem/x.md`")).toEqual(["/usr/bin/definitely-not-a-binary-wmem"]);
		expect(await probe.gone(`${homedir()}/ is there`)).toEqual([]);
		// placeholders are patterns, not files
		expect(codeRefs("`~/me/yt/thumb-NN/`, `news-DD.MM.YY`, `scripts/XXX.sh`, `docs/<name>.md`")).toEqual([]);
	});

	it("finds nothing gone outside git: there is no history to say what was there", async () => {
		const probe = new RepoProbe(plain);
		expect(await probe.gone("`scripts/run.sh`, `scripts/gone.sh`, `PhoneListGestures`")).toEqual([]);
		expect(probe.docs("anything at all here")).toEqual([]);
	});
});
