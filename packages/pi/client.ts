/**
 * The wierd-memory server, as this extension talks to it.
 *
 * pi sessions must never hang on memory: every call has a short timeout and a
 * failure is a value (`undefined`, or a thrown `ServerDown` the caller turns
 * into a line of text for the model or the user). When nothing answers, the
 * server is started once in the background, unless `WMEM_NO_AUTOSTART=1` —
 * see `launch()`: the extension may run from the repository or from an npm
 * install, so it never assumes where the server's code is.
 */

import { execFile, spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homePaths, loadConfig, serverUrl } from "@wierd-memory/core";

const SETUP = "start the wierd-memory server: wmem service install (or wmem serve) — https://github.com/wierdbytes/wierd-memory#setup";

/** Why the last attempt to start the server did not work (shown with `ServerDown`). */
let startFailure: string | undefined;

export class ServerDown extends Error {
	constructor(readonly url: string) {
		super(`the wierd-memory server is not running at ${url}${startFailure ? ` (${startFailure})` : ""}; ${SETUP}`);
	}
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** The launchd agent `wmem service install` writes (macOS). */
const LABEL = "dev.wierd-memory.server";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

let starting: Promise<boolean> | undefined;

export class Client {
	readonly base: string;

	constructor(base?: string) {
		this.base = (base ?? serverUrl(loadConfig())).replace(/\/+$/, "");
	}

	async request<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, {
				method,
				headers: { "x-wmem-client": "pi", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") throw new ApiError(504, `wierd-memory did not answer ${path} in ${Math.round(timeoutMs / 1000)}s`);
			throw new ServerDown(this.base);
		}
		const type = res.headers.get("content-type") ?? "";
		const data: unknown = type.includes("json") ? await res.json() : await res.text();
		if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? (typeof data === "string" ? data : res.statusText));
		return data as T;
	}

	get<T>(path: string, timeoutMs?: number): Promise<T> {
		return this.request<T>("GET", path, undefined, timeoutMs);
	}

	post<T>(path: string, body: unknown = {}, timeoutMs?: number): Promise<T> {
		return this.request<T>("POST", path, body, timeoutMs);
	}

	async up(timeoutMs = 1200): Promise<boolean> {
		try {
			await this.get("/api/wait?rev=-1&timeout=1", timeoutMs);
			return true;
		} catch {
			return false;
		}
	}

	/** Make sure a server answers: start one in the background when none does. Resolves to whether it is up. */
	ensure(waitMs = 8000): Promise<boolean> {
		starting ??= this.start(waitMs).finally(() => {
			setTimeout(() => {
				starting = undefined;
			}, 30_000).unref?.();
		});
		return starting;
	}

	private async start(waitMs: number): Promise<boolean> {
		if (await this.up()) return true;
		if (process.env.WMEM_NO_AUTOSTART === "1" || process.env.WMEM_URL) return false;
		const how = await launch();
		if (typeof how !== "string") {
			startFailure = how.failed;
			return false;
		}
		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 300));
			if (await this.up(600)) {
				startFailure = undefined;
				return true;
			}
		}
		startFailure = `started it (${how}) but it did not answer in ${Math.round(waitMs / 1000)}s`;
		return false;
	}
}

/**
 * Start the server in the background, the way it is installed here:
 * 1. the launchd agent of `wmem service install` → `launchctl kickstart` (only for the default home:
 *    a run with `WMEM_HOME` set means another server, e.g. a sandbox);
 * 2. `wmem` on PATH → `wmem serve`, detached, logging to `<home>/logs/server.log`;
 * 3. a repository checkout this file runs from (`pi install <repo>/packages/pi`) → its `bin/wmem serve`.
 * Resolves to how it was started, or why it could not be.
 */
async function launch(): Promise<string | { failed: string }> {
	if (process.platform === "darwin" && !process.env.WMEM_HOME && existsSync(PLIST)) {
		const target = `gui/${process.getuid?.() ?? 501}`;
		if ((await run("launchctl", ["kickstart", `${target}/${LABEL}`])) === 0) return "launchctl kickstart";
		// installed but not loaded (booted out): load it, which starts it (RunAtLoad)
		if ((await run("launchctl", ["bootstrap", target, PLIST])) === 0) return "launchctl bootstrap";
	}
	const bin = onPath("wmem") ?? checkoutBin();
	if (!bin) return { failed: "found neither its launchd agent nor wmem on PATH" };
	const logs = homePaths().logs;
	let fd: number | undefined;
	try {
		mkdirSync(logs, { recursive: true });
		fd = openSync(join(logs, "server.log"), "a");
		const child = spawn(bin, ["serve"], { detached: true, stdio: ["ignore", fd, fd], cwd: homedir() });
		child.on("error", () => undefined); // e.g. not executable after all: the wait for it to answer says so
		child.unref();
		return `${bin} serve`;
	} catch (err) {
		return { failed: `${bin} serve: ${err instanceof Error ? err.message : String(err)}` };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Exit code of a short command (or -1), never waiting more than a few seconds. */
function run(cmd: string, args: string[]): Promise<number> {
	return new Promise((done) => {
		try {
			execFile(cmd, args, { timeout: 5000 }, (err) => done(err ? (typeof err.code === "number" ? err.code : -1) : 0));
		} catch {
			done(-1);
		}
	});
}

function onPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const file = join(dir, name);
		try {
			accessSync(file, constants.X_OK);
			return file;
		} catch {
			// next
		}
	}
	return undefined;
}

/** `bin/wmem` of the repository when this file runs from a checkout (`packages/pi/client.ts`); not in the npm bundle. */
function checkoutBin(): string | undefined {
	const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const bin = join(repo, "bin", "wmem");
	return existsSync(bin) && existsSync(join(repo, "packages", "server", "src", "cli.ts")) ? bin : undefined;
}
