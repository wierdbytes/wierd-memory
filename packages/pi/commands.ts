/**
 * /dream · /memory · /remember
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "./runtime.ts";

const DREAM_SUB = [
	{ value: "status", label: "status", description: "Memory, the last dream, what waits for review" },
	{ value: "run", label: "run", description: "Dream now in the background (--since <days> --max <sessions>)" },
	{ value: "review", label: "review", description: "Apply review comments now (no new sessions)" },
	{ value: "dry", label: "dry", description: "Dream without proposing anything: only a report" },
	{ value: "index", label: "index", description: "Rebuild session digests (search corpus) in the background" },
	{ value: "log", label: "log", description: "Tail of the latest dream log" },
	{ value: "open", label: "open", description: "Where to review: the web UI address" },
];

const MEMORY_SUB = [{ value: "status", label: "status", description: "What this session got from memory" }];

function completions(list: typeof DREAM_SUB) {
	return (prefix: string) => {
		const p = prefix.trim().toLowerCase();
		const items = list.filter((c) => c.value.startsWith(p));
		return items.length ? items : null;
	};
}

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A notification in the TUI; plain output in print mode (`pi -p "/dream status"`), where there is no UI to show it. */
function say(ctx: ExtensionContext, text: string, level: "info" | "warning" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else console.log(text);
}

export function registerCommands(pi: ExtensionAPI, rt: Runtime): void {
	pi.registerCommand("dream", {
		description: "wierd-memory: status, run, review, dry, index, log, open",
		getArgumentCompletions: completions(DREAM_SUB),
		handler: async (args, ctx) => {
			const [cmd = "status", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			switch (cmd) {
				case "status":
					return say(ctx, await rt.status(ctx), "info");
				case "log":
					return say(ctx, await rt.dreamLog().catch(why), "info");
				case "open":
					return say(ctx, `wierd-memory: ${rt.client.base}/#/review`, "info");
				case "run":
				case "review":
				case "dry":
				case "index": {
					const opts: { sinceDays?: number; maxSessions?: number } = {};
					for (let i = 0; i < rest.length; i++) {
						if (rest[i] === "--since") opts.sinceDays = Number(rest[++i]);
						else if (rest[i] === "--max") opts.maxSessions = Number(rest[++i]);
					}
					try {
						const run = await rt.startDream(cmd === "index" ? "reindex" : cmd, opts);
						return say(ctx, `wierd-memory: ${cmd} started (${run.id})\nlog: ${run.log}\nwhat it proposes will wait at ${rt.client.base}/#/review`, "info");
					} catch (err) {
						return say(ctx, `wierd-memory: ${why(err)}`, "warning");
					}
				}
				default:
					return say(ctx, "Usage: /dream [status|run|review|dry|index|log|open]", "info");
			}
		},
	});

	pi.registerCommand("memory", {
		description: "wierd-memory: what this session got from memory",
		getArgumentCompletions: completions(MEMORY_SUB),
		handler: async (_args, ctx) => {
			const section = await rt.memorySection(ctx);
			return say(ctx, `${await rt.status(ctx)}${section ? `\n\n<memory>\n${section}\n</memory>` : ""}`, "info");
		},
	});

	pi.registerCommand("remember", {
		description: "Save a note to the memory inbox for the next dream to review",
		handler: async (args, ctx) => {
			const text = (args ?? "").trim();
			if (!text) return say(ctx, "Usage: /remember <what future sessions should know>", "info");
			try {
				const id = await rt.inbox(ctx, text, "user");
				say(ctx, `wierd-memory: saved to the inbox (${id}) — the next dream will propose it for review`, "info");
			} catch (err) {
				say(ctx, `wierd-memory: not saved — ${why(err)}`, "warning");
			}
		},
	});
}
