/**
 * @wierdbytes/pi-memory — pi's side of wierd-memory.
 *
 * Wiring only: what a session sees lives in `runtime.ts` (it asks the
 * wierd-memory server), the dream in `pipeline.ts` (run by `runner.ts` in a
 * headless pi process the server starts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { Runtime } from "./runtime.ts";
import { registerTools } from "./tools.ts";

export default function piWierdMemory(pi: ExtensionAPI) {
	if (process.env.WMEM_CHILD === "1" || process.env.PI_DREAM_CHILD === "1") return;

	pi.registerFlag("no-memory", {
		description: "wierd-memory: no memory injection and no memory tools in this run",
		type: "boolean",
		default: false,
	});

	const rt = new Runtime(pi);

	pi.on("session_start", async (event, ctx) => rt.onSessionStart(event.reason, ctx));
	pi.on("resources_discover", async (event) => ({ skillPaths: rt.active() ? await rt.resourcesFor(event.cwd) : [] }));
	pi.on("before_agent_start", async (event, ctx) => {
		const section = await rt.memorySection(ctx);
		if (section) (event.systemPromptOptions.sections ??= {}).memory = section;
	});

	registerTools(pi, rt);
	registerCommands(pi, rt);
}
