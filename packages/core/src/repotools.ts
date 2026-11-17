/**
 * Read-only tools over a project's checkout, for the dream's models.
 *
 * RepoProbe (repoprobe.ts) answers two fixed questions by itself — which docs
 * sections say much of a text, which names it mentions are gone. Most of what
 * reviewers reject as "already in the repository" is not in Markdown under
 * docs/ though: a script's header, a code comment, a file git does not track,
 * a commit message. These tools let the curator and the fact check look
 * themselves: `read`, `grep`, `find`, `ls`, `git_log`, `git_show`.
 *
 * Confinement: every path resolves inside one of the given roots (the pass's
 * project, and the other projects it may file notes in) — `..`, absolute paths
 * elsewhere and symlinks that lead out are refused, so is `.git` (a remote URL
 * can hold a token). Nothing writes, nothing reaches the network, there is no
 * shell: ripgrep and git run with fixed arguments (`git grep --no-index` when
 * rg is missing), git without external diff drivers or fsmonitor hooks.
 * Every file is readable, untracked ones too (that is the point: notes kept
 * next to the code but outside git). Searches skip binaries and what
 * .gitignore excludes unless `all` is asked for; `node_modules` and `.git`
 * always, and the usual build outputs where .gitignore does not decide (`all`,
 * a folder outside git). Output is scrubbed of credentials
 * (it may end up in a note) and capped per call and per session (`limits`):
 * one RepoTools is one curator pass or one fact-check batch.
 */

import { execFile } from "node:child_process";
import { closeSync, type Dirent, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { scrubSecrets } from "./secrets.ts";

/** A tool as the model sees it (structurally pi-ai's `Tool`). */
export interface ToolDef {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface ToolResult {
	text: string;
	isError: boolean;
}

/** A checkout the tools may read: `name` is the project's key. */
export interface RepoRoot {
	name: string;
	root: string;
}

export interface RepoToolLimits {
	/** Tool calls per session; past it every call is refused. */
	maxCalls: number;
	/** Characters of tool output per session (≈ 4 per token). */
	maxOutputChars: number;
	/** Characters of one call's output. */
	callChars?: number;
}

export interface RepoToolOptions {
	/** The ripgrep binary; false: never (git grep instead). Default: `rg` from PATH when it runs. */
	rg?: string | false;
	/** Per subprocess. */
	timeoutMs?: number;
	/** A line per call (the dream's log): what was asked, how much came back. */
	log?: (line: string) => void;
}

/** What one session used. */
export interface RepoToolStats {
	calls: number;
	outputChars: number;
	byTool: Record<string, number>;
	errors: number;
	/** A call was refused because a limit was reached. */
	capped: boolean;
}

export interface RepoToolTrace {
	tool: string;
	args: unknown;
	chars: number;
	error?: boolean;
}

const CALL_CHARS = 16_000;
/** `read`: lines per call by default and at most. */
const READ_LINES = 250;
const READ_MAX_LINES = 600;
const LINE_CHARS = 500;
/** Files larger than this are not read (grep them). */
const MAX_READ_BYTES = 4_194_304; // 4 MB
const FIND_MAX = 200;
const LS_MAX = 300;
/** Entries a walk of the checkout visits at most. */
const WALK_MAX = 100_000;
const LOG_DEFAULT = 20;
const LOG_MAX = 60;
/** Always skipped by searches: dependencies and git's own files. */
const ALWAYS_SKIP = [".git", "node_modules"];
/** Also skipped where .gitignore does not decide (`all`, or a folder outside git): build outputs, caches, environments. */
const BUILD_DIRS = [
	"dist",
	"build",
	"out",
	"target",
	"vendor",
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	".cache",
	".parcel-cache",
	"coverage",
	".venv",
	"venv",
	"__pycache__",
	".mypy_cache",
	".pytest_cache",
	".tox",
	"Pods",
	"DerivedData",
	".build",
	".gradle",
	".dart_tool",
	".terraform",
	"bower_components",
	".yarn",
	".pnpm-store",
];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const int = (v: unknown, min: number, max: number, fallback: number): number => {
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
};
const bool = (v: unknown): boolean => v === true || v === "true";

class ToolError extends Error {}

interface Root {
	name: string;
	/** As given (paths are shown relative to it). */
	root: string;
	/** With symlinks resolved: what confinement checks against. */
	real: string;
	git?: Promise<boolean>;
}

interface Resolved {
	root: Root;
	/** Relative to the root, "" for the root itself, `/`-separated. */
	rel: string;
	abs: string;
	exists: boolean;
}

/** `undefined` when the program could not run or timed out; `code` 1 is grep's "no match". */
function run(cmd: string, args: string[], cwd: string, timeoutMs: number, maxBuffer = 8 << 20): Promise<{ code: number; stdout: string; stderr: string; cut?: boolean } | undefined> {
	return new Promise((done) => {
		const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" } }, (err, stdout, stderr) => {
			if (!err) return done({ code: 0, stdout: String(stdout), stderr: String(stderr) });
			const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
			// More output than the buffer: what came is enough, and it is cut anyway.
			if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return done({ code: 0, stdout: String(stdout ?? ""), stderr: "", cut: true });
			done(typeof e.code === "number" && !e.killed ? { code: e.code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") } : undefined);
		});
		// Nothing to read: ripgrep without a path would wait for stdin.
		child.stdin?.end();
	});
}

let rgFound: Promise<string | false> | undefined;
/** `rg` when it runs here; asked once per process. */
function findRg(): Promise<string | false> {
	rgFound ??= run("rg", ["--version"], homedir(), 5000).then((r) => (r?.code === 0 ? "rg" : false));
	return rgFound;
}

const GIT = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "-c", "color.ui=false"];

/** `**​/*.swift`, `*bash-tool*`, `src/{a,b}.ts` → a case-insensitive RegExp over a whole path. */
export function globRegex(glob: string): RegExp {
	const esc = (s: string) => s.replace(/[.+^$()|\\/[\]{}*?]/g, "\\$&");
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i++;
				if (glob[i + 1] === "/") {
					i++;
					re += "(?:.*/)?";
				} else re += ".*";
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else if (c === "{" && glob.indexOf("}", i) > i) {
			const end = glob.indexOf("}", i);
			re += `(?:${glob
				.slice(i + 1, end)
				.split(",")
				.map(esc)
				.join("|")})`;
			i = end;
		} else if (c === "[" && glob.indexOf("]", i) > i + 1) {
			const end = glob.indexOf("]", i);
			re += `[${glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
			i = end;
		} else re += esc(c);
	}
	return new RegExp(`^${re}$`, "i");
}

/** A file's start has a NUL byte: not text. */
function isBinary(abs: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(abs, "r");
		const buf = Buffer.alloc(8000);
		const n = readSync(fd, buf, 0, buf.length, 0);
		return buf.subarray(0, n).includes(0);
	} catch {
		return true;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
const toPosix = (p: string) => p.split(sep).join("/");

/** A folder the tools may be given: there, a folder, not the home folder or the file system's root. */
export function repoToolsRoot(root: string | undefined): string | undefined {
	if (!root || !existsSync(root)) return undefined;
	try {
		const real = realpathSync(root);
		if (!statSync(real).isDirectory() || real === realpathSync(homedir()) || real === "/") return undefined;
		return root;
	} catch {
		return undefined;
	}
}

export class RepoTools {
	readonly stats: RepoToolStats = { calls: 0, outputChars: 0, byTool: {}, errors: 0, capped: false };
	readonly trace: RepoToolTrace[] = [];
	readonly defs: ToolDef[];
	private readonly roots: Root[];
	private readonly callChars: number;
	private readonly timeoutMs: number;
	private readonly rg: Promise<string | false>;
	private readonly log?: (line: string) => void;

	constructor(
		roots: RepoRoot[],
		readonly limits: RepoToolLimits,
		opts: RepoToolOptions = {},
	) {
		this.roots = roots.flatMap((r) => {
			try {
				return [{ name: r.name, root: resolve(r.root), real: realpathSync(r.root) }];
			} catch {
				return [];
			}
		});
		if (!this.roots.length) throw new Error("RepoTools: no readable root");
		this.callChars = limits.callChars ?? CALL_CHARS;
		this.timeoutMs = opts.timeoutMs ?? 20_000;
		this.rg = opts.rg === undefined ? findRg() : Promise.resolve(opts.rg);
		this.log = opts.log;
		this.defs = toolDefs(this.roots.length > 1);
	}

	/** The projects as the model is told about them: key → folder. */
	get projects(): Array<{ project: string; root: string }> {
		return this.roots.map((r) => ({ project: r.name, root: r.root }));
	}

	/** Calls left before every call is refused (0 also when the output budget is spent). */
	left(): number {
		if (this.stats.outputChars >= this.limits.maxOutputChars - 200) return 0;
		return Math.max(0, this.limits.maxCalls - this.stats.calls);
	}

	/** Run one tool call. Never throws: a refusal or a failure is an error result the model reads. */
	async call(name: string, args: unknown): Promise<ToolResult> {
		if (this.left() <= 0) {
			this.stats.capped = true;
			this.trace.push({ tool: name, args, chars: 0, error: true });
			const which = this.stats.calls >= this.limits.maxCalls ? `${this.limits.maxCalls} tool calls` : "the tool output budget";
			return { text: `Refused: this pass has used ${which}. No more tool calls: reply with your answer now.`, isError: true };
		}
		this.stats.calls++;
		this.stats.byTool[name] = (this.stats.byTool[name] ?? 0) + 1;
		let text: string;
		let isError = false;
		try {
			const a = isObj(args) ? { ...args } : {};
			// Claude knows Claude Code's Read(file_path): the same thing.
			if (a.path === undefined && typeof a.file_path === "string") a.path = a.file_path;
			switch (name) {
				case "read":
					text = await this.read(a);
					break;
				case "grep":
					text = await this.grep(a);
					break;
				case "find":
					text = await this.find(a);
					break;
				case "ls":
					text = this.ls(a);
					break;
				case "git_log":
					text = await this.gitLog(a);
					break;
				case "git_show":
					text = await this.gitShow(a);
					break;
				default:
					throw new ToolError(`unknown tool "${name}"; the tools are ${this.defs.map((d) => d.name).join(", ")}`);
			}
		} catch (err) {
			isError = true;
			this.stats.errors++;
			text = `Error: ${err instanceof Error ? err.message : String(err)}`;
		}
		const room = Math.min(this.callChars, this.limits.maxOutputChars - this.stats.outputChars);
		text = scrubSecrets(text);
		if (text.length > room) text = `${text.slice(0, Math.max(0, room - 120))}\n… [output cut at ${room} characters: narrow the query, or read with offset/limit]`;
		this.stats.outputChars += text.length;
		this.trace.push({ tool: name, args, chars: text.length, ...(isError ? { error: true } : {}) });
		this.log?.(`${name} ${JSON.stringify(args ?? {}).slice(0, 160)} → ${isError ? text.split("\n")[0].slice(0, 120) : `${text.length} chars`}`);
		const left = this.left();
		const tokensLeft = Math.round((this.limits.maxOutputChars - this.stats.outputChars) / 4);
		return { text: `${text}\n[tool calls left: ${left}${tokensLeft < this.limits.maxOutputChars / 16 ? `, output left: ~${tokensLeft} tokens` : ""}]`, isError };
	}

	// ── paths ────────────────────────────────────────────────────────────

	private rootFor(project: unknown, path?: string): Root {
		const want = str(project)?.replace(/^project:/, "");
		if (want && want !== "project" && want !== "this") {
			const r = this.roots.find((x) => x.name === want);
			if (!r) throw new ToolError(`unknown project "${want}"; readable: ${this.roots.map((x) => x.name).join(", ")}`);
			return r;
		}
		// An absolute path names its own project.
		if (path && (isAbsolute(path) || path.startsWith("~/"))) {
			const abs = resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
			const r = this.roots.find((x) => within(abs, x.root) || within(abs, x.real));
			if (r) return r;
		}
		return this.roots[0];
	}

	/** `path` (relative to the project, or absolute inside it) → where it is; refuses anything outside the project and `.git`. */
	private resolvePath(project: unknown, path: unknown): Resolved {
		const p = str(path)?.replace(/^\.\/+/, "") ?? "";
		const root = this.rootFor(project, p);
		let abs: string;
		if (p.startsWith("~/")) abs = resolve(join(homedir(), p.slice(2)));
		else if (isAbsolute(p)) abs = resolve(p);
		else abs = resolve(root.root, p);
		// The folder may be given by its real path too.
		const base = within(abs, root.root) ? root.root : within(abs, root.real) ? root.real : undefined;
		if (!base) throw new ToolError(`${p} is outside the project (${root.root}); paths are relative to it`);
		const rel = toPosix(relative(base, abs));
		if (rel.split("/").includes(".git")) throw new ToolError(".git is git's own data: use git_log / git_show");
		let exists = false;
		try {
			// Symlinks are followed only as far as they stay inside the project.
			const real = realpathSync(abs);
			if (!within(real, root.real)) throw new ToolError(`${rel} is a symlink that leads outside the project`);
			if (toPosix(relative(root.real, real)).split("/").includes(".git")) throw new ToolError(".git is git's own data: use git_log / git_show");
			exists = true;
		} catch (err) {
			if (err instanceof ToolError) throw err;
			// Not there (a removed file, for git_log); a link into nowhere is refused below.
			try {
				lstatSync(abs);
				throw new ToolError(`${rel} is a broken symlink`);
			} catch (e) {
				if (e instanceof ToolError) throw e;
			}
		}
		return { root, rel, abs, exists };
	}

	private isGit(root: Root): Promise<boolean> {
		root.git ??= run("git", [...GIT, "rev-parse", "--is-inside-work-tree"], root.root, this.timeoutMs).then((r) => r?.code === 0 && r.stdout.trim() === "true");
		return root.git;
	}

	/** Searches skip these folders: always dependencies and `.git`; build outputs too where .gitignore does not decide. */
	private async skipDirs(root: Root, all: boolean): Promise<string[]> {
		return all || !(await this.isGit(root)) ? [...ALWAYS_SKIP, ...BUILD_DIRS] : ALWAYS_SKIP;
	}

	// ── tools ────────────────────────────────────────────────────────────

	private async read(a: Record<string, unknown>): Promise<string> {
		if (!str(a.path)) throw new ToolError("path is required");
		const r = this.resolvePath(a.project, a.path);
		if (!r.exists) throw new ToolError(`${r.rel} does not exist (find or git_log -- path for a removed file)`);
		const st = statSync(r.abs);
		if (st.isDirectory()) throw new ToolError(`${r.rel || "."} is a folder: use ls or find`);
		if (!st.isFile()) throw new ToolError(`${r.rel} is not a regular file`);
		if (st.size > MAX_READ_BYTES) throw new ToolError(`${r.rel} is too large to read (${(st.size / 1048576).toFixed(1)} MB): grep it`);
		if (isBinary(r.abs)) throw new ToolError(`${r.rel} is a binary file`);
		const lines = readFileSync(r.abs, "utf-8").split("\n");
		if (lines.length > 1 && lines.at(-1) === "") lines.pop();
		const from = int(a.offset, 1, Math.max(1, lines.length), 1);
		const count = int(a.limit, 1, READ_MAX_LINES, READ_LINES);
		const to = Math.min(lines.length, from + count - 1);
		const out = [`${this.label(r)} — lines ${from}–${to} of ${lines.length}`];
		for (let i = from; i <= to; i++) {
			const line = lines[i - 1];
			out.push(`${i}: ${line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)} …` : line}`);
		}
		if (to < lines.length) out.push(`… ${lines.length - to} more line(s): read with offset=${to + 1}`);
		return out.join("\n");
	}

	private async grep(a: Record<string, unknown>): Promise<string> {
		const pattern = typeof a.pattern === "string" ? a.pattern : "";
		if (!pattern) throw new ToolError("pattern is required");
		const r = this.resolvePath(a.project, a.path);
		if (!r.exists) throw new ToolError(`${r.rel} does not exist`);
		const all = bool(a.all);
		const literal = bool(a.literal);
		const ignoreCase = bool(a.ignore_case);
		const context = int(a.context, 0, 3, 0);
		const glob = str(a.glob);
		const skip = await this.skipDirs(r.root, all);
		const rg = await this.rg;
		let res: Awaited<ReturnType<typeof run>>;
		if (rg) {
			const args = ["--no-config", "--hidden", "--line-number", "--with-filename", "--no-heading", "--color", "never", "--max-columns", "400", "--max-columns-preview", "--max-count", "30", "--max-filesize", "4M", "--sort", "path"];
			if (all) args.push("--no-ignore");
			for (const d of skip) args.push("-g", `!${d}`);
			if (glob) args.push("-g", glob);
			if (literal) args.push("-F");
			if (ignoreCase) args.push("-i");
			if (context) args.push("-C", String(context));
			args.push("-e", pattern, "--", r.rel || ".");
			res = await run(rg, args, r.root.root, this.timeoutMs);
		} else {
			// git grep reads plain folders too (--no-index); .gitignore only by request.
			const args = [...GIT, "grep", "--no-index", "-n", "-I", "--no-color", literal ? "-F" : "-E"];
			if (!all) args.push("--exclude-standard");
			if (ignoreCase) args.push("-i");
			if (context) args.push("-C", String(context));
			// Pathspecs add up: the folder and the glob go into one.
			const under = r.rel ? `${r.rel}/` : "";
			args.push("-e", pattern, "--", glob ? `:(glob)${under}${glob.includes("/") ? glob : `**/${glob}`}` : r.rel || ".");
			for (const d of skip) args.push(`:(exclude)${d}`, `:(exclude)**/${d}/**`);
			res = await run("git", args, r.root.root, this.timeoutMs);
		}
		if (!res) throw new ToolError("the search did not finish in time: narrow it with path or glob");
		const out = res.stdout.replace(/^\.\//gm, "").trimEnd();
		if (!out) {
			if (res.code > 1) throw new ToolError(res.stderr.trim().split("\n")[0] || `search failed (${res.code})`);
			return `no matches for ${JSON.stringify(pattern)} in ${this.label(r)}${all ? "" : " (files .gitignore excludes were not searched: all=true searches them)"}`;
		}
		return `${res.cut ? "[many matches, the first shown]\n" : ""}${out}`;
	}

	private async find(a: Record<string, unknown>): Promise<string> {
		const pattern = str(a.pattern) ?? "*";
		const r = this.resolvePath(a.project, a.path);
		if (!r.exists) throw new ToolError(`${r.rel} does not exist`);
		const all = bool(a.all);
		const glob = /[*?[{]/.test(pattern) ? pattern : `*${pattern}*`;
		const re = globRegex(glob);
		// Without a slash a pattern is about the file's name; with one, about its path from the project's folder.
		const byName = !glob.includes("/");
		const prefix = r.rel ? `${r.rel}/` : "";
		const files = await this.files(r.root, all, r.rel);
		let hits = files.list.filter((f) => (!prefix || f.startsWith(prefix)) && re.test(byName ? (f.split("/").pop() ?? f) : f));
		// The index lists a file deleted from the working tree until it is committed.
		hits = hits.filter((f) => existsSync(join(r.root.root, f)));
		if (!hits.length) return `no files match ${JSON.stringify(pattern)} in ${this.label(r)}${all ? "" : " (files .gitignore excludes were not listed: all=true lists them)"}`;
		const shown = hits.slice(0, FIND_MAX);
		return [...shown, ...(hits.length > FIND_MAX ? [`… ${hits.length - FIND_MAX} more: narrow the pattern or path`] : []), ...(files.cut ? ["… the listing stopped early: the folder is very large"] : [])].join("\n");
	}

	/** The project's files, relative: in git what is tracked or untracked and not ignored, else (or `all`) a walk without the skipped folders. */
	private async files(root: Root, all: boolean, under: string): Promise<{ list: string[]; cut: boolean }> {
		if (!all && (await this.isGit(root))) {
			const res = await run("git", [...GIT, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", under ? `:(literal)${under}` : "."], root.root, this.timeoutMs, 64 << 20);
			if (res?.code === 0) return { list: [...new Set(res.stdout.split("\0").filter(Boolean))].filter((f) => !f.split("/").some((s) => ALWAYS_SKIP.includes(s))).sort(), cut: !!res.cut };
		}
		const skip = new Set(await this.skipDirs(root, true));
		const list: string[] = [];
		let visited = 0;
		const walk = (rel: string): boolean => {
			let entries: Dirent[];
			try {
				entries = readdirSync(join(root.root, rel), { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name));
			} catch {
				return true;
			}
			for (const e of entries) {
				if (++visited > WALK_MAX) return false;
				const path = rel ? `${rel}/${e.name}` : e.name;
				// A symlinked folder is not followed: it may lead outside, and read checks a linked file on its own.
				if (e.isDirectory()) {
					if (!skip.has(e.name) && !walk(path)) return false;
				} else if (e.isFile() || e.isSymbolicLink()) list.push(path);
			}
			return true;
		};
		const cut = !walk(under);
		return { list, cut };
	}

	private ls(a: Record<string, unknown>): string {
		const r = this.resolvePath(a.project, a.path);
		if (!r.exists) throw new ToolError(`${r.rel} does not exist`);
		if (!statSync(r.abs).isDirectory()) throw new ToolError(`${r.rel} is a file: use read`);
		const entries = readdirSync(r.abs, { withFileTypes: true })
			.filter((e) => e.name !== ".git")
			.sort((x, y) => x.name.localeCompare(y.name));
		const out = [`${this.label(r)}/`];
		for (const e of entries.slice(0, LS_MAX)) {
			const path = join(r.abs, e.name);
			if (e.isSymbolicLink()) {
				let target = "?";
				try {
					target = readlinkSync(path);
				} catch {
					// unreadable link: shown without its target
				}
				out.push(`${e.name} -> ${target}`);
			} else if (e.isDirectory()) out.push(`${e.name}/${ALWAYS_SKIP.includes(e.name) || BUILD_DIRS.includes(e.name) ? " (not searched)" : ""}`);
			else if (e.isFile()) {
				let size = "";
				try {
					size = ` (${statSync(path).size} bytes)`;
				} catch {
					// gone meanwhile
				}
				out.push(`${e.name}${size}`);
			} else out.push(`${e.name} (not a regular file)`);
		}
		if (entries.length > LS_MAX) out.push(`… ${entries.length - LS_MAX} more`);
		return out.join("\n");
	}

	private async gitLog(a: Record<string, unknown>): Promise<string> {
		const r = this.resolvePath(a.project, a.path);
		if (!(await this.isGit(r.root))) throw new ToolError(`${r.root.name} is not a git repository`);
		const max = int(a.max, 1, LOG_MAX, LOG_DEFAULT);
		const args = [...GIT, "log", "--no-ext-diff", "--no-textconv", "--date=short", "--format=%h %ad %an: %s", `-n${max}`];
		const search = typeof a.search === "string" && a.search ? a.search : undefined;
		const message = str(a.message);
		if (search) args.push(`-S${search}`);
		if (message) args.push("-i", "-E", `--grep=${message}`);
		// Which files a commit touched tells a removal from an edit.
		if (bool(a.files) || search) args.push("--name-status");
		args.push("HEAD", "--");
		if (r.rel) args.push(`:(literal)${r.rel}`);
		const res = await run("git", args, r.root.root, this.timeoutMs * 2);
		if (!res) throw new ToolError("git log did not finish in time: narrow it with path");
		if (res.code !== 0) throw new ToolError(res.stderr.trim().split("\n")[0] || `git log failed (${res.code})`);
		const out = res.stdout.trim();
		return out || `no commits${search ? ` adding or removing ${JSON.stringify(search)}` : ""}${message ? ` with ${JSON.stringify(message)} in the message` : ""}${r.rel ? ` touching ${r.rel}` : ""}`;
	}

	private async gitShow(a: Record<string, unknown>): Promise<string> {
		const commit = str(a.commit);
		if (!commit || !/^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,99}$/.test(commit) || commit.includes("..")) throw new ToolError("commit: a commit hash or a ref like HEAD~2");
		const r = this.resolvePath(a.project, a.path);
		if (!(await this.isGit(r.root))) throw new ToolError(`${r.root.name} is not a git repository`);
		const args = [...GIT, "show", "--no-ext-diff", "--no-textconv", "--date=short", "--format=commit %H%nAuthor: %an%nDate: %ad%n%n%B"];
		// Without a path: the message and which files changed; with one: that file's change (a removal shows what was there).
		if (!r.rel) args.push("--stat=160");
		args.push("--end-of-options", commit, "--");
		if (r.rel) args.push(`:(literal)${r.rel}`);
		const res = await run("git", args, r.root.root, this.timeoutMs * 2);
		if (!res) throw new ToolError("git show did not finish in time");
		if (res.code !== 0) throw new ToolError(res.stderr.trim().split("\n")[0] || `git show failed (${res.code})`);
		return res.stdout.trimEnd() || "nothing";
	}

	private label(r: Resolved): string {
		const where = this.roots.length > 1 ? `${r.root.name}: ` : "";
		return `${where}${r.rel || "."}`;
	}
}

function toolDefs(several: boolean): ToolDef[] {
	const project = several ? { project: { type: "string", description: "Key of the project to read (from repo_access.projects); default: this pass's project" } } : {};
	const path = (what: string) => ({ path: { type: "string", description: `${what}, relative to the project's folder (an absolute path inside it works too)` } });
	const all = { all: { type: "boolean", description: "Also files .gitignore excludes (build outputs, local files); dependencies and .git stay out. Default false" } };
	const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: { ...properties, ...project }, required, additionalProperties: false });
	return [
		{
			name: "read",
			description: "Read a text file of the project, with line numbers. Files git does not track are readable too. Long files: read a part with offset/limit.",
			parameters: obj({ ...path("The file"), offset: { type: "integer", minimum: 1, description: "First line, 1-based (default 1)" }, limit: { type: "integer", minimum: 1, maximum: READ_MAX_LINES, description: `Lines to read (default ${READ_LINES})` } }, ["path"]),
		},
		{
			name: "grep",
			description:
				"Search the contents of the project's files for a regular expression (ripgrep syntax): code, comments, scripts' headers, Markdown anywhere, files git does not track. Answers path:line:text, at most 30 matches per file. Binaries, dependencies and .git are skipped; so are files .gitignore excludes unless all=true.",
			parameters: obj(
				{
					pattern: { type: "string", description: "Regular expression (or literal text with literal=true)" },
					...path("A folder or file to search in (default: the whole project)"),
					glob: { type: "string", description: "Only files whose path matches this glob, e.g. *.swift or src/**/*.ts" },
					literal: { type: "boolean", description: "Treat pattern as plain text" },
					ignore_case: { type: "boolean", description: "Case-insensitive" },
					context: { type: "integer", minimum: 0, maximum: 3, description: "Lines of context around each match" },
					...all,
				},
				["pattern"],
			),
		},
		{
			name: "find",
			description: `Find files of the project by name or path. pattern: a glob (*.md, **/scripts/*.sh, src/**/Card*) — without a slash it matches file names — or plain text a path contains. Untracked files are listed; dependencies and .git are not, nor files .gitignore excludes unless all=true. At most ${FIND_MAX} paths.`,
			parameters: obj({ pattern: { type: "string", description: "Glob or text" }, ...path("A folder to look in (default: the whole project)"), ...all }, ["pattern"]),
		},
		{
			name: "ls",
			description: "List one folder of the project: sub-folders (with a trailing /), files with their size, symlinks with their target.",
			parameters: obj(path("The folder (default: the project's folder)")),
		},
		{
			name: "git_log",
			description:
				"The project's git history (HEAD), newest first: hash, date, author, subject. search: commits that added or removed this exact text (git log -S) — when and why a name or a piece of code went away, with the files they touched. message: commits whose message matches this regular expression. path: commits touching this file or folder, also one that no longer exists.",
			parameters: obj({
				...path("Only commits touching this file or folder"),
				search: { type: "string", description: "Text a commit added or removed (git log -S)" },
				message: { type: "string", description: "Regular expression for the commit message (case-insensitive)" },
				files: { type: "boolean", description: "List the files each commit changed" },
				max: { type: "integer", minimum: 1, maximum: LOG_MAX, description: `Commits to show (default ${LOG_DEFAULT})` },
			}),
		},
		{
			name: "git_show",
			description: "One commit: its full message and which files it changed; with path, that file's diff in the commit (for a removed file: what it contained).",
			parameters: obj({ commit: { type: "string", description: "A commit hash (or a ref like HEAD~3)" }, ...path("Show this file's change in the commit") }, ["commit"]),
		},
	];
}
