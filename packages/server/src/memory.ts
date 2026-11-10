/**
 * Memory as files in the git repository: notes, scopes, skills and prompts at
 * a branch, and their history.
 *
 * ```
 * scopes/global/                 charter.md, notes/<slug>.md, skills/<name>/SKILL.md
 * scopes/projects/<key>/         the same, plus scope.json ({ key, root })
 * scopes/projects/_charter.md    the default purpose of project memory
 * prompts/<stage>.md             overrides of the dream prompts
 * ```
 *
 * Reads and writes name the branch: `MAIN` is approved memory (the
 * repository's own folder), the dreams branch is its worktree. A write changes
 * files only — `Repo.commit` makes it a commit. Nothing here decides what may
 * be written where: `reviews.ts` and `app.ts` do.
 *
 * A note keeps its file for life: the name comes from its first title, and a
 * note that exists on both branches has the same path on both wherever its
 * scope allows, so git sees one file changing rather than two unrelated ones.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	cloneNote,
	type CommitInfo,
	DEFAULT_GLOBAL_CHARTER,
	DEFAULT_PROJECT_CHARTER,
	defaultPrompt,
	GLOBAL_SCOPE,
	newNoteId,
	type Note,
	NOTE_COLUMNS,
	type NoteHistoryEntry,
	PROMPT_NAMES,
	sameNote,
	type ScopeMeta,
	type SkillDraft,
	slugify,
	today,
} from "@wierd-memory/core";
import { MAIN, type Repo } from "./git.ts";
import { parseNote, parseSkill, renderNote, renderSkill, scopeOfPath, skillOfPath } from "./notefile.ts";

export interface ScopeRow extends ScopeMeta {
	charter: string | null;
}

export type SkillRow = SkillDraft;

interface Tree {
	notes: Note[];
	/** Note id → its file, relative to the repository. */
	paths: Map<string, string>;
	/** Every note file, whoever's it is. */
	files: Set<string>;
	scopes: ScopeRow[];
	skills: SkillRow[];
	prompts: Record<string, string>;
}

const PROJECT_CHARTER_FILE = "scopes/projects/_charter.md";
/** Everything that is not a note or a skill: it always follows the approved branch. */
const NOT_PROPOSED = [".", ":(exclude,glob)scopes/**/notes/**", ":(exclude,glob)scopes/**/skills/**"];

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

function dirs(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.sort();
	} catch {
		return [];
	}
}

function files(path: string, ext: string): string[] {
	try {
		return readdirSync(path)
			.filter((n) => n.endsWith(ext))
			.sort();
	} catch {
		return [];
	}
}

export class MemoryStore {
	private trees = new Map<string, Tree>();

	constructor(readonly repo: Repo) {}

	/** Files changed behind the store's back (a hand edit, a checkout): read them again. */
	invalidate(ref?: string): void {
		if (ref) this.trees.delete(ref);
		else this.trees.clear();
	}

	// ── reading a tree ───────────────────────────────────────────────────

	/** The memory files of a worktree: path → content. */
	private readWorktree(root: string): Map<string, string> {
		const out = new Map<string, string>();
		const add = (rel: string) => {
			const text = readText(join(root, rel));
			if (text !== undefined) out.set(rel, text);
		};
		const scopeDirs = [`scopes/${GLOBAL_SCOPE}`, ...dirs(join(root, "scopes", "projects")).map((d) => `scopes/projects/${d}`)];
		for (const dir of scopeDirs) {
			add(`${dir}/scope.json`);
			add(`${dir}/charter.md`);
			for (const name of files(join(root, dir, "notes"), ".md")) add(`${dir}/notes/${name}`);
			for (const skill of dirs(join(root, dir, "skills"))) add(`${dir}/skills/${skill}/SKILL.md`);
			// A project folder with nothing in it yet still is a scope.
			if (!out.has(`${dir}/scope.json`) && dir !== `scopes/${GLOBAL_SCOPE}`) out.set(`${dir}/`, "");
		}
		add(PROJECT_CHARTER_FILE);
		for (const name of files(join(root, "prompts"), ".md")) add(`prompts/${name}`);
		return out;
	}

	private build(source: Map<string, string>, fix?: (path: string, note: Note) => void): Tree {
		const tree: Tree = { notes: [], paths: new Map(), files: new Set(), scopes: [], skills: [], prompts: {} };
		const scopes = new Map<string, ScopeRow>([[GLOBAL_SCOPE, { id: GLOBAL_SCOPE, charter: null }]]);
		const scope = (id: string) => {
			let row = scopes.get(id);
			if (!row) scopes.set(id, (row = { id, charter: null }));
			return row;
		};
		const date = today();
		const pending: Array<{ path: string; note: Note }> = [];
		for (const [path, text] of [...source].sort((a, b) => a[0].localeCompare(b[0]))) {
			const noteScope = scopeOfPath(path);
			if (noteScope) {
				scope(noteScope);
				tree.files.add(path);
				const parsed = parseNote(text, noteScope, date);
				const n = parsed.note;
				if (!n.id || tree.paths.has(n.id)) {
					// Written by hand without an id (or copied with someone else's): it gets its own below.
					n.id = "";
					pending.push({ path, note: n });
					continue;
				}
				tree.notes.push(n);
				tree.paths.set(n.id, path);
				if (parsed.incomplete) fix?.(path, n);
				continue;
			}
			const skill = skillOfPath(path);
			if (skill) {
				scope(skill.scope);
				tree.skills.push(parseSkill(text, skill.scope, skill.name));
				continue;
			}
			const m = /^scopes\/(global|projects\/[^/_][^/]*)\/(scope\.json|charter\.md|)$/.exec(path);
			if (m) {
				const row = scope(m[1]);
				if (m[2] === "scope.json") {
					try {
						const meta = JSON.parse(text) as { key?: unknown; root?: unknown };
						if (typeof meta.key === "string" && meta.key) row.key = meta.key;
						if (typeof meta.root === "string" && meta.root) row.root = meta.root;
					} catch {
						// a broken scope.json: the folder's name stands in for the key
					}
				} else if (m[2] === "charter.md") {
					const charter = text.trim();
					row.charter = charter && charter !== (m[1] === GLOBAL_SCOPE ? DEFAULT_GLOBAL_CHARTER : DEFAULT_PROJECT_CHARTER) ? charter : null;
				}
				continue;
			}
			if (path === PROJECT_CHARTER_FILE) {
				if (text.trim() && text.trim() !== DEFAULT_PROJECT_CHARTER) tree.prompts.project_charter = text.trim();
				continue;
			}
			const prompt = /^prompts\/([a-z]+)\.md$/.exec(path)?.[1];
			if (prompt && (PROMPT_NAMES as readonly string[]).includes(prompt) && text.trim() && text.trim() !== defaultPrompt(prompt as (typeof PROMPT_NAMES)[number])) tree.prompts[prompt] = text.trim();
		}
		const ids = new Set(tree.paths.keys());
		for (const { path, note } of pending) {
			note.id = newNoteId(ids);
			tree.notes.push(note);
			tree.paths.set(note.id, path);
			fix?.(path, note);
		}
		tree.notes.sort((a, b) => a.id.localeCompare(b.id));
		tree.scopes = [...scopes.values()].sort((a, b) => a.id.localeCompare(b.id));
		tree.skills.sort((a, b) => `${a.scope}/${a.name}`.localeCompare(`${b.scope}/${b.name}`));
		return tree;
	}

	private tree(ref: string): Tree {
		let t = this.trees.get(ref);
		if (!t) {
			const root = this.repo.wt(ref);
			// A hand-written note gets what it lacks (an id, dates) written into its file.
			t = this.build(this.readWorktree(root), (path, note) => writeFileSync(join(root, path), renderNote(note), "utf-8"));
			this.trees.set(ref, t);
		}
		return t;
	}

	/** The memory files of a commit, as a tree. */
	private async treeAt(commit: string): Promise<Tree> {
		const entries = (await this.repo.tree(commit, ["scopes", "prompts"])).filter((e) => scopeOfPath(e.path) || skillOfPath(e.path) || /\/(scope\.json|charter\.md)$|^prompts\/|_charter\.md$/.test(e.path));
		const texts = await this.repo.blobs(entries.map((e) => e.sha));
		const source = new Map<string, string>();
		entries.forEach((e, i) => {
			const text = texts[i];
			if (text !== null) source.set(e.path, text);
		});
		return this.build(source);
	}

	// ── notes ────────────────────────────────────────────────────────────

	async notes(ref: string = MAIN): Promise<Note[]> {
		return this.tree(ref).notes.map(cloneNote);
	}

	/** Notes as they were at a commit. */
	async notesAt(commit: string): Promise<Note[]> {
		return (await this.treeAt(commit)).notes;
	}

	async note(id: string, ref: string = MAIN): Promise<Note | undefined> {
		const n = this.tree(ref).notes.find((x) => x.id === id);
		return n ? cloneNote(n) : undefined;
	}

	async noteIds(ref: string = MAIN): Promise<Set<string>> {
		return new Set(this.tree(ref).paths.keys());
	}

	/** A note's file (absolute path). */
	fileOf(id: string, ref: string = MAIN): string | undefined {
		const rel = this.tree(ref).paths.get(id);
		return rel ? join(this.repo.wt(ref), rel) : undefined;
	}

	/**
	 * Write notes to the branch's files. `like`: another branch whose path for
	 * the same note is preferred (so both sides keep one file per note).
	 */
	async upsert(ref: string, notes: readonly Note[], opts: { like?: string } = {}): Promise<void> {
		if (!notes.length) return;
		const t = this.tree(ref);
		const other = opts.like ? this.tree(opts.like) : undefined;
		const root = this.repo.wt(ref);
		const byId = new Map(t.notes.map((n) => [n.id, n]));
		const taken = new Set(t.files);
		const owner = new Map([...t.paths].map(([id, p]) => [p, id]));
		for (const n of notes) {
			const dir = `scopes/${n.scope}/notes`;
			const cur = t.paths.get(n.id);
			const free = (p: string) => !taken.has(p) || owner.get(p) === n.id;
			const hint = other?.paths.get(n.id);
			let target: string;
			if (hint && dirname(hint) === dir && free(hint)) target = hint;
			else if (cur && dirname(cur) === dir) target = cur;
			else {
				// A new note is named after its title; a note that moves keeps its file name.
				const base = cur ? basename(cur, ".md") : slugify(n.title);
				const elsewhere = (p: string) => !!other && other.files.has(p) && other.paths.get(n.id) !== p;
				target = `${dir}/${base}.md`;
				for (let i = 2; !free(target) || elsewhere(target); i++) target = `${dir}/${base}-${i}.md`;
			}
			const before = byId.get(n.id);
			if (before && cur === target && sameNote(before, n)) continue;
			mkdirSync(join(root, dir), { recursive: true });
			writeFileSync(join(root, target), renderNote(n), "utf-8");
			taken.add(target);
			owner.set(target, n.id);
			if (cur && cur !== target) {
				rmSync(join(root, cur), { force: true });
				taken.delete(cur);
				owner.delete(cur);
			}
		}
		this.invalidate(ref);
	}

	async remove(ref: string, ids: readonly string[]): Promise<void> {
		if (!ids.length) return;
		const t = this.tree(ref);
		const root = this.repo.wt(ref);
		for (const id of ids) {
			const rel = t.paths.get(id);
			if (rel) rmSync(join(root, rel), { force: true });
		}
		this.invalidate(ref);
	}

	/**
	 * Where a note is the same on both branches and at the same path, make its
	 * file on `ref` byte for byte the one `from` has: a file written by hand
	 * (or by an older version) is not shown as a difference only because the
	 * other side rendered it anew. `ids` omitted: every such note.
	 */
	async copyFiles(ref: string, from: string, ids?: readonly string[]): Promise<void> {
		const t = this.tree(ref);
		const f = this.tree(from);
		const mine = new Map(t.notes.map((n) => [n.id, n]));
		const root = this.repo.wt(ref);
		const src = this.repo.wt(from);
		let touched = false;
		for (const n of f.notes) {
			if (ids && !ids.includes(n.id)) continue;
			const path = f.paths.get(n.id);
			if (!path || t.paths.get(n.id) !== path || !sameNote(mine.get(n.id), n)) continue;
			const text = readText(join(src, path));
			if (text === undefined || readText(join(root, path)) === text) continue;
			writeFileSync(join(root, path), text, "utf-8");
			touched = true;
		}
		if (touched) this.invalidate(ref);
	}

	// ── scopes ───────────────────────────────────────────────────────────

	async scopes(ref: string = MAIN): Promise<ScopeRow[]> {
		return this.tree(ref).scopes.map((s) => ({ ...s }));
	}

	/** Create a project's folder with its scope.json, or fill in what it does not say yet (key, root). */
	async ensureScope(ref: string, s: ScopeMeta): Promise<void> {
		const root = this.repo.wt(ref);
		const dir = join(root, "scopes", s.id);
		mkdirSync(join(dir, "notes"), { recursive: true });
		if (s.id === GLOBAL_SCOPE) return;
		const file = join(dir, "scope.json");
		let meta: { key?: string; root?: string } = {};
		try {
			meta = JSON.parse(readFileSync(file, "utf-8")) as typeof meta;
		} catch {
			// not there yet
		}
		const next = { ...meta, key: meta.key ?? s.key, root: s.root ?? meta.root };
		if (existsSync(file) && next.key === meta.key && next.root === meta.root) return;
		writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
		this.invalidate(ref);
	}

	async setCharter(ref: string, id: string, charter: string | null): Promise<void> {
		const file = join(this.repo.wt(ref), "scopes", id, "charter.md");
		if (charter?.trim()) {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${charter.trim()}\n`, "utf-8");
		} else rmSync(file, { force: true });
		this.invalidate(ref);
	}

	// ── skills ───────────────────────────────────────────────────────────

	async skills(ref: string = MAIN): Promise<SkillRow[]> {
		return this.tree(ref).skills.map((s) => ({ ...s }));
	}

	async skillsAt(commit: string): Promise<SkillRow[]> {
		return (await this.treeAt(commit)).skills;
	}

	async upsertSkill(ref: string, s: SkillDraft): Promise<void> {
		const file = join(this.repo.wt(ref), "scopes", s.scope, "skills", s.name, "SKILL.md");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, renderSkill(s), "utf-8");
		this.invalidate(ref);
	}

	async removeSkill(ref: string, scope: string, name: string): Promise<void> {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return;
		rmSync(join(this.repo.wt(ref), "scopes", scope, "skills", name), { recursive: true, force: true });
		this.invalidate(ref);
	}

	/** Folders pi loads approved skills from, for a scope. */
	skillDirs(scopes: readonly string[]): string[] {
		return scopes.map((s) => join(this.repo.wt(MAIN), "scopes", s, "skills")).filter((d) => existsSync(d));
	}

	// ── prompts ──────────────────────────────────────────────────────────

	/** Overrides of the dream prompts, and `project_charter`: the default purpose of project memory. */
	async prompts(ref: string = MAIN): Promise<Record<string, string>> {
		return { ...this.tree(ref).prompts };
	}

	async setPrompt(ref: string, name: string, body: string | null): Promise<void> {
		const file = join(this.repo.wt(ref), name === "project_charter" ? PROJECT_CHARTER_FILE : `prompts/${name}.md`);
		if (body?.trim()) {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${body.trim()}\n`, "utf-8");
		} else rmSync(file, { force: true });
		this.invalidate(ref);
	}

	// ── keeping the dreams branch in step ────────────────────────────────

	/**
	 * In the branch's worktree, make every file that is not a note or a skill
	 * what `commit` (the approved branch) has: charters, scope.json, prompts and
	 * the rest are never proposed, only notes and skills are. A project folder
	 * that exists only on this branch (it holds a proposed first note) stays.
	 */
	async takeShared(ref: string, commit: string): Promise<void> {
		const root = this.repo.wt(ref);
		await this.repo.run(ref, ["checkout", "-q", commit, "--", ...NOT_PROPOSED]);
		const theirs = new Set((await this.repo.ok(MAIN, ["ls-tree", "-r", "-z", "--name-only", commit])).split("\0").filter(Boolean));
		const theirScopes = new Set([...theirs].map((p) => /^(scopes\/projects\/[^/]+)\//.exec(p)?.[1]).filter(Boolean));
		const mine = (await this.repo.ok(ref, ["ls-files", "-z", "--", ...NOT_PROPOSED])).split("\0").filter(Boolean);
		for (const f of mine) {
			if (theirs.has(f)) continue;
			const own = /^(scopes\/projects\/[^/]+)\/scope\.json$/.exec(f)?.[1];
			if (own && !theirScopes.has(own)) continue;
			rmSync(join(root, f), { force: true });
		}
		this.invalidate(ref);
	}

	// ── history ──────────────────────────────────────────────────────────

	async log(limit = 100, ref: string = MAIN): Promise<CommitInfo[]> {
		return (await this.repo.history({ ref, limit })).map((e) => ({ hash: e.hash, author: e.author, email: e.email, date: e.date, message: e.message }));
	}

	private async parseAt(specs: Array<{ spec: string; path: string } | undefined>): Promise<Array<Note | undefined>> {
		const wanted = specs.filter((s): s is { spec: string; path: string } => !!s);
		const texts = await this.repo.blobs(wanted.map((s) => s.spec));
		const bySpec = new Map(wanted.map((s, i) => [s.spec, texts[i]]));
		return specs.map((s) => {
			const text = s ? bySpec.get(s.spec) : null;
			const scope = s ? scopeOfPath(s.path) : undefined;
			if (!s || text === null || text === undefined || !scope) return undefined;
			return parseNote(text, scope, "").note;
		});
	}

	/**
	 * Every commit on the approved branch that changed the note, newest first,
	 * with what it changed. The note is followed by its id: git's own rename
	 * detection mistakes one small note for another.
	 */
	async noteHistory(id: string): Promise<NoteHistoryEntry[]> {
		let path = this.tree(MAIN).paths.get(id);
		if (!path) {
			// Deleted: its file is where the id was last seen.
			const found = await this.repo.run(MAIN, ["log", "-n", "1", "--format=", "--name-only", `-Sid: ${id}`, this.repo.branch, "--", "scopes"]);
			path = found.stdout
				.toString()
				.split("\n")
				.find((l) => scopeOfPath(l.trim()))
				?.trim();
		}
		type Side = { spec: string; path: string } | undefined;
		const steps: Array<{ hash: string; date: string; author: string; message: string; type: string; before: Side; after: Side }> = [];
		const hasId = new RegExp(`^id: ${id}\\s*$`, "m");
		// Walking an older file of the note: only what happened before the commit that moved it away.
		let until: string | undefined;
		for (let hops = 0; path && hops < 30; hops++) {
			const here: string = path;
			let commits = await this.repo.history({ path: here, files: true });
			if (until) {
				const at = commits.findIndex((c) => c.hash === until);
				if (at >= 0) commits = commits.slice(at + 1);
			}
			for (const c of commits) {
				const kind = (c.files.find((f) => f[1] === here)?.[0] ?? "M")[0];
				steps.push({
					hash: c.hash,
					date: c.date,
					author: c.author,
					message: c.message,
					type: kind === "A" ? "added" : kind === "D" ? "removed" : "modified",
					before: kind === "A" ? undefined : { spec: `${c.hash}^1:${here}`, path: here },
					after: kind === "D" ? undefined : { spec: `${c.hash}:${here}`, path: here },
				});
			}
			// The file appeared in its oldest commit: was the note moved there from another file?
			const first = steps[steps.length - 1];
			path = undefined;
			if (!commits.length || !first || first.type !== "added") break;
			const gone = (await this.repo.changed(first.hash, ["scopes"])).filter(([status, p]) => status[0] === "D" && scopeOfPath(p)).map(([, p]) => p);
			const texts = await this.repo.blobs(gone.map((p) => `${first.hash}^1:${p}`));
			const from = gone.find((_p, i) => hasId.test(texts[i] ?? ""));
			if (!from) break;
			first.type = "modified";
			first.before = { spec: `${first.hash}^1:${from}`, path: from };
			path = from;
			until = first.hash;
		}
		const notes = await this.parseAt(steps.flatMap((s) => [s.before, s.after]));
		return steps.map((s, i) => {
			const before = notes[i * 2];
			const after = notes[i * 2 + 1];
			const changes: NoteHistoryEntry["changes"] = {};
			for (const field of NOTE_COLUMNS) {
				const a = (before as unknown as Record<string, unknown> | undefined)?.[field];
				const b = (after as unknown as Record<string, unknown> | undefined)?.[field];
				if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes[field] = [a ?? null, b ?? null];
			}
			return { commit: s.hash, date: s.date, author: s.author, message: s.message, type: s.type, changes };
		});
	}

	/** Notes a commit changed: [before, after] pairs (either side absent for added / removed). A note that moved is one change. */
	async commitChanges(hash: string): Promise<Array<{ type: string; before?: Note; after?: Note }>> {
		const changed = (await this.repo.changed(hash, ["scopes"])).filter(([, p]) => scopeOfPath(p));
		const sides = changed.map(([status, p]) => ({
			kind: status[0],
			before: status[0] === "A" ? undefined : { spec: `${hash}^1:${p}`, path: p },
			after: status[0] === "D" ? undefined : { spec: `${hash}:${p}`, path: p },
		}));
		const notes = await this.parseAt(sides.flatMap((x) => [x.before, x.after]));
		const out: Array<{ type: string; before?: Note; after?: Note }> = [];
		const removed = new Map<string, Note>();
		sides.forEach((x, i) => {
			const before = notes[i * 2];
			if (x.kind === "D" && before?.id) removed.set(before.id, before);
		});
		sides.forEach((x, i) => {
			const before = notes[i * 2];
			const after = notes[i * 2 + 1];
			if (x.kind === "A" && after?.id && removed.has(after.id)) {
				out.push({ type: "modified", before: removed.get(after.id), after });
				removed.delete(after.id);
			} else if (x.kind !== "D" && (before || after)) out.push({ type: x.kind === "A" ? "added" : "modified", before, after });
		});
		for (const before of removed.values()) out.push({ type: "removed", before });
		return out;
	}
}
