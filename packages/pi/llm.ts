/**
 * Model calls for the dream, through pi's model registry (the user's
 * configured providers and credentials, OAuth included).
 *
 * `json()` asks for a JSON object, validates it, and on a bad reply shows the
 * model its own answer with the error and asks again (3 attempts). A usable
 * reply that still needs a change (`amend`: a note over the length limits) is
 * sent back once; it never fails the call. Transient
 * provider errors are retried with backoff. Usage and cost are tallied per
 * stage for the report.
 *
 * With `tools` (the read-only repository tools, core/repotools.ts) the call is
 * a tool loop in this process: the model may read the checkout before it
 * answers, the tools enforce their own budget, and the calls that go on after
 * tool results are tallied apart (`toolRounds`, `toolCost`).
 */

import type { Api, AssistantMessage, Message, Model, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RepoTools, Stage, StageModel, StageUsage } from "@wierd-memory/core";

export interface CallOptions {
	maxTokens: number;
	timeoutMs: number;
}

export interface JsonOptions<T> extends CallOptions {
	/**
	 * What a usable reply still should change, as a message to the model (undefined: nothing). It is asked once more —
	 * once only: a curator call is the dream's most expensive one — and its next usable reply is taken as it is; when none
	 * comes, the first one is.
	 */
	amend?: (value: T) => string | undefined;
	/** Read-only tools the model may call before it answers; the budget is theirs. */
	tools?: RepoTools;
}

/** One request: the tools declared, whether the model may call them, whether it follows tool results. */
interface Turn {
	tools?: Tool[];
	toolChoice?: "auto" | "none";
	afterTools?: boolean;
}

/** Pull a JSON value out of a model reply (bare, fenced, or embedded in prose). */
export function extractJson(text: string): unknown {
	const t = text.trim();
	const candidates: string[] = [];
	for (const m of t.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/gi)) candidates.push(m[1]);
	candidates.push(t);
	const a = t.indexOf("{");
	const b = t.lastIndexOf("}");
	if (a >= 0 && b > a) candidates.push(t.slice(a, b + 1));
	for (const c of candidates) {
		try {
			return JSON.parse(c);
		} catch {
			// next candidate
		}
	}
	throw new Error("no valid JSON object found in the reply");
}

export function replyText(msg: AssistantMessage): string {
	return msg.content
		.filter((p) => p.type === "text")
		.map((p) => (p as { text: string }).text)
		.join("\n");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});
}

export class Llm {
	readonly usage: Partial<Record<Stage, StageUsage>> = {};

	constructor(
		private ctx: ExtensionContext,
		private log: (msg: string) => void,
		private signal?: AbortSignal,
	) {}

	resolve(spec: StageModel): Model<Api> {
		const slash = spec.model.indexOf("/");
		const model = slash > 0 ? this.ctx.modelRegistry.find(spec.model.slice(0, slash), spec.model.slice(slash + 1)) : undefined;
		if (!model) throw new Error(`model ${spec.model} not found`);
		if (!this.ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`no credentials for ${spec.model}`);
		return model;
	}

	totalCost(): number {
		return Object.values(this.usage).reduce((s, u) => s + (u?.cost ?? 0), 0);
	}

	async complete(stage: Stage, spec: StageModel, system: string, messages: Message[], opts: CallOptions, turn: Turn = {}): Promise<AssistantMessage> {
		const model = this.resolve(spec);
		const reasoning = model.reasoning && spec.thinking !== "off" ? spec.thinking : undefined;
		const u = (this.usage[stage] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0, failures: 0 });
		let lastErr = "";
		for (let attempt = 0; attempt < 3; attempt++) {
			if (this.signal?.aborted) throw new Error("dream aborted (time limit)");
			const signals = [AbortSignal.timeout(opts.timeoutMs)];
			if (this.signal) signals.push(this.signal);
			try {
				const stream = this.ctx.modelRegistry.streamSimple(
					model,
					{ systemPrompt: system, messages, ...(turn.tools ? { tools: turn.tools } : {}) },
					{ signal: AbortSignal.any(signals), maxTokens: opts.maxTokens, ...(reasoning ? { reasoning } : {}), ...(turn.toolChoice ? { toolChoice: turn.toolChoice } : {}) },
				);
				const msg = await stream.result();
				u.calls++;
				u.input += msg.usage?.input ?? 0;
				u.output += msg.usage?.output ?? 0;
				u.cacheRead += msg.usage?.cacheRead ?? 0;
				u.cost += msg.usage?.cost?.total ?? 0;
				if (turn.afterTools) {
					u.toolRounds = (u.toolRounds ?? 0) + 1;
					u.toolCost = (u.toolCost ?? 0) + (msg.usage?.cost?.total ?? 0);
				}
				if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage || msg.stopReason);
				return msg;
			} catch (err) {
				u.failures++;
				lastErr = err instanceof Error ? err.message : String(err);
				if (this.signal?.aborted || attempt === 2) break;
				const wait = [10_000, 45_000][attempt];
				this.log(`  ! ${stage} (${spec.model}) failed: ${lastErr.slice(0, 200)} — retry in ${wait / 1000}s`);
				await sleep(wait, this.signal);
			}
		}
		throw new Error(`${stage} (${spec.model}): ${lastErr}`);
	}

	async json<T>(stage: Stage, spec: StageModel, system: string, user: string, validate: (v: unknown) => T, opts: JsonOptions<T>): Promise<T> {
		const messages: Message[] = [{ role: "user", content: user, timestamp: Date.now() }];
		const tools = opts.tools;
		const started = Date.now();
		let lastErr = "";
		/** The usable reply that was sent back to be amended. */
		let first: { value: T } | undefined;
		let rounds = 0;
		let afterTools = false;
		for (let attempt = 0; attempt < 3; ) {
			// Past the tools' budget, or half the stage's time, the model has to answer. The tools stay declared: a provider
			// refuses a conversation with tool calls in it and no tools.
			const open = !!tools && tools.left() > 0 && Date.now() - started < opts.timeoutMs / 2;
			const msg = await this.complete(stage, spec, system, messages, opts, tools ? { tools: tools.defs, toolChoice: open ? "auto" : "none", afterTools } : {});
			afterTools = false;
			const calls = msg.content.filter((c): c is ToolCall => c.type === "toolCall");
			if (calls.length && tools) {
				// Every round answers at least one call and the tools refuse past their limit: a model that keeps asking anyway is stopped.
				if (++rounds > tools.limits.maxCalls + 3) throw new Error(`${stage}: the model kept calling tools after their limit`);
				messages.push(msg);
				for (const c of calls) {
					if (this.signal?.aborted) throw new Error("dream aborted (time limit)");
					const r = !open
						? { text: "Refused: no more tool calls in this pass. Reply with your answer now.", isError: true }
						: c.argumentsError
							? { text: `Error: ${c.argumentsError}`, isError: true }
							: await tools.call(c.name, c.arguments);
					messages.push({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: r.text }], isError: r.isError, timestamp: Date.now() });
				}
				afterTools = true;
				continue;
			}
			attempt++;
			let value: T;
			try {
				value = validate(extractJson(replyText(msg)));
			} catch (err) {
				lastErr = err instanceof Error ? err.message : String(err);
				if (msg.stopReason === "length") lastErr += " (the reply hit the output limit — be more concise)";
				this.log(`  ! ${stage}: unusable reply (${lastErr.slice(0, 160)}), asking again`);
				messages.push(msg, {
					role: "user",
					content: `Your reply could not be used: ${lastErr}. Reply again with only the corrected JSON object.`,
					timestamp: Date.now(),
				});
				continue;
			}
			// Once, and never after the last attempt: there would be no answer to take.
			const amend = !first && attempt < 3 ? opts.amend?.(value) : undefined;
			if (!amend) return value;
			first = { value };
			this.log(`  ! ${stage}: ${amend.slice(0, 200)} — asking once more`);
			// The whole object again: a model asked to fix some items tends to send only those.
			messages.push(msg, { role: "user", content: `${amend}\nReply again with the whole corrected JSON object — every item, not only the ones you change.`, timestamp: Date.now() });
		}
		if (first) {
			this.log(`  ! ${stage}: no usable reply after the request to amend (${lastErr.slice(0, 160)}), keeping the one before`);
			return first.value;
		}
		throw new Error(`${stage}: no usable JSON after 3 attempts: ${lastErr}`);
	}
}
