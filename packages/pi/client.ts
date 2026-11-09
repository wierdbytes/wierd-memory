/**
 * The wierd-mem server, as this extension talks to it.
 *
 * pi sessions must never hang on memory: every call has a short timeout and a
 * failure is a value (`undefined`, or a thrown `ServerDown` the caller turns
 * into a line of text for the model or the user). When nothing answers, the
 * server is started once in the background (`bin/wmem serve`), unless
 * `WMEM_NO_AUTOSTART=1`.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homePaths, loadConfig, serverUrl } from "@wierd-mem/core";

export class ServerDown extends Error {
	constructor(readonly url: string) {
		super(`the wierd-mem server is not running at ${url} (start it: wmem serve)`);
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

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
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
			if (err instanceof Error && err.name === "TimeoutError") throw new ApiError(504, `wierd-mem did not answer ${path} in ${Math.round(timeoutMs / 1000)}s`);
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
		const bin = join(REPO, "bin", "wmem");
		if (!existsSync(bin)) return false;
		const logs = homePaths().logs;
		mkdirSync(logs, { recursive: true });
		const fd = openSync(join(logs, "server.log"), "a");
		try {
			spawn(bin, ["serve"], { detached: true, stdio: ["ignore", fd, fd], cwd: REPO }).unref();
		} catch {
			return false;
		} finally {
			closeSync(fd);
		}
		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 300));
			if (await this.up(600)) return true;
		}
		return false;
	}
}
