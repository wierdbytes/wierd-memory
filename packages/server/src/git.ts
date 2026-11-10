/**
 * Git: the repository memory is kept in.
 *
 * One branch is approved memory (`memory.branch`); it is checked out in the
 * repository's own folder, so notes are plain files anyone can read, grep and
 * edit. A review is a branch `review/<id>` off it, checked out as a linked
 * worktree under `.local/worktrees/` — the server writes a dream's proposals
 * there. Every change is a commit with an author.
 *
 * Nothing here knows what a note is: files, branches, commits, the remote.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The approved branch, whatever it is called (`memory.branch`). */
export const MAIN = "@approved";
export const REVIEW_PREFIX = "review/";

export interface ExecResult {
	code: number;
	stdout: Buffer;
	stderr: string;
}

const ENV = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=20",
	GIT_OPTIONAL_LOCKS: "0",
	GH_PROMPT_DISABLED: "1",
};

/** Run git in `cwd`. Never throws: a failure is a non-zero `code`. A background server must never wait on a prompt. */
export function git(cwd: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn("git", ["-c", "core.quotepath=false", ...args], { cwd, env: { ...process.env, ...ENV }, stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		let err = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, opts.timeoutMs ?? 60_000);
		child.stdout.on("data", (d: Buffer) => out.push(d));
		child.stderr.on("data", (d: Buffer) => {
			err += d.toString();
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ code: 127, stdout: Buffer.alloc(0), stderr: (e as NodeJS.ErrnoException).code === "ENOENT" ? "git is not installed" : String(e) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: timedOut ? 124 : (code ?? 1), stdout: Buffer.concat(out), stderr: timedOut ? `${err}timed out` : err });
		});
		child.stdin.on("error", () => undefined);
		child.stdin.end(opts.input ?? "");
	});
}

export class GitError extends Error {}

/** `Name <email>` → its parts. */
export function parseIdentity(identity: string): { name: string; email: string } {
	const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(identity);
	return m ? { name: m[1] || "user", email: m[2] || "user@localhost" } : { name: identity || "user", email: "user@localhost" };
}

export interface TreeEntry {
	path: string;
	sha: string;
}

export interface LogEntry {
	hash: string;
	author: string;
	email: string;
	date: string;
	message: string;
	/** `--name-status` lines of the commit, when asked for: [status, path, newPath?]. */
	files: Array<[string, string, string?]>;
}

export class Repo {
	constructor(
		readonly dir: string,
		readonly branch: string,
		/** `Name <email>` of whoever commits (the committer; the author is given per commit). */
		private committer: () => string,
		private log: (m: string) => void = () => {},
	) {}

	/** The branch a ref names: the approved one, or a review branch. */
	branchOf(ref: string): string {
		if (ref === MAIN) return this.branch;
		if (!/^[A-Za-z0-9._/-]{1,120}$/.test(ref) || ref.includes("..")) throw new GitError(`bad ref "${ref}"`);
		return ref;
	}

	/** Where a ref is checked out: the repository folder itself, or a worktree under `.local/worktrees`. */
	wt(ref: string): string {
		if (ref === MAIN) return this.dir;
		return join(this.dir, ".local", "worktrees", this.branchOf(ref).replace(/^review\//, "").replace(/[^A-Za-z0-9._-]/g, "_"));
	}

	run(ref: string, args: string[], opts?: { timeoutMs?: number; input?: string }): Promise<ExecResult> {
		return git(this.wt(ref), args, opts);
	}

	/** Run git and return trimmed stdout; throws with stderr on failure. */
	async ok(ref: string, args: string[], opts?: { timeoutMs?: number; input?: string }): Promise<string> {
		const r = await this.run(ref, args, opts);
		if (r.code !== 0) throw new GitError(`git ${args.slice(0, 3).join(" ")}: ${r.stderr.trim() || r.stdout.toString().trim() || `exit ${r.code}`}`);
		return r.stdout.toString().trim();
	}

	// ── the repository ───────────────────────────────────────────────────

	/**
	 * Make sure the repository exists and its folder has the approved branch
	 * checked out: a new one is initialized; in an existing one the branch is
	 * taken from the remote, or started where the repository stands.
	 */
	async ensure(remote: string): Promise<void> {
		mkdirSync(this.dir, { recursive: true });
		if (!existsSync(join(this.dir, ".git"))) {
			await this.ok(MAIN, ["init", "-q", "-b", this.branch]);
			writeFileSync(join(this.dir, ".gitignore"), ".local/\n.DS_Store\n");
			await this.commit(MAIN, "wierd-mem: initialize memory repository", this.committer());
			this.log(`git: initialized ${this.dir} (branch ${this.branch})`);
		}
		const current = (await this.run(MAIN, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.toString().trim();
		if (current !== this.branch) {
			const dirty = (await this.ok(MAIN, ["status", "--porcelain"])).length > 0;
			if (dirty) throw new GitError(`${this.dir} is on ${current || "a detached HEAD"} with uncommitted changes: commit or stash them, then check out ${this.branch}`);
			const local = (await this.run(MAIN, ["rev-parse", "-q", "--verify", `refs/heads/${this.branch}`])).code === 0;
			const tracked = remote && (await this.run(MAIN, ["rev-parse", "-q", "--verify", `refs/remotes/${remote}/${this.branch}`])).code === 0;
			if (local) await this.ok(MAIN, ["checkout", "-q", this.branch]);
			else if (tracked) await this.ok(MAIN, ["checkout", "-q", "-b", this.branch, "--track", `${remote}/${this.branch}`]);
			else await this.ok(MAIN, ["checkout", "-q", "-b", this.branch]);
			this.log(`git: ${this.dir} switched from ${current || "detached HEAD"} to ${this.branch}`);
		}
		const ignore = existsSync(join(this.dir, ".gitignore")) ? readFileSync(join(this.dir, ".gitignore"), "utf-8") : "";
		if (!/^\.local\/?$/m.test(ignore)) {
			writeFileSync(join(this.dir, ".gitignore"), `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}.local/\n`);
			await this.commit(MAIN, "wierd-mem: keep .local out of git", this.committer());
		}
		mkdirSync(join(this.dir, ".local"), { recursive: true });
		await this.run(MAIN, ["worktree", "prune"]);
	}

	async head(ref: string = MAIN): Promise<string> {
		return this.ok(MAIN, ["rev-parse", "--verify", "-q", `refs/heads/${this.branchOf(ref)}`]);
	}

	/** Paths that differ from the last commit (changed, added, deleted, untracked). */
	async dirty(ref: string = MAIN): Promise<string[]> {
		const out = await this.ok(ref, ["status", "--porcelain", "-z", "--untracked-files=all"]);
		return out
			.split("\0")
			.filter(Boolean)
			.map((l) => l.slice(3));
	}

	/**
	 * Commit everything changed in the ref's worktree. Returns the commit hash,
	 * or null when there was nothing to commit. A merge in progress is concluded.
	 */
	async commit(ref: string, message: string, author: string): Promise<string | null> {
		await this.ok(ref, ["add", "-A"]);
		const staged = (await this.run(ref, ["diff", "--cached", "--quiet"])).code !== 0;
		const merging = (await this.run(ref, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
		if (!staged && !merging) return null;
		const who = parseIdentity(this.committer());
		await this.ok(ref, ["-c", `user.name=${who.name}`, "-c", `user.email=${who.email}`, "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "--author", author, "-m", message]);
		return this.ok(ref, ["rev-parse", "HEAD"]);
	}

	// ── review branches ──────────────────────────────────────────────────

	async branches(): Promise<string[]> {
		const out = await this.ok(MAIN, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${REVIEW_PREFIX}`]);
		return out.split("\n").filter(Boolean);
	}

	/** A new branch off `from`, checked out in its own worktree. */
	async createBranch(name: string, from: string = MAIN): Promise<void> {
		const dir = this.wt(name);
		await this.dropWorktree(name);
		mkdirSync(join(dir, ".."), { recursive: true });
		await this.ok(MAIN, ["worktree", "add", "-q", "-B", this.branchOf(name), dir, await this.head(from)]);
	}

	/** Check a branch out again when its worktree is gone (a wiped `.local`, another machine). */
	async ensureWorktree(name: string, remote: string): Promise<void> {
		const dir = this.wt(name);
		const branch = this.branchOf(name);
		if (existsSync(join(dir, ".git"))) {
			// Whatever a crash left half-done: the server is the only one who writes here.
			await this.run(name, ["merge", "--abort"]);
			await this.run(name, ["reset", "-q", "--hard", "HEAD"]);
			await this.run(name, ["clean", "-fdq"]);
			return;
		}
		await this.dropWorktree(name);
		mkdirSync(join(dir, ".."), { recursive: true });
		const local = (await this.run(MAIN, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`])).code === 0;
		if (local) await this.ok(MAIN, ["worktree", "add", "-q", dir, branch]);
		else if (remote && (await this.run(MAIN, ["rev-parse", "-q", "--verify", `refs/remotes/${remote}/${branch}`])).code === 0) await this.ok(MAIN, ["worktree", "add", "-q", "-b", branch, dir, `${remote}/${branch}`]);
		else throw new GitError(`branch ${branch} is gone`);
	}

	private async dropWorktree(name: string): Promise<void> {
		const dir = this.wt(name);
		await this.run(MAIN, ["worktree", "remove", "--force", dir]);
		rmSync(dir, { recursive: true, force: true });
		await this.run(MAIN, ["worktree", "prune"]);
	}

	async deleteBranch(name: string): Promise<void> {
		await this.dropWorktree(name);
		await this.run(MAIN, ["branch", "-D", this.branchOf(name)]);
	}

	/**
	 * Start merging `commit` into the ref while keeping the ref's own files
	 * (`-s ours`): the caller then writes what the merge should really hold and
	 * commits. False when the ref already contains the commit.
	 */
	async beginMerge(ref: string, commit: string): Promise<boolean> {
		if ((await this.run(ref, ["merge-base", "--is-ancestor", commit, "HEAD"])).code === 0) return false;
		const who = parseIdentity(this.committer());
		await this.ok(ref, ["-c", `user.name=${who.name}`, "-c", `user.email=${who.email}`, "merge", "-q", "-s", "ours", "--no-commit", "--no-ff", commit]);
		return true;
	}

	// ── reading history ──────────────────────────────────────────────────

	/** Files of a commit (or branch) under `prefixes`. */
	async tree(treeish: string, prefixes: string[]): Promise<TreeEntry[]> {
		const r = await this.run(MAIN, ["ls-tree", "-r", "-z", treeish, "--", ...prefixes]);
		if (r.code !== 0) return [];
		const out: TreeEntry[] = [];
		for (const line of r.stdout.toString().split("\0")) {
			const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/.exec(line);
			if (m) out.push({ sha: m[1], path: m[2] });
		}
		return out;
	}

	/** Contents of objects (`<sha>`, or `<commit>:<path>`), in the order asked; null for one that does not exist. */
	async blobs(specs: string[]): Promise<Array<string | null>> {
		if (!specs.length) return [];
		const r = await this.run(MAIN, ["cat-file", "--batch"], { input: `${specs.join("\n")}\n` });
		const buf = r.stdout;
		const out: Array<string | null> = [];
		let at = 0;
		for (let i = 0; i < specs.length; i++) {
			const nl = buf.indexOf(10, at);
			if (nl < 0) {
				out.push(null);
				continue;
			}
			const head = buf.subarray(at, nl).toString();
			at = nl + 1;
			const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(head);
			if (!m) {
				out.push(null); // "<spec> missing"
				continue;
			}
			const size = Number(m[2]);
			out.push(m[1] === "blob" ? buf.subarray(at, at + size).toString("utf-8") : null);
			at += size + 1;
		}
		return out;
	}

	/** Commits, newest first. `path`: only those that touched it; `files`: with what each changed (of that path, when one is given). */
	async history(opts: { ref?: string; limit?: number; path?: string; files?: boolean } = {}): Promise<LogEntry[]> {
		const args = ["log", `--format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%B%x1f`];
		if (opts.limit) args.push("-n", String(opts.limit));
		if (opts.files) args.push("--name-status", "--no-renames");
		args.push(this.branchOf(opts.ref ?? MAIN));
		if (opts.path) args.push("--", opts.path);
		const r = await this.run(MAIN, args);
		if (r.code !== 0) return [];
		const out: LogEntry[] = [];
		for (const rec of r.stdout.toString().split("\x1e")) {
			const f = rec.split("\x1f");
			if (f.length < 6) continue;
			const files: LogEntry["files"] = [];
			for (const line of f[5].split("\n")) {
				const p = line.split("\t");
				if (p.length >= 2 && /^[A-Z]\d*$/.test(p[0])) files.push([p[0], p[1], p[2]]);
			}
			out.push({ hash: f[0].trim(), author: f[1], email: f[2], date: f[3], message: f[4].trim(), files });
		}
		return out;
	}

	/** What a commit changed compared with its first parent: [status, path]. Renames are not guessed: a moved file is a deletion and an addition. */
	async changed(hash: string, prefixes: string[]): Promise<Array<[string, string, string?]>> {
		if (!/^[0-9a-f]{7,64}$/.test(hash)) throw new GitError(`bad commit "${hash}"`);
		const parent = (await this.run(MAIN, ["rev-parse", "-q", "--verify", `${hash}^1`])).code === 0;
		const args = parent ? ["diff", "--name-status", "--no-renames", `${hash}^1`, hash, "--", ...prefixes] : ["diff-tree", "--root", "-r", "--name-status", "--no-commit-id", hash, "--", ...prefixes];
		const out = await this.ok(MAIN, args);
		return out
			.split("\n")
			.map((l) => l.split("\t"))
			.filter((p) => p.length >= 2)
			.map((p) => [p[0], p[1], p[2]] as [string, string, string?]);
	}

	// ── the remote ───────────────────────────────────────────────────────

	async remoteUrl(remote: string): Promise<string | null> {
		if (!remote) return null;
		const r = await this.run(MAIN, ["remote", "get-url", remote]);
		return r.code === 0 ? r.stdout.toString().trim() || null : null;
	}

	/** Fetch the approved branch; returns how far the local one is ahead of and behind it. */
	async fetch(remote: string): Promise<{ ahead: number; behind: number; exists: boolean }> {
		const spec = `+refs/heads/${this.branch}:refs/remotes/${remote}/${this.branch}`;
		const r = await this.run(MAIN, ["fetch", "-q", remote, spec], { timeoutMs: 60_000 });
		if (r.code !== 0) {
			if (/couldn't find remote ref/i.test(r.stderr)) return { ahead: 1, behind: 0, exists: false };
			throw new GitError(`fetch: ${r.stderr.trim().split("\n").pop() || `exit ${r.code}`}`);
		}
		const counts = (await this.ok(MAIN, ["rev-list", "--left-right", "--count", `${this.branch}...${remote}/${this.branch}`])).split(/\s+/).map(Number);
		return { ahead: counts[0] || 0, behind: counts[1] || 0, exists: true };
	}

	/** Bring the remote's commits into the approved branch (its worktree must be clean). False when they conflict: nothing is changed then. */
	async mergeRemote(remote: string): Promise<boolean> {
		const target = `${remote}/${this.branch}`;
		if ((await this.run(MAIN, ["merge", "-q", "--ff-only", target])).code === 0) return true;
		const who = parseIdentity(this.committer());
		const r = await this.run(MAIN, ["-c", `user.name=${who.name}`, "-c", `user.email=${who.email}`, "-c", "commit.gpgsign=false", "merge", "-q", "--no-edit", "-m", `merge ${target}`, target]);
		if (r.code === 0) return true;
		await this.run(MAIN, ["merge", "--abort"]);
		return false;
	}

	async push(remote: string, branches: string[], force = false): Promise<void> {
		if (!branches.length) return;
		const r = await this.run(MAIN, ["push", "-q", ...(force ? ["--force"] : []), remote, ...branches.map((b) => `refs/heads/${b}:refs/heads/${b}`)], { timeoutMs: 90_000 });
		if (r.code !== 0) throw new GitError(`push: ${r.stderr.trim().split("\n").pop() || `exit ${r.code}`}`);
	}

	/** Review branches the remote has. */
	async remoteReviews(remote: string): Promise<string[]> {
		const r = await this.run(MAIN, ["ls-remote", "--heads", remote, `refs/heads/${REVIEW_PREFIX}*`], { timeoutMs: 60_000 });
		if (r.code !== 0) throw new GitError(`ls-remote: ${r.stderr.trim().split("\n").pop() || `exit ${r.code}`}`);
		return r.stdout
			.toString()
			.split("\n")
			.map((l) => /refs\/heads\/(.+)$/.exec(l)?.[1])
			.filter((b): b is string => !!b);
	}

	async pushDelete(remote: string, branches: string[]): Promise<void> {
		if (!branches.length) return;
		await this.run(MAIN, ["push", "-q", remote, ...branches.map((b) => `:refs/heads/${b}`)], { timeoutMs: 90_000 });
	}
}
