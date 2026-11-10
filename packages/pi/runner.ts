/**
 * Entry point of the headless dream process. Not listed in `pi.extensions`:
 * the wierd-memory server starts
 *
 *   pi -p --no-session --no-extensions -e <provider ext> -e runner.ts "/wmem-dream-run --run-id …"
 *
 * so the dream runs with pi's model registry and credentials but without the
 * user's other extensions (sounds, voice, status bars) and without writing a
 * session file of its own.
 *
 * Started by hand without `--run-id` (to debug a dream), it registers the run
 * with the server itself: `--dry` / `--review-only` / `--reindex`, `--since <days>`, `--max <sessions>`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DreamSubmit, DreamSubmitResult, DreamWorkspace, RunInfo } from "@wierd-memory/core";
import { homePaths, loadConfig, wmemHome } from "@wierd-memory/core";
import { Client } from "./client.ts";
import { Llm } from "./llm.ts";
import { dream, parseRunArgs, type RunArgs, runLogger } from "./pipeline.ts";

const MINUTE = 60_000;

export async function runDream(ctx: ExtensionContext, args: RunArgs): Promise<void> {
	const client = new Client();
	let runId = args.runId;
	if (!runId) {
		const run = await client.post<RunInfo>("/api/dream/begin", { mode: args.mode ?? "run", pid: process.pid, sinceDays: args.sinceDays, maxSessions: args.maxSessions });
		runId = run.id;
	}
	const id = runId;
	const log = runLogger(homePaths(wmemHome(), loadConfig().memory.dir).runs, id);
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const api = {
			workspace: async (run: string) => {
				const w = await client.get<DreamWorkspace>(`/api/dream/workspace?run=${encodeURIComponent(run)}`, 60_000);
				timer = setTimeout(() => controller.abort(), w.config.dream.maxRuntimeMinutes * MINUTE);
				return w;
			},
			submit: (sub: DreamSubmit) => client.post<DreamSubmitResult>("/api/dream/submit", sub, 120_000),
		};
		const out = await dream(id, { api, llm: new Llm(ctx, log, controller.signal), log, signal: controller.signal });
		log(`done: ${out.result?.status ?? out.status}${out.result?.reviewId ? ` — review ${out.result.reviewId}: ${out.result.items} item(s) to decide, ${out.result.url}` : ""} · ${out.sessions} session(s) · $${out.cost.toFixed(2)}`);
	} catch (err) {
		const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
		log(`ERROR: ${msg}`);
		await client.post("/api/dream/fail", { runId: id, error: msg.split("\n")[0] }).catch(() => undefined);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export default function wmemDreamRunner(pi: ExtensionAPI) {
	pi.registerCommand("wmem-dream-run", {
		description: "wierd-memory: run a dream in this process (used by the wierd-memory server)",
		handler: async (args, ctx) => {
			await runDream(ctx, parseRunArgs(args ?? ""));
		},
	});
}
