/**
 * `wmem serve`: the server process — the memory repository underneath, the
 * HTTP API and the web UI on 127.0.0.1.
 */

import { rmSync, writeFileSync } from "node:fs";
import web from "../../web/index.html";
import { homePaths, loadConfig } from "@wierd-mem/core";
import { App, VERSION } from "./app.ts";
import { handleApi } from "./http.ts";

/** Whether a wierd-mem server already answers on this port. */
async function alreadyUp(port: number): Promise<string | undefined> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
		const s = (await res.json()) as { version?: string; home?: string };
		return s.version ? `wierd-mem ${s.version} (${s.home})` : "something else";
	} catch {
		return undefined;
	}
}

export async function serve(): Promise<void> {
	const port = loadConfig(homePaths().config).port;
	const other = await alreadyUp(port);
	if (other) {
		console.error(`port ${port} already answers: ${other}. Stop it first (wmem service uninstall), or set another "port" in config.json.`);
		process.exit(2);
	}
	const app = await App.start();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: app.cfg.port,
		idleTimeout: 120,
		development: process.env.WMEM_DEV === "1" ? { hmr: true, console: false } : false,
		routes: {
			"/": web,
			"/api/*": (req: Request) => handleApi(app, req),
		},
		fetch: () => new Response("not found", { status: 404 }),
	});
	writeFileSync(app.paths.serverInfo, `${JSON.stringify({ pid: process.pid, port: server.port, url: app.url, version: VERSION, startedAt: new Date().toISOString() }, null, 2)}\n`);
	app.log(`wierd-mem ${VERSION}: ${app.url} — memory in ${app.paths.memory} (branch ${app.repo.branch}${app.remote.url ? `, remote ${app.remote.url}` : ", no remote"})`);
	let stopping = false;
	const stop = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		app.log(`${signal}: stopping`);
		try {
			await server.stop(true);
			await app.stop();
			rmSync(app.paths.serverInfo, { force: true });
		} finally {
			process.exit(0);
		}
	};
	process.on("SIGINT", () => void stop("SIGINT"));
	process.on("SIGTERM", () => void stop("SIGTERM"));
}
