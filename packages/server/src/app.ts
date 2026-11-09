/**
 * The server's core: approved memory (`main`) and everything a person or an
 * agent can do to it directly.
 *
 * - Reading: scopes, notes with how each reaches agents, a session's context
 *   (the `<memory>` section), history.
 * - Hand edits (the web UI, the Herdr mod, the CLI): add, edit, move, turn a
 *   note off or on, pin, close, delete, restore an old version. Each is one
 *   commit on `main`, made right away — a person needs no review of their own
 *   edit. What dreams propose goes through `reviews.ts` instead.
 * - Every change to `main` is followed by: the open review branch brought in
 *   step, skills written out for pi, clients told (`rev`), an optional push
 *   to the remote.
 *
 * Mutations run one at a time (`lock`).
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
} from "@wierd-mem/core";
import { Db, DoltServer, MAIN, MEMORY_DB } from "./dolt.ts";
import { Dreams } from "./dreams.ts";
import { MemoryStore, type ScopeRow } from "./memory.ts";
import { Reviews } from "./reviews.ts";
import { ensureSchema } from "./schema.ts";
import { Searcher } from "./searcher.ts";
import { StateStore } from "./state.ts";

export const VERSION = "0.1.0";
export const DREAM_AUTHOR = "wierd-mem dream <dream@wierd-mem.local>";
export const SYSTEM_AUTHOR = "wierd-mem <system@wierd-mem.local>";

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
	readonly dolt: DoltServer;
	readonly db: Db;
	readonly mem: MemoryStore;
	readonly state: StateStore;
	readonly reviews: Reviews;
	readonly dreams: Dreams;
	readonly searcher: Searcher;
	/** `Name <email>` of the person: the author of hand edits and review decisions. */
	identity = "user <user@localhost>";
	rev = 1;
	doltVersion = "";
	readonly startedAt = Date.now();
	lastPush: { at?: string; error?: string } = {};
	private waiters = new Set<(rev: number) => void>();
	private listeners = new Set<(event: { rev: number; kind: string }) => void>();
	private chain: Promise<unknown> = Promise.resolve();
	private pushTimer: ReturnType<typeof setTimeout> | undefined;
	readonly log: (m: string) => void;

	private constructor(opts: AppOptions) {
		this.paths = homePaths(opts.home);
		this.log = opts.log ?? ((m) => console.log(`[${new Date().toISOString()}] ${m}`));
		for (const dir of [this.paths.home, this.paths.logs, this.paths.dreamLogs, this.paths.digests, this.paths.cards, this.paths.runs, this.paths.skills]) mkdirSync(dir, { recursive: true });
		this.cfg = loadConfig(this.paths.config);
		if (!existsSync(this.paths.config)) saveConfig(this.cfg, this.paths.config);
		this.dolt = new DoltServer(this.paths.dolt, this.cfg.doltPort, join(this.paths.logs, "dolt.log"), this.log);
		this.db = new Db(this.cfg.doltPort);
		this.mem = new MemoryStore(this.db);
		this.state = new StateStore(this.db);
		this.reviews = new Reviews(this);
		this.dreams = new Dreams(this, !opts.noSchedule);
		this.searcher = new Searcher(this);
	}

	static async start(opts: AppOptions = {}): Promise<App> {
		const app = new App(opts);
		await app.dolt.start();
		const name = (await run("git", ["config", "--global", "user.name"])) ?? (await run("dolt", ["config", "--global", "--get", "user.name"])) ?? process.env.USER ?? "user";
		const email = (await run("git", ["config", "--global", "user.email"])) ?? (await run("dolt", ["config", "--global", "--get", "user.email"])) ?? `${name}@localhost`;
		app.identity = `${name} <${email}>`;
		await ensureSchema(app.db, SYSTEM_AUTHOR);
		await app.mem.ensureScope(MAIN, { id: GLOBAL_SCOPE });
		await app.db.commit(MAIN, "wierd-mem: global scope", SYSTEM_AUTHOR);
		app.doltVersion = ((await run(process.env.WMEM_DOLT_BIN || "dolt", ["version"])) ?? "").split("\n")[0].replace(/^dolt version /, "");
		await app.materializeSkills();
		await app.dreams.recover();
		app.dreams.schedule();
		return app;
	}

	async stop(opts: { keepDolt?: boolean } = {}): Promise<void> {
		this.dreams.stop();
		if (this.pushTimer) clearTimeout(this.pushTimer);
		try {
			await this.db.close();
		} catch {
			// already closed
		}
		if (!opts.keepDolt) await this.dolt.stop();
	}

	// ── plumbing ─────────────────────────────────────────────────────────

	/** Run `fn` after every mutation queued before it. */
	lock<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.chain.then(fn, fn);
		this.chain = next.catch(() => undefined);
		return next;
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
		return (await this.db.head(MAIN)).slice(0, 8);
	}

	updateConfig(raw: unknown): WmemConfig {
		const next = sanitize({ ...this.cfg, ...(raw as object) });
		// The ports take effect on restart; everything else right away.
		saveConfig(next, this.paths.config);
		this.cfg = { ...next, port: this.cfg.port, doltPort: this.cfg.doltPort };
		this.dreams.configChanged();
		this.bump("config");
		return next;
	}

	/**
	 * After a commit on `main`: bring the open review in step, write skills
	 * out, tell clients, push to the remote when asked to.
	 */
	async afterMainChange(opts: { skills?: boolean } = {}): Promise<void> {
		const open = await this.state.openReview();
		if (open) await this.reviews.sync(open);
		if (opts.skills) await this.materializeSkills();
		this.bump("memory");
		if (this.cfg.remote.url && this.cfg.remote.autoPush) {
			if (this.pushTimer) clearTimeout(this.pushTimer);
			this.pushTimer = setTimeout(() => void this.push().catch(() => undefined), 5000);
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
			for (const n of [...list].sort(byIndexOrder)) out.push({ ...n, reach: reach.get(n.id) ?? "none", scopeName: name });
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
		const skills = [join(this.paths.skills, GLOBAL_SCOPE), ...(scope ? [join(this.paths.skills, scope)] : [])].filter((d) => existsSync(d));
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
			dolt: { port: this.cfg.doltPort, database: MEMORY_DB, version: this.doltVersion },
			remote: { url: this.cfg.remote.url, autoPush: this.cfg.remote.autoPush, lastPush: this.lastPush.at, error: this.lastPush.error },
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
			await this.db.commit(MAIN, this.message(`add ${note.id}: ${note.title}`, actor), this.identity);
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
			await this.db.commit(MAIN, this.message(`${did.join(", ")} ${n.id}: ${n.title}`, actor), this.identity);
			await this.afterMainChange();
			return this.view(id);
		});
	}

	deleteNote(id: string, actor = ""): Promise<void> {
		return this.lock(async () => {
			const n = await this.mem.note(id, MAIN);
			if (!n) throw notFound(`note ${id}`);
			await this.mem.remove(MAIN, [id]);
			await this.db.commit(MAIN, this.message(`delete ${n.id}: ${n.title}`, actor), this.identity);
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
			const hash = await this.db.commit(MAIN, this.message(`restore ${id} as of ${commit.slice(0, 8)}: ${old.title}`, actor), this.identity);
			if (hash) await this.afterMainChange();
			return this.view(id);
		});
	}

	setCharter(scope: string, charter: string | null, actor = ""): Promise<void> {
		return this.lock(async () => {
			await this.ensureScopeFor(scope);
			if (scope === GLOBAL_SCOPE) await this.mem.ensureScope(MAIN, { id: GLOBAL_SCOPE });
			await this.mem.setCharter(MAIN, scope, charter);
			const hash = await this.db.commit(MAIN, this.message(`charter of ${scope}`, actor), this.identity);
			if (hash) await this.afterMainChange();
		});
	}

	setPrompt(name: string, body: string | null, actor = ""): Promise<void> {
		return this.lock(async () => {
			if (!["cards", "curator", "review", "verify", "project_charter"].includes(name)) throw bad(`unknown prompt "${name}"`);
			await this.mem.setPrompt(MAIN, name, body);
			const hash = await this.db.commit(MAIN, this.message(`prompt ${name}`, actor), this.identity);
			if (hash) await this.afterMainChange();
		});
	}

	deleteSkill(scope: string, name: string, actor = ""): Promise<void> {
		return this.lock(async () => {
			await this.mem.removeSkill(MAIN, scope, name);
			const hash = await this.db.commit(MAIN, this.message(`delete skill ${scope}/${name}`, actor), this.identity);
			if (hash) await this.afterMainChange({ skills: true });
		});
	}

	// ── skills on disk, remote ───────────────────────────────────────────

	/** Write approved skills where pi loads them from (`~/.wierd-mem/skills/<scope>/<name>/SKILL.md`). */
	async materializeSkills(): Promise<void> {
		const skills = await this.mem.skills(MAIN);
		const root = this.paths.skills;
		const keep = new Set<string>();
		for (const s of skills) {
			const dir = join(root, s.scope, s.name);
			keep.add(dir);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body.trim()}\n`, "utf-8");
		}
		const prune = (dir: string, depth: number) => {
			if (!existsSync(dir)) return;
			for (const d of readdirSync(dir, { withFileTypes: true })) {
				if (!d.isDirectory()) continue;
				const full = join(dir, d.name);
				if (existsSync(join(full, "SKILL.md"))) {
					if (!keep.has(full)) rmSync(full, { recursive: true, force: true });
				} else if (depth < 3) {
					prune(full, depth + 1);
					if (!readdirSync(full).length) rmSync(full, { recursive: true, force: true });
				}
			}
		};
		prune(root, 0);
	}

	/** Push `main` to the configured Dolt remote. */
	async push(): Promise<string> {
		const url = this.cfg.remote.url;
		if (!url) throw bad('no remote: set "remote.url" in the settings');
		try {
			await this.db.onBranch(MAIN, async (c) => {
				const [rows] = await c.query("SELECT url FROM dolt_remotes WHERE name = 'origin'");
				const cur = (rows as Array<{ url: string }>)[0]?.url;
				if (cur && cur !== url) await c.query("CALL DOLT_REMOTE('remove', 'origin')");
				if (cur !== url) await c.query("CALL DOLT_REMOTE('add', 'origin', ?)", [url]);
				await c.query("CALL DOLT_PUSH('origin', 'main')");
			});
			this.lastPush = { at: new Date().toISOString() };
			return `pushed main to ${url}`;
		} catch (err) {
			this.lastPush = { ...this.lastPush, error: err instanceof Error ? err.message : String(err) };
			throw new HttpError(502, `push failed: ${this.lastPush.error}`);
		}
	}
}
