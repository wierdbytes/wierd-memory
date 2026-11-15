/**
 * What a project's checkout says about a note now.
 *
 * Dreams propose notes that restate the repository's own docs, and proposals
 * go stale while they wait for review: the code moves on, a type is renamed,
 * a script removed. A probe answers two questions for one checkout: which
 * sections of the project's Markdown say much of the same (`docs`: BM25 over
 * their content, cut by `#`–`###` sections), and which files and code names a
 * text mentions were in the repository and are gone now (`gone`). Both are
 * hints: the curator and the fact checker decide. `gone` errs towards silence
 * — a false "gone" makes the fact check reject a true note as stale, a miss
 * only leaves it to the reviewer — so a name the repository's history never
 * had (a tool's output, another repository, a placeholder) is never a finding.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { findContextFile } from "./agentsmd.ts";
import { isChangelog, repoDocFiles } from "./repodocs.ts";
import { Bm25, snippet, tokenize } from "./search.ts";

/** A section of the project's docs that matches a query. */
export interface DocHit {
	path: string;
	/** The section's heading (`## Build`), "" before the first one. */
	heading: string;
	snippet: string;
}

/** A file or identifier a text mentions: `rel` relative to the checkout, `abs` absolute or `~/`, `ident` a name in code. */
export interface CodeRef {
	token: string;
	kind: "rel" | "abs" | "ident";
}

export interface RepoProbeOptions {
	/** Per git call (history queries get twice this); a call that times out finds nothing gone. */
	timeoutMs?: number;
	/** Lowest BM25 score of a docs hit. */
	minScore?: number;
	/** Share of the query's weight (terms weighted by rarity in the docs) a docs hit must contain. */
	minCoverage?: number;
}

const CHUNK_CHARS = 1500;
const MAX_FILE_BYTES = 512 * 1024;
/** All the docs of one checkout read for a probe; a huge docs folder is cut here. */
const MAX_DOCS_BYTES = 4 * 1024 * 1024;
/** References checked per text: the first ones (in backticks first) say enough. */
const MAX_REFS = 12;
/** git processes one probe runs at a time. */
const GIT_CONCURRENCY = 6;
/** A docs hit must share at least this many distinct terms with the query: one common word is not "the docs say this". */
const MIN_SHARED_TERMS = 3;
/** A docs hit scores at least this share of the best one: the runners-up of one good hit are usually its neighbours. */
const RELATIVE_SCORE = 0.75;
/** History queries (`git log`) one probe runs at most; past it, nothing more is found gone. */
const MAX_HISTORY_LOOKUPS = 48;

/**
 * Split Markdown into sections at `#`–`###` headings outside code fences; a
 * section longer than `maxChars` is cut at line boundaries, not inside a code
 * block unless the block itself is too long.
 */
export function chunkMarkdown(text: string, maxChars = CHUNK_CHARS): Array<{ heading: string; text: string }> {
	const out: Array<{ heading: string; text: string }> = [];
	let heading = "";
	let cur: string[] = [];
	let size = 0;
	let fence = false;
	const flush = () => {
		const body = cur.join("\n").trim();
		if (body) out.push({ heading, text: body });
		cur = [];
		size = 0;
	};
	for (const line of text.split("\n")) {
		const fenceLine = /^\s*(```|~~~)/.test(line);
		const h = !fence && !fenceLine ? /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line) : null;
		if (h) {
			flush();
			heading = `${h[1]} ${h[2].replace(/`/g, "").trim()}`;
		} else if (cur.length && size + line.length > maxChars && (!fence || size > 2 * maxChars)) flush();
		cur.push(line);
		size += line.length + 1;
		if (fenceLine) fence = !fence;
	}
	flush();
	return out;
}

// ── references ───────────────────────────────────────────────────────────

/** Product and platform names that look like code (`GitHub`) and are not the project's own. */
const NOT_CODE = new Set(
	"GitHub GitLab BitBucket TypeScript JavaScript CoffeeScript ActionScript YouTube LinkedIn WhatsApp PowerShell PowerPoint DevTools MacBook AirPods AirDrop AirPlay FaceTime TestFlight CloudFlare DigitalOcean DuckDuckGo StackOverflow HackerNews PlayStation SoundCloud DropBox OneDrive GoogleDrive JetBrains WebStorm PyCharm RubyMine AppCode VirtualBox LaunchAgent LaunchAgents LaunchDaemon LaunchDaemons MacPorts RedHat ArchLinux CocoaPods FastLane TailScale WireGuard LibreOffice OpenOffice NeoVim CodeSandbox CodePen DeepSeek HuggingFace LangChain LlamaIndex OpenRouter AppStore PlayStore GooglePlay ReactNative NextJs NodeJs VsCode WebKit WebAssembly WebSocket WebSockets GraphQL JetStream ProtonMail FireFox LibreWolf QuickTime SpotLight MenuBar TouchBar ClickHouse MongoDb CockroachDb DynamoDb ElasticSearch OpenSearch RabbitMQ ScyllaDb TimescaleDb SuperBase SupaBase LetsEncrypt CircleCi TravisCi JupyterLab PowerToys".split(
		" ",
	),
);
/** A placeholder in a path or name: `thumb-NN`, `news-DD.MM.YY`, `XXX` — a pattern, not a file. */
const PLACEHOLDER = /(^|[^A-Za-z])(N{2,}|X{2,}|Y{2,}|D{2,}|M{2,}|H{2,}|S{2,})(?=$|[^A-Za-z])/;
/** Top-level folders whose files come and go by themselves. */
const TRANSIENT_ROOTS = new Set(["tmp", "private", "var", "dev", "proc", "run", "mnt", "media", "Volumes", "cores"]);

const humps = (t: string) => (t.match(/[A-Z][a-z0-9]+/g) ?? []).length;

/** A name in code: CamelCase with two humps, or (in backticks) lowerCamel / snake_case. */
function identKind(t: string, quoted: boolean): boolean {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) || t.length < 5 || NOT_CODE.has(t)) return false;
	if (t.includes("_")) return quoted && t.length >= 6 && /[A-Za-z]/.test(t.replace(/_/g, "")) && t.split("_").filter(Boolean).length >= 2;
	if (!/[a-z]/.test(t) || !/[A-Z]/.test(t)) return false;
	// UpperCamel: `PhoneCardView`, `CardShape`. lowerCamel: `listRepoDocs`; bare only with two humps (not `iPhone`, `eBay`).
	if (/^[A-Z]/.test(t)) return humps(t) >= 2;
	return humps(t) >= (quoted ? 1 : 2) && t.length >= 6;
}

/** Strip what surrounds a token in prose: quotes, punctuation, call parentheses, `:12` line numbers. */
function clean(raw: string): string {
	return raw
		.replace(/^[("'«“[{]+/, "")
		.replace(/[,;!?"'»”]+$/, "")
		.replace(/[.:]+$/, "")
		.replace(/\([^()]*\)$/, "")
		.replace(/[)\]}]+$/, "")
		.replace(/[.:,;]+$/, "")
		.replace(/:\d+(?::\d+)?$/, "");
}

/** A file name by its extension: `device.sh`, `PhoneCardView.swift`. */
const FILE_NAME =
	/\.(md|mdx|markdown|txt|ts|tsx|js|jsx|mjs|cjs|json|jsonc|json5|jsonl|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|fish|py|rb|go|rs|swift|kt|kts|java|c|h|cc|cpp|hpp|m|mm|cs|sql|html?|css|scss|less|lua|nix|plist|xcconfig|entitlements|gradle|lock|log|csv|xml|svg|png|jpe?g|gif|webp|pdf|vue|svelte|astro|php|pl|exs?|erl|hs|ml|dart|zig|patch|diff)$/i;

function classify(raw: string, quoted: boolean): CodeRef[] {
	const t = clean(raw);
	if (!t || t.length > 200 || /:\/\/|^www\.|@|[<>{}*$…|=?%^[\]\\]|\.\.\.|^-/.test(t) || PLACEHOLDER.test(t)) return [];
	if (t.startsWith("~/") || t.startsWith("/")) return t.split("/").filter(Boolean).length >= 2 ? [{ token: t, kind: "abs" }] : [];
	if (t.includes("/")) {
		const rel = t.replace(/^\.\//, "");
		if (rel.startsWith("../") || rel.startsWith("/") || rel.startsWith("~")) return [];
		return [{ token: rel, kind: "rel" }];
	}
	// A bare file name can be anywhere (or made at run time, like a config file): not checked.
	if (FILE_NAME.test(t)) return [];
	// Dotted and `::` / `#` names are checked by their parts (`cfg.dream.maxNewNotesPerPass` → `maxNewNotesPerPass`); in prose only plain ones.
	const parts = t.split(/::|#|\./);
	if (parts.length > 1 && (!quoted || parts.some((p) => !p))) return [];
	return parts.filter((p) => identKind(p, quoted)).map((p) => ({ token: p, kind: "ident" as const }));
}

/** The files and code names `text` mentions: what is in backticks first, then obvious ones in prose. */
export function codeRefs(text: string): CodeRef[] {
	const out: CodeRef[] = [];
	const seen = new Set<string>();
	const add = (refs: CodeRef[]) => {
		for (const r of refs) {
			if (seen.has(r.token)) continue;
			seen.add(r.token);
			out.push(r);
		}
	};
	const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`([^`\n]+)`/g, (_, span: string) => {
		const words = span.trim().split(/\s+/);
		// One token: a name or a path. Several: a command — only its paths say what must exist.
		if (words.length === 1) add(classify(words[0], true));
		else for (const w of words) if (w.includes("/")) add(classify(w, true));
		return " ";
	});
	for (const w of prose.split(/\s+/)) if (w) add(classify(w, false));
	return out;
}

// ── git ──────────────────────────────────────────────────────────────────

/** `undefined` when git failed or timed out; `code` 1 is git grep's "no match". */
function git(args: string[], timeoutMs: number, maxBuffer = 1 << 20): Promise<{ code: number; stdout: string } | undefined> {
	return new Promise((resolve) => {
		execFile("git", args, { timeout: timeoutMs, maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => {
			if (!err) return resolve({ code: 0, stdout: String(stdout) });
			const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
			resolve(typeof e.code === "number" && !e.killed ? { code: e.code, stdout: String(stdout ?? "") } : undefined);
		});
	});
}

// ── the probe ────────────────────────────────────────────────────────────

type DocMeta = { path: string; heading: string };

export class RepoProbe {
	private index?: Bm25<DocMeta>;
	private tracked?: Promise<{ paths: string[]; names: Set<string> } | undefined>;
	private verdicts = new Map<string, Promise<boolean>>();
	private historyLookups = 0;
	private running = 0;
	private queue: Array<() => void> = [];
	private readonly timeoutMs: number;
	private readonly minScore: number;
	private readonly minCoverage: number;

	constructor(
		readonly root: string,
		opts: RepoProbeOptions = {},
	) {
		this.timeoutMs = opts.timeoutMs ?? 5000;
		this.minScore = opts.minScore ?? 4;
		this.minCoverage = opts.minCoverage ?? 0.18;
	}

	/**
	 * Sections of the project's docs (and its context file) that say much of
	 * what `query` says, best first. BM25 alone ranks, but its sum grows with a
	 * long query: a section that shares only the project's everyday words (its
	 * name, "iPhone", "build") scores high against every note. So a hit must
	 * also cover a share of the query's weight — each term weighted by how rare
	 * it is in the docs — and stay close to the best hit.
	 */
	docs(query: string, k = 3): DocHit[] {
		const index = (this.index ??= this.build());
		const terms = [...new Set(tokenize(query))];
		const weight = terms.reduce((sum, t) => sum + index.idf(t), 0);
		const hits = index.search(query, k * 3);
		const best = hits[0]?.score ?? 0;
		const sections = new Set<string>();
		return hits
			.filter((h) => {
				if (h.score < this.minScore || h.score < RELATIVE_SCORE * best) return false;
				// A long section is cut in parts: one hit per section.
				const section = `${h.doc.meta.path}#${h.doc.meta.heading}`;
				if (sections.has(section)) return false;
				sections.add(section);
				const words = new Set(tokenize(h.doc.text));
				const shared = terms.filter((t) => words.has(t));
				return shared.length >= MIN_SHARED_TERMS && shared.reduce((sum, t) => sum + index.idf(t), 0) >= this.minCoverage * weight;
			})
			.slice(0, k)
			.map((h) => ({ path: h.doc.meta.path, heading: h.doc.meta.heading, snippet: snippet(h.doc.text, query, 360) }));
	}

	/**
	 * Files and code names `text` mentions that were in this repository and
	 * are gone now. A name the repository never had is not a finding: it comes
	 * from a tool's output, another repository or the outside world. Absolute
	 * paths outside the checkout: gone from a folder that is still there.
	 */
	async gone(text: string): Promise<string[]> {
		const refs = codeRefs(text).slice(0, MAX_REFS);
		const gone = await Promise.all(
			refs.map((r) => {
				const key = `${r.kind}:${r.token}`;
				let v = this.verdicts.get(key);
				if (!v) this.verdicts.set(key, (v = this.isGone(r)));
				return v;
			}),
		);
		return refs.filter((_, i) => gone[i]).map((r) => r.token);
	}

	private build(): Bm25<DocMeta> {
		const files = repoDocFiles(this.root).filter((rel) => !isChangelog(rel));
		const ctx = findContextFile(this.root);
		if (ctx && !files.includes(ctx.rel)) files.unshift(ctx.rel);
		const docs: Array<{ id: string; text: string; meta: DocMeta }> = [];
		let total = 0;
		for (const rel of files) {
			let text: string;
			try {
				const path = join(this.root, rel);
				const size = statSync(path).size;
				if (size > MAX_FILE_BYTES || total + size > MAX_DOCS_BYTES) continue;
				total += size;
				text = readFileSync(path, "utf-8");
			} catch {
				continue;
			}
			for (const [i, ch] of chunkMarkdown(text).entries()) docs.push({ id: `${rel}#${i}`, text: ch.text, meta: { path: rel, heading: ch.heading } });
		}
		return new Bm25(docs);
	}

	private async isGone(r: CodeRef): Promise<boolean> {
		if (r.kind === "rel") return this.pathGone(r.token.replace(/\/+$/, ""));
		if (r.kind === "abs") {
			const path = (r.token.startsWith("~/") ? join(homedir(), r.token.slice(2)) : r.token).replace(/\/+$/, "");
			const root = this.root.replace(/\/+$/, "");
			if (path.startsWith(`${root}/`)) return this.pathGone(path.slice(root.length + 1));
			if (TRANSIENT_ROOTS.has(path.split("/")[1] ?? "")) return false;
			if (existsSync(path)) return false;
			// A file removed from a folder that is still there. A whole tree that is not here is a route (`/api/notes`),
			// another machine or something not made yet: nothing to say.
			return existsSync(dirname(path));
		}
		if (!(await this.files())) return false;
		if (await this.inCode(r.token)) return false;
		// Pickaxe: some commit of HEAD's history added or removed it.
		const res = await this.history(["log", "-1", "--format=%h", `-S${r.token}`, "HEAD", "--"]);
		return !!res;
	}

	/** A path relative to the checkout that is not there now and that git once tracked. */
	private async pathGone(rel: string): Promise<boolean> {
		if (!rel || existsSync(join(this.root, rel))) return false;
		const t = await this.files();
		if (!t) return false;
		// Written relative to a package, or moved to another folder under the same name: not gone.
		if (t.names.has(basename(rel)) || t.paths.some((p) => p === rel || p.endsWith(`/${rel}`) || p.startsWith(`${rel}/`))) return false;
		// `owner/repo`, a path of another repository, a build output git ignores: never tracked here, so not a finding.
		const res = await this.history(["log", "-1", "--format=%h", "HEAD", "--", `:(literal)${rel}`, `*/${rel}`]);
		return !!res;
	}

	/** Output of a history query, `undefined` when empty, failed, timed out or over this probe's budget. */
	private async history(args: string[]): Promise<string | undefined> {
		if (++this.historyLookups > MAX_HISTORY_LOOKUPS) return undefined;
		const res = await this.limit(() => git(["-C", this.root, ...args], this.timeoutMs * 2));
		return res?.code === 0 ? res.stdout.trim() || undefined : undefined;
	}

	/** Tracked and untracked (not ignored) files; `undefined` outside git. */
	private files() {
		this.tracked ??= this.limit(() => git(["-C", this.root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], this.timeoutMs * 2, 64 << 20)).then((res) => {
			if (!res || res.code !== 0) return undefined;
			const paths = res.stdout.split("\0").filter(Boolean);
			return { paths, names: new Set(paths.map((p) => basename(p))) };
		});
		return this.tracked;
	}

	/** In a tracked or untracked file now. Only git's own "no match" says no; an error or a timeout says yes. */
	private async inCode(token: string): Promise<boolean> {
		const res = await this.limit(() => git(["-C", this.root, "grep", "-F", "-q", "-I", "--untracked", "-e", token], this.timeoutMs));
		return res?.code !== 1;
	}

	private async limit<T>(fn: () => Promise<T>): Promise<T> {
		if (this.running >= GIT_CONCURRENCY) await new Promise<void>((resolve) => this.queue.push(resolve));
		this.running++;
		try {
			return await fn();
		} finally {
			this.running--;
			this.queue.shift()?.();
		}
	}
}
