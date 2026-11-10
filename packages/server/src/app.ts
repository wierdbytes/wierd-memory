/**
 * The server's core: approved memory (the approved branch of the memory
 * repository) and everything a person or an agent can do to it directly.
 *
 * - Reading: scopes, notes with how each reaches agents, a session's context
 *   (the `<memory>` section), history.
 * - Hand edits (the web UI, the Herdr mod, the CLI): add, edit, move, turn a
 *   note off or on, pin, close, delete, restore an old version. Each is one
 *   commit, made right away — a person needs no review of their own edit.
 *   What dreams propose goes through `reviews.ts` instead.
 * - Edits made behind the server's back are taken in as well: a note file
 *   changed in an editor is committed ("edit by hand"), a commit made or
 *   pulled with git is noticed.
 * - Every change to approved memory is followed by: the open review branch
 *   brought in step, clients told (`rev`), a push to the remote.
 *
 * Mutations run one at a time (`lock`).
 */

import { execFile } from "node:child_process";
import { existsSync, type FSWatcher, mkdirSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
	buildIndex,
	byIndexOrder,
	type CommitInfo,
	type ContextInfo,
	estimateTokens,
	GLOBAL_SCOPE,
	type HomePaths,
	homePaths,
	indexIds,
	INDEX_MODES,
	isNoteId,
	isoMinute,
	keyOfScope,
	loadConfig,
	makeNote,
	newNoteId,
	type Note,
	NOTE_STATUSES,
	NOTE_TYPES,
	type NoteCreate,
	type NoteHistoryEntry,
	type NotePatch,
	type NoteView,
	oneOf,
	projectScope,
	type Reach,
	renderInjection,
	resolveProject,
	sanitize,
	saveConfig,
	type ScopeInfo,
	serverUrl,
	shortKey,
	type StatusInfo,
	today,
	type WmemConfig,
} from "@wierd-memory/core";
import { Dreams } from "./dreams.ts";
import { MAIN, Repo } from "./git.ts";
import { MemoryStore, type ScopeRow } from "./memory.ts";
import { Reviews } from "./reviews.ts";
import { Searcher } from "./searcher.ts";
import { StateStore } from "./state.ts";

export const VERSION = "0.2.0";
export const DREAM_AUTHOR = "wierd-memory dream <dream@wierd-memory.local>";
export const SYSTEM_AUTHOR = "wierd-memory <system@wierd-memory.local>";

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export const notFound = (what: string) => new HttpError(404, `no ${what}`);
export const bad = (why: string) => new HttpError(400, why);

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => resolve(err ? undefined : String(stdout).trim() || undefined));
	});
}

/** `github.com/o/r` → `r`, `local:/a/b/c` → `c`: what lists call a project. */
export function scopeShortName(key: string): string {
	if (key === GLOBAL_SCOPE) return "Global";
	if (key.startsWith("local:")) return basename(key.slice(6)) || key;
	return key.split("/").pop() || key;
}

export interface AppOptions {
	home?: string;
	/** Do not start dreams on a schedule (tests, one-off commands). */
	noSchedule?: boolean;
	log?: (m: string) => void;
}

export class App {
	cfg: WmemConfig;
	readonly paths: HomePaths;
	readonly repo: Repo;
	readonly mem: MemoryStore;
	readonly state: StateStore;
	readonly reviews: Reviews;
	readonly dreams: Dreams;
	readonly searcher: Searcher;
	/** `Name <email>` of the person: the author of hand edits and review decisions. */
	identity = "user <user@localhost>";
	rev = 1;
	readonly startedAt = Date.now();
	/** The remote's address (null: none) and how the last exchange with it went. */
	remote: { url: string | null; lastPush?: string; lastFetch?: string; error?: string } = { url: null };
	private waiters = new Set<(rev: number) => void>();
	private listeners = new Set<(event: { rev: number; kind: string }) => void>();
	private chain: Promise<unknown> = Promise.resolve();
	private pushTimer: ReturnType<typeof setTimeout> | undefined;
	private syncTimer: ReturnType<typeof setInterval> | undefined;
	private adoptTimer: ReturnType<typeof setTimeout> | undefined;
	private watchers: FSWatcher[] = [];
	/** The approved branch may have changed behind the server's back: look before the next mutation. */
	private stale = true;
	/** The commit of the approved branch the server last saw. */
	private knownHead = "";
	private background: boolean;
	readonly log: (m: string) => void;

	private constructor(opts: AppOptions) {
		const home = homePaths(opts.home);
		this.log = opts.log ?? ((m) => console.log(`[${new Date().toISOString()}] ${m}`));
		mkdirSync(home.home, { recursive: true });
		this.cfg = loadConfig(home.config);
		if (!existsSync(home.config)) saveConfig(this.cfg, home.config);
		this.paths = homePaths(home.home, this.cfg.memory.dir);
		this.background = !opts.noSchedule;
		this.repo = new Repo(this.paths.memory, this.cfg.memory.branch, () => this.identity, this.log);
		this.mem = new MemoryStore(this.repo);
		this.state = new StateStore(this.paths);
		this.reviews = new Reviews(this);
		this.dreams = new Dreams(this, !opts.noSchedule);
		this.searcher = new Searcher(this);
	}

	static async start(opts: AppOptions = {}): Promise<App> {
		const app = new App(opts);
		const name = (await run("git", ["config", "--global", "user.name"])) ?? process.env.USER ?? "user";
		const email = (await run("git", ["config", "--global", "user.email"])) ?? `${name}@localhost`;
		app.identity = `${name} <${email}>`;
		await app.repo.ensure(app.cfg.memory.remote);
		for (const dir of [app.paths.logs, app.paths.local, app.paths.dreamLogs, app.paths.digests, app.paths.cards, app.paths.runs, app.paths.reviews, app.paths.inbox]) mkdirSync(dir, { recursive: true });
		await app.mem.ensureScope(MAIN, { id: GLOBAL_SCOPE });
		app.remote.url = await app.repo.remoteUrl(app.cfg.memory.remote);
		app.knownHead = await app.repo.head(MAIN);
		await app.absorbVotes();
		// The open review's branch, checked out and as its last commit left it.
		const open = await app.state.openReview();
		if (open) {
			try {
				await app.repo.ensureWorktree(open.branch, app.cfg.memory.remote);
			} catch (err) {
				app.log(`review ${open.id}: ${err instanceof Error ? err.message : err} — the review is closed`);
				await app.state.saveReview({ ...open, status: "closed", closedAt: new Date().toISOString() });
			}
		}
		await app.lock(async () => undefined); // takes in whatever was edited while the server was down
		await app.dreams.recover();
		app.dreams.schedule();
		if (app.background) {
			app.watch();
			app.syncTimer = setInterval(() => {
				app.stale = true;
				if (app.cfg.memory.sync && app.remote.url) void app.sync().catch(() => undefined);
				else void app.lock(async () => undefined).catch(() => undefined);
			}, 10 * 60_000);
			app.syncTimer.unref?.();
			if (app.cfg.memory.sync && app.remote.url) setTimeout(() => void app.sync().catch(() => undefined), 3000).unref?.();
		}
		return app;
	}

	async stop(): Promise<void> {
		this.dreams.stop();
		for (const w of this.watchers) w.close();
		for (const t of [this.pushTimer, this.adoptTimer]) if (t) clearTimeout(t);
		if (this.syncTimer) clearInterval(this.syncTimer);
		await this.chain.catch(() => undefined);
	}

	// ── plumbing ─────────────────────────────────────────────────────────

	/** Run `fn` after every mutation queued before it — and after taking in what changed behind the server's back. */
	lock<T>(fn: () => Promise<T>): Promise<T> {
		const run = async () => {
			if (this.stale) await this.adopt();
			return fn();
		};
		const next = this.chain.then(run, run);
		this.chain = next.catch(() => undefined);
		return next;
	}

	/** Look now at what changed in the repository behind the server's back (the watcher does it by itself a moment after a change). */
	refresh(): Promise<void> {
		this.stale = true;
		return this.lock(async () => undefined);
	}

	/**
	 * Notice what happened to the approved branch without the server: files
	 * edited by hand are committed (a note written without an id gets one),
	 * commits made or pulled with git are taken as they are.
	 */
	private async adopt(): Promise<void> {
		this.stale = false;
		let changed = false;
		try {
			if ((await this.repo.dirty(MAIN)).length) {
				this.mem.invalidate(MAIN);
				await this.mem.notes(MAIN);
				const files = await this.repo.dirty(MAIN);
				const notes = files.filter((f) => /\/notes\/[^/]+\.md$/.test(f)).length;
				const what = notes === files.length ? `${notes} note${notes === 1 ? "" : "s"}` : `${files.length} file${files.length === 1 ? "" : "s"}`;
				const hash = await this.repo.commit(MAIN, `edit by hand: ${what}\n\n${files.slice(0, 30).join("\n")}${files.length > 30 ? `\n… and ${files.length - 30} more` : ""}`, this.identity);
				if (hash) {
					this.log(`took in a hand edit of ${what} (${hash.slice(0, 8)})`);
					changed = true;
				}
			}
			const head = await this.repo.head(MAIN);
			if (head !== this.knownHead) changed = true;
			if (changed) {
				this.mem.invalidate(MAIN);
				await this.afterMainChange();
			}
		} catch (err) {
			this.log(`could not take in outside changes: ${err instanceof Error ? err.message : err}`);
		}
	}

	/** Look again shortly after something touches the notes or the branch outside the server. */
	private watch(): void {
		const mark = () => {
			this.stale = true;
			if (this.adoptTimer) clearTimeout(this.adoptTimer);
			this.adoptTimer = setTimeout(() => void this.lock(async () => undefined).catch(() => undefined), 1500);
			this.adoptTimer.unref?.();
		};
		const git = join(this.paths.memory, ".git");
		for (const [dir, recursive] of [
			[join(this.paths.memory, "scopes"), true],
			[join(this.paths.memory, "prompts"), true],
			[join(git, "refs", "heads"), true],
		] as const) {
			try {
				this.watchers.push(watch(dir, { recursive }, mark));
			} catch {
				// not there (yet): the periodic look catches it
			}
		}
		try {
			this.watchers.push(watch(git, (_event, file) => (file === "HEAD" || file === "packed-refs" || file === "ORIG_HEAD") && mark()));
		} catch {
			// a linked worktree keeps its git folder elsewhere: the periodic look catches it
		}
		for (const w of this.watchers) w.unref?.();
	}

	/** Tell clients something changed. */
	bump(kind = "change"): void {
		this.rev++;
		for (const w of this.waiters) w(this.rev);
		this.waiters.clear();
		for (const l of this.listeners) l({ rev: this.rev, kind });
	}

	/** Resolves with the current `rev` once it differs from `rev`, or after `timeoutMs`. */
	wait(rev: number, timeoutMs: number): Promise<number> {
		if (rev !== this.rev) return Promise.resolve(this.rev);
		return new Promise((resolve) => {
			const done = (r: number) => {
				clearTimeout(timer);
				this.waiters.delete(done);
				resolve(r);
			};
			const timer = setTimeout(() => done(this.rev), timeoutMs);
			this.waiters.add(done);
		});
	}

	subscribe(fn: (event: { rev: number; kind: string }) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	get url(): string {
		return serverUrl(this.cfg);
	}

	async memver(): Promise<string> {
		return (await this.repo.head(MAIN)).slice(0, 8);
	}

	updateConfig(raw: unknown): WmemConfig {
		const next = sanitize({ ...this.cfg, ...(raw as object) });
		// The port, the repository's folder and the approved branch take effect on restart; everything else right away.
		saveConfig(next, this.paths.config);
		this.cfg = { ...next, port: this.cfg.port, memory: { ...next.memory, dir: this.cfg.memory.dir, branch: this.cfg.memory.branch } };
		this.dreams.configChanged();
		this.bump("config");
		return next;
	}

	/**
	 * After a commit on the approved branch: bring the open review in step,
	 * tell clients, push to the remote.
	 */
	async afterMainChange(): Promise<void> {
		this.knownHead = await this.repo.head(MAIN);
		await this.absorbVotes();
		const open = await this.state.openReview();
		if (open) await this.reviews.sync(open);
		this.bump("memory");
		this.pushSoon();
	}

	/**
	 * pi-dream kept a note's usefulness votes in its file; here they live in the
	 * state. Take over the ones not known yet, before a rewrite of the file drops them.
	 */
	private async absorbVotes(): Promise<void> {
		const legacy = this.mem.legacyStats(MAIN);
		if (!legacy.size) return;
		const known = await this.state.stats();
		for (const [id, s] of legacy) if (!known.has(id)) await this.state.setStats(id, s);
	}

	// ── the remote ───────────────────────────────────────────────────────

	/** Push shortly (several changes in a row go out together). */
	pushSoon(): void {
		if (!this.background || !this.cfg.memory.sync || !this.remote.url) return;
		if (this.pushTimer) clearTimeout(this.pushTimer);
		this.pushTimer = setTimeout(() => void this.push().catch(() => undefined), 3000);
		this.pushTimer.unref?.();
	}

	/** Push the approved branch and the open review's; drop the remote branches of reviews that are over. */
	private async push(): Promise<void> {
		const remote = this.cfg.memory.remote;
		try {
			await this.repo.push(remote, [this.repo.branch]);
		} catch (err) {
			// The remote has commits of its own: take them in, then push again.
			if (/rejected|non-fast-forward|fetch first/i.test(err instanceof Error ? err.message : "")) return void (await this.sync());
			this.remote.error = err instanceof Error ? err.message : String(err);
			throw err;
		}
		try {
			const reviews = await this.state.reviews(200);
			const open = reviews.find((r) => r.status === "open");
			if (open) await this.repo.push(remote, [open.branch], true);
			const over = new Set(reviews.filter((r) => r.status !== "open").map((r) => r.branch));
			const gone = (await this.repo.remoteReviews(remote)).filter((b) => over.has(b));
			await this.repo.pushDelete(remote, gone);
			this.remote.lastPush = new Date().toISOString();
			this.remote.error = undefined;
			this.bump("remote");
		} catch (err) {
			this.remote.error = err instanceof Error ? err.message : String(err);
			throw err;
		}
	}

	/**
	 * Exchange with the remote now: fetch the approved branch and take in what
	 * it has (a merge on GitHub, another machine), then push.
	 */
	async sync(): Promise<string> {
		const remote = this.cfg.memory.remote;
		this.remote.url = await this.repo.remoteUrl(remote);
		if (!this.remote.url) throw bad(`the memory repository has no remote "${remote || "origin"}": git -C ${this.paths.memory} remote add origin <url>`);
		try {
			const state = await this.repo.fetch(remote);
			this.remote.lastFetch = new Date().toISOString();
			let pulled = 0;
			if (state.behind) {
				await this.lock(async () => {
					if (this.stale || (await this.repo.dirty(MAIN)).length) await this.adopt();
					if (!(await this.repo.mergeRemote(remote))) throw new HttpError(409, `${remote}/${this.repo.branch} and the local branch changed the same lines: merge them by hand in ${this.paths.memory}`);
					pulled = state.behind;
					this.mem.invalidate(MAIN);
					await this.afterMainChange();
				});
			}
			if (this.pushTimer) clearTimeout(this.pushTimer);
			await this.push();
			return `in step with ${this.remote.url} (${this.repo.branch})${pulled ? `: took in ${pulled} commit${pulled === 1 ? "" : "s"}` : ""}${state.ahead ? `, pushed ${state.ahead}` : ""}`;
		} catch (err) {
			if (err instanceof HttpError) {
				this.remote.error = err.message;
				throw err;
			}
			this.remote.error = err instanceof Error ? err.message : String(err);
			throw new HttpError(502, `sync failed: ${this.remote.error}`);
		}
	}

	// ── reading ──────────────────────────────────────────────────────────

	/** Notes at a branch, with their usefulness votes. */
	async notes(ref: string = MAIN): Promise<Note[]> {
		const [notes, stats] = await Promise.all([this.mem.notes(ref), this.state.stats()]);
		for (const n of notes) n.stats = stats.get(n.id) ?? { helpful: 0, harmful: 0 };
		return notes;
	}

	budgetOf(scope: string): number {
		return scope === GLOBAL_SCOPE ? this.cfg.budgets.globalTokens : this.cfg.budgets.projectTokens;
	}

	scopeName(id: string, scopes: readonly ScopeRow[]): string {
		if (id === GLOBAL_SCOPE) return "Global";
		const row = scopes.find((s) => s.id === id);
		return scopeShortName(row?.key ?? keyOfScope(id) ?? id);
	}

	/** How each note of a scope reaches agents, given the scope's notes. */
	reachOf(scope: string, notes: readonly Note[]): Map<string, Reach> {
		const included = new Set(buildIndex(notes, scope, this.budgetOf(scope)).included);
		const out = new Map<string, Reach>();
		for (const n of notes) {
			out.set(n.id, n.status !== "active" ? "archived" : !n.enabled ? "off" : n.index === "none" ? "none" : included.has(n.id) ? n.index : "over");
		}
		return out;
	}

	async views(ref: string = MAIN): Promise<NoteView[]> {
		const [notes, scopes] = await Promise.all([this.notes(ref), this.mem.scopes(ref)]);
		const byScope = new Map<string, Note[]>();
		for (const n of notes) {
			const list = byScope.get(n.scope) ?? [];
			list.push(n);
			byScope.set(n.scope, list);
		}
		const out: NoteView[] = [];
		for (const [scope, list] of byScope) {
			const reach = this.reachOf(scope, list);
			const name = this.scopeName(scope, scopes);
			for (const n of [...list].sort(byIndexOrder)) out.push({ ...n, reach: reach.get(n.id) ?? "none", scopeName: name, file: this.mem.fileOf(n.id, ref) });
		}
		return out;
	}

	async view(id: string, ref: string = MAIN): Promise<NoteView> {
		const found = (await this.views(ref)).find((n) => n.id === id);
		if (!found) throw notFound(`note ${id}`);
		return found;
	}

	async scopesInfo(ref: string = MAIN): Promise<ScopeInfo[]> {
		const [notes, scopes] = await Promise.all([this.notes(ref), this.mem.scopes(ref)]);
		const ids = new Set([GLOBAL_SCOPE, ...scopes.map((s) => s.id), ...notes.map((n) => n.scope)]);
		const out: ScopeInfo[] = [];
		for (const id of ids) {
			const row = scopes.find((s) => s.id === id);
			const list = notes.filter((n) => n.scope === id);
			const idx = buildIndex(list, id, this.budgetOf(id));
			const key = id === GLOBAL_SCOPE ? GLOBAL_SCOPE : (row?.key ?? keyOfScope(id) ?? id);
			out.push({
				id,
				key,
				name: scopeShortName(key),
				root: row?.root ?? null,
				charter: row?.charter ?? null,
				budget: this.budgetOf(id),
				index: { ids: idx.included, tokens: idx.tokens, over: idx.dropped.length },
				counts: {
					active: list.filter((n) => n.status === "active" && n.enabled).length,
					off: list.filter((n) => n.status === "active" && !n.enabled).length,
					archived: list.filter((n) => n.status !== "active").length,
				},
			});
		}
		return out.sort((a, b) => Number(b.id === GLOBAL_SCOPE) - Number(a.id === GLOBAL_SCOPE) || a.name.localeCompare(b.name));
	}

	/** What a pi session started in `cwd` gets: its project, the `<memory>` section, skill folders. */
	async context(cwd: string): Promise<ContextInfo> {
		const proj = await resolveProject(cwd);
		const [notes, scopes, memver] = await Promise.all([this.notes(MAIN), this.mem.scopes(MAIN), this.memver()]);
		const own = projectScope(proj.key);
		const has = (id: string) => scopes.some((s) => s.id === id) || notes.some((n) => n.scope === id);
		let scope: string | null = has(own) ? own : null;
		// A subfolder of a project that is not a git repo: the nearest project around it.
		if (!scope) {
			const around = scopes.filter((s) => s.root && (cwd === s.root || cwd.startsWith(`${s.root}/`))).sort((a, b) => (b.root?.length ?? 0) - (a.root?.length ?? 0))[0];
			scope = around?.id ?? null;
		}
		const g = buildIndex(notes.filter((n) => n.scope === GLOBAL_SCOPE), "global", this.cfg.budgets.globalTokens);
		const p = scope ? buildIndex(notes.filter((n) => n.scope === scope), scope, this.cfg.budgets.projectTokens) : undefined;
		const key = scope ? (scopes.find((s) => s.id === scope)?.key ?? proj.key) : proj.key;
		const text = renderInjection({
			memver,
			global: g.body,
			project: p?.body ? { key, body: p.body } : undefined,
			maxTokens: this.cfg.budgets.globalTokens + this.cfg.budgets.projectTokens + 200,
		});
		const skills = this.mem.skillDirs([GLOBAL_SCOPE, ...(scope ? [scope] : [])]);
		return {
			cwd,
			project: { key: proj.key, root: proj.root, name: cwd === homedir() ? "~" : scope ? this.scopeName(scope, scopes) : shortKey(proj.key) },
			scope,
			injection: { text: text ?? null, ids: text ? indexIds(text) : [], tokens: text ? estimateTokens(text) : 0, memver },
			skills,
			inject: this.cfg.inject,
		};
	}

	async status(): Promise<StatusInfo> {
		const [notes, scopes, inbox, memver, review, dream] = await Promise.all([
			this.mem.notes(MAIN),
			this.mem.scopes(MAIN),
			this.state.inbox("pending"),
			this.memver(),
			this.reviews.openSummary(),
			this.dreams.status(1),
		]);
		return {
			version: VERSION,
			home: this.paths.home,
			url: this.url,
			memver,
			rev: this.rev,
			notes: {
				total: notes.length,
				active: notes.filter((n) => n.status === "active" && n.enabled).length,
				off: notes.filter((n) => n.status === "active" && !n.enabled).length,
				archived: notes.filter((n) => n.status !== "active").length,
				scopes: new Set([...scopes.map((s) => s.id), ...notes.map((n) => n.scope)]).size,
			},
			inbox: inbox.length,
			review,
			dream: { running: dream.running, last: dream.last, due: dream.due, scheduled: this.cfg.schedule.enabled },
			git: { dir: this.paths.memory, branch: this.repo.branch, head: this.knownHead },
			remote: { name: this.cfg.memory.remote, url: this.remote.url, sync: this.cfg.memory.sync, lastPush: this.remote.lastPush, lastFetch: this.remote.lastFetch, error: this.remote.error },
		};
	}

	history(limit = 100): Promise<CommitInfo[]> {
		return this.mem.log(limit, MAIN);
	}

	noteHistory(id: string): Promise<NoteHistoryEntry[]> {
		return this.mem.noteHistory(id);
	}

	// ── hand edits of approved memory ────────────────────────────────────

	private message(text: string, actor: string): string {
		return actor ? `${text}\n\nvia ${actor}` : text;
	}

	private async ensureScopeFor(scope: string): Promise<void> {
		if (scope === GLOBAL_SCOPE) return;
		if (!/^projects\/[A-Za-z0-9._-]+$/.test(scope)) throw bad(`bad scope "${scope}"`);
		const scopes = await this.mem.scopes(MAIN);
		if (!scopes.some((s) => s.id === scope)) await this.mem.ensureScope(MAIN, { id: scope, key: keyOfScope(scope) });
	}

	/** Mark a note as the user's own words now: dreams weigh that against older evidence. */
	private stampManual(n: Note): void {
		const date = today();
		n.evidence = [...n.evidence.filter((e) => e.s !== "manual"), { s: "manual", e: [], date, at: isoMinute(Date.now()), kind: "user" }];
	}

	createNote(input: NoteCreate, actor = ""): Promise<NoteView> {
		return this.lock(async () => {
			const title = input.title?.trim();
			if (!title) throw bad("a note needs a title");
			const scope = input.scope?.trim() || GLOBAL_SCOPE;
			await this.ensureScopeFor(scope);
			const taken = await this.mem.noteIds(MAIN);
			const open = await this.state.openReview();
			if (open) for (const id of await this.mem.noteIds(open.branch)) taken.add(id);
			const note = makeNote(
				{
					id: newNoteId(taken),
					scope,
					title,
					body: input.body?.trim() ?? "",
					type: oneOf(NOTE_TYPES, input.type) ? input.type : "fact",
					index: oneOf(INDEX_MODES, input.index) ? input.index : "none",
					when: input.when?.trim() || undefined,
					pinned: input.pinned === true,
				},
				today(),
			);
			this.stampManual(note);
			await this.mem.upsert(MAIN, [note]);
			await this.repo.commit(MAIN, this.message(`add ${note.id}: ${note.title}`, actor), this.identity);
			await this.afterMainChange();
			return this.view(note.id);
		});
	}

	patchNote(id: string, patch: NotePatch, actor = ""): Promise<NoteView> {
		return this.lock(async () => {
			if (!isNoteId(id)) throw bad(`bad note id "${id}"`);
			const n = await this.mem.note(id, MAIN);
			if (!n) throw notFound(`note ${id}`);
			const did: string[] = [];
			let content = false;
			if (typeof patch.title === "string" && patch.title.trim() && patch.title.trim() !== n.title) {
				n.title = patch.title.trim();
				content = true;
			}
			if (typeof patch.body === "string" && patch.body.trim() !== n.body.trim()) {
				n.body = patch.body.trim();
				content = true;
			}
			if (patch.when !== undefined && (patch.when?.trim() || undefined) !== n.when) {
				n.when = patch.when?.trim() || undefined;
				content = true;
			}
			if (oneOf(NOTE_TYPES, patch.type) && patch.type !== n.type) {
				n.type = patch.type;
				content = true;
			}
			if (oneOf(INDEX_MODES, patch.index) && patch.index !== n.index) {
				n.index = patch.index;
				content = true;
			}
			if (content) did.push("edit");
			if (typeof patch.scope === "string" && patch.scope && patch.scope !== n.scope) {
				await this.ensureScopeFor(patch.scope);
				n.scope = patch.scope;
				did.push(`move to ${patch.scope}`);
				content = true;
			}
			if (typeof patch.enabled === "boolean" && patch.enabled !== n.enabled) {
				n.enabled = patch.enabled;
				did.push(patch.enabled ? "turn on" : "turn off");
			}
			if (typeof patch.pinned === "boolean" && patch.pinned !== n.pinned) {
				n.pinned = patch.pinned;
				did.push(patch.pinned ? "pin" : "unpin");
			}
			if (oneOf(NOTE_STATUSES, patch.status) && patch.status !== n.status) {
				if (patch.status === "active") {
					n.validUntil = undefined;
					n.supersededBy = undefined;
					did.push("reopen");
				} else {
					n.validUntil = today();
					did.push(patch.status === "deprecated" ? "close" : "mark superseded");
				}
				n.status = patch.status;
				content = true;
			}
			if (!did.length) return this.view(id);
			if (content) {
				n.updated = today();
				this.stampManual(n);
			}
			await this.mem.upsert(MAIN, [n]);
			await this.repo.commit(MAIN, this.message(`${did.join(", ")} ${n.id}: ${n.title}`, actor), this.identity);
			await this.afterMainChange();
			return this.view(id);
		});
	}

	deleteNote(id: string, actor = ""): Promise<void> {
		return this.lock(async () => {
			const n = await this.mem.note(id, MAIN);
			if (!n) throw notFound(`note ${id}`);
			await this.mem.remove(MAIN, [id]);
			await this.repo.commit(MAIN, this.message(`delete ${n.id}: ${n.title}`, actor), this.identity);
			await this.afterMainChange();
		});
	}

	/** Put a note back as it was after `commit`. */
	restoreNote(id: string, commit: string, actor = ""): Promise<NoteView> {
		return this.lock(async () => {
			const old = (await this.mem.notesAt(commit)).find((n) => n.id === id);
			if (!old) throw notFound(`note ${id} at ${commit}`);
			await this.ensureScopeFor(old.scope);
			await this.mem.upsert(MAIN, [old]);
			const hash = await this.repo.commit(MAIN, this.message(`restore ${id} as of ${commit.slice(0, 8)}: ${old.title}`, actor), this.identity);
			if (hash) await this.afterMainChange();
			return this.view(id);
		});
	}

	setCharter(scope: string, charter: string | null, actor = ""): Promise<void> {
		return this.lock(async () => {
			await this.ensureScopeFor(scope);
			if (scope === GLOBAL_SCOPE) await this.mem.ensureScope(MAIN, { id: GLOBAL_SCOPE });
			await this.mem.setCharter(MAIN, scope, charter);
			const hash = await this.repo.commit(MAIN, this.message(`charter of ${scope}`, actor), this.identity);
			if (hash) await this.afterMainChange();
		});
	}

	setPrompt(name: string, body: string | null, actor = ""): Promise<void> {
		return this.lock(async () => {
			if (!["cards", "curator", "review", "verify", "project_charter"].includes(name)) throw bad(`unknown prompt "${name}"`);
			await this.mem.setPrompt(MAIN, name, body);
			const hash = await this.repo.commit(MAIN, this.message(`prompt ${name}`, actor), this.identity);
			if (hash) await this.afterMainChange();
		});
	}

	deleteSkill(scope: string, name: string, actor = ""): Promise<void> {
		return this.lock(async () => {
			await this.mem.removeSkill(MAIN, scope, name);
			const hash = await this.repo.commit(MAIN, this.message(`delete skill ${scope}/${name}`, actor), this.identity);
			if (hash) await this.afterMainChange();
		});
	}
}
