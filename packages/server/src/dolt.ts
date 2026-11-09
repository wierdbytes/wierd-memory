/**
 * Dolt: the SQL server process wierd-mem runs, and the connection to it.
 *
 * wierd-mem keeps everything in two Dolt databases served by one
 * `dolt sql-server` on 127.0.0.1 (`~/.wierd-mem/dolt`):
 *
 *   wmem        memory — notes, scopes, skills, prompts. Versioned: `main` is
 *               approved memory, every change to it is a commit; a dream's
 *               proposals live on a review branch until they are accepted.
 *   wmem_state  what goes on around memory — inbox, dream runs, reviews and
 *               their decisions. One branch, no review.
 *
 * Any MySQL client can look inside (`mysql -h127.0.0.1 -P7434 -uroot wmem`),
 * and so can the `dolt` CLI when the server is stopped.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";

export const MEMORY_DB = "wmem";
export const STATE_DB = "wmem_state";
export const MAIN = "main";

export type Row = Record<string, unknown>;
export type Conn = mysql.PoolConnection;

function alive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function canConnect(port: number): Promise<boolean> {
	try {
		const c = await mysql.createConnection({ host: "127.0.0.1", port, user: "root", connectTimeout: 1500 });
		await c.query("SELECT 1");
		await c.end();
		return true;
	} catch {
		return false;
	}
}

/** The `dolt sql-server` child: started when nothing serves the data dir yet, reused when one of ours already does. */
export class DoltServer {
	private child: ChildProcess | undefined;
	private stopping = false;
	private pidFile: string;

	constructor(
		readonly dataDir: string,
		readonly port: number,
		private logFile: string,
		private log: (m: string) => void = () => {},
		private bin = process.env.WMEM_DOLT_BIN || "dolt",
	) {
		this.pidFile = join(dataDir, ".wmem-dolt.json");
	}

	async start(): Promise<void> {
		mkdirSync(this.dataDir, { recursive: true });
		const prev = this.readPid();
		if (prev && prev.port === this.port && alive(prev.pid) && (await canConnect(this.port))) {
			this.log(`dolt: reusing sql-server pid ${prev.pid} on :${this.port}`);
			return;
		}
		if (await canConnect(this.port)) throw new Error(`port ${this.port} is taken by another MySQL-compatible server: set "doltPort" in config.json`);
		await this.spawn();
	}

	private readPid(): { pid: number; port: number } | undefined {
		try {
			return JSON.parse(readFileSync(this.pidFile, "utf-8")) as { pid: number; port: number };
		} catch {
			return undefined;
		}
	}

	private async spawn(): Promise<void> {
		const fd = openSync(this.logFile, "a");
		let child: ChildProcess;
		try {
			child = spawn(this.bin, ["sql-server", "--data-dir", this.dataDir, "-H", "127.0.0.1", "-P", String(this.port), "-l", "warning"], {
				cwd: this.dataDir,
				stdio: ["ignore", fd, fd],
				env: { ...process.env, DOLT_ROOT_HOST: "127.0.0.1" },
			});
		} finally {
			closeSync(fd);
		}
		this.child = child;
		let exited: string | undefined;
		child.on("error", (err) => {
			exited = (err as NodeJS.ErrnoException).code === "ENOENT" ? "dolt is not installed (brew install dolt)" : String(err);
		});
		child.on("exit", (code, signal) => {
			exited = `dolt sql-server exited (${signal ?? code})`;
			this.child = undefined;
			if (this.stopping) return;
			this.log(`${exited}: restarting`);
			setTimeout(() => void this.spawn().catch((e) => this.log(`dolt: restart failed: ${e instanceof Error ? e.message : e}`)), 1000);
		});
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (exited) {
				this.stopping = true;
				throw new Error(`${exited} — see ${this.logFile}`);
			}
			if (await canConnect(this.port)) {
				writeFileSync(this.pidFile, JSON.stringify({ pid: child.pid, port: this.port }));
				this.log(`dolt: sql-server pid ${child.pid} on :${this.port} (${this.dataDir})`);
				return;
			}
			await new Promise((r) => setTimeout(r, 150));
		}
		throw new Error(`dolt sql-server did not come up on :${this.port} — see ${this.logFile}`);
	}

	async stop(): Promise<void> {
		this.stopping = true;
		const pid = this.child?.pid ?? this.readPid()?.pid;
		if (!pid || !alive(pid)) return;
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			return;
		}
		for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
		if (alive(pid)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// gone
			}
		}
		if (existsSync(this.pidFile)) rmSync(this.pidFile, { force: true });
	}
}

/** A branch, tag or commit hash that is safe to put into a database name. */
export function safeRef(ref: string): string {
	if (!/^[A-Za-z0-9._-]{1,100}$/.test(ref)) throw new Error(`bad ref "${ref}"`);
	return ref;
}

/** `` `wmem/<branch>` ``: the memory database at a branch, for fully qualified table names. */
export function memAt(ref: string = MAIN): string {
	return `\`${MEMORY_DB}/${safeRef(ref)}\``;
}

export const isNothingToCommit = (err: unknown) => /nothing to commit/i.test(err instanceof Error ? err.message : String(err));

export class Db {
	readonly pool: mysql.Pool;

	constructor(readonly port: number) {
		this.pool = mysql.createPool({
			host: "127.0.0.1",
			port,
			user: "root",
			connectionLimit: 8,
			charset: "utf8mb4",
			dateStrings: true,
			supportBigNumbers: true,
			enableKeepAlive: true,
		});
	}

	/** Run a statement with fully qualified table names (no current database). */
	async q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
		const [rows] = await this.pool.query(sql, params);
		return rows as T[];
	}

	/**
	 * Run `fn` on a connection whose current database is `database`
	 * (`wmem_state`, or `wmem/<branch>`): what Dolt's own procedures and system
	 * tables (`DOLT_COMMIT`, `dolt_log`, `AS OF`) act on.
	 */
	async on<T>(database: string, fn: (c: Conn) => Promise<T>): Promise<T> {
		const c = await this.pool.getConnection();
		try {
			await c.query(`USE \`${database}\``);
			return await fn(c);
		} finally {
			try {
				await c.query(`USE \`${STATE_DB}\``);
			} catch {
				// the pool hands it out again with a USE of its own
			}
			c.release();
		}
	}

	onBranch<T>(ref: string, fn: (c: Conn) => Promise<T>): Promise<T> {
		return this.on(`${MEMORY_DB}/${safeRef(ref)}`, fn);
	}

	/**
	 * Commit everything changed on `ref`. Returns the commit hash, or null when
	 * there was nothing to commit.
	 */
	async commit(ref: string, message: string, author: string): Promise<string | null> {
		return this.onBranch(ref, async (c) => {
			try {
				const [rows] = await c.query("CALL DOLT_COMMIT('-A', '-m', ?, '--author', ?)", [message, author]);
				return ((rows as Row[])[0]?.hash as string) ?? null;
			} catch (err) {
				if (isNothingToCommit(err)) return null;
				throw err;
			}
		});
	}

	async head(ref: string = MAIN): Promise<string> {
		return this.onBranch(MAIN, async (c) => {
			const [rows] = await c.query("SELECT HASHOF(?) AS h", [safeRef(ref)]);
			return String((rows as Row[])[0]?.h ?? "");
		});
	}

	async branches(): Promise<string[]> {
		return this.onBranch(MAIN, async (c) => {
			const [rows] = await c.query("SELECT name FROM dolt_branches");
			return (rows as Row[]).map((r) => String(r.name));
		});
	}

	async createBranch(name: string, from: string = MAIN): Promise<void> {
		await this.onBranch(MAIN, (c) => c.query("CALL DOLT_BRANCH(?, ?)", [safeRef(name), safeRef(from)]));
	}

	async deleteBranch(name: string): Promise<void> {
		await this.onBranch(MAIN, (c) => c.query("CALL DOLT_BRANCH('-D', ?)", [safeRef(name)]));
	}

	async close(): Promise<void> {
		await this.pool.end();
	}
}
