/**
 * The tool loop of the dream's model calls, against a scripted model registry: tool calls are answered from a real
 * checkout, the budget ends the loop, what the rounds after tool results cost is tallied apart.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, Message, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RepoTools } from "@wierd-memory/core";
import { Llm } from "../llm.ts";

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "wmem-llm-"));
	writeFileSync(join(root, "tool.sh"), "#!/bin/sh\n# Output is capped at 50 lines.\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

type Request = { messages: Message[]; tools?: string[]; toolChoice?: string };

/** A registry whose model answers with `reply(request number, request)`. */
function registry(reply: (n: number, req: Request) => AssistantMessage["content"]) {
	const requests: Request[] = [];
	const ctx = {
		modelRegistry: {
			find: () => ({ id: "m", provider: "p", api: "x", reasoning: false }),
			hasConfiguredAuth: () => true,
			streamSimple: (_model: unknown, context: Context, options: { toolChoice?: string }) => {
				const req = { messages: [...context.messages], tools: context.tools?.map((t) => t.name), toolChoice: options.toolChoice };
				requests.push(req);
				const content = reply(requests.length, req);
				const msg = {
					role: "assistant",
					content,
					api: "x",
					provider: "p",
					model: "m",
					usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 * requests.length } },
					stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
					timestamp: Date.now(),
				} as AssistantMessage;
				return { result: async () => msg };
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, requests };
}

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name, arguments: args as ToolCall["arguments"] });
const text = (t: string) => ({ type: "text" as const, text: t });
const spec = { model: "p/m", thinking: "off" as const };
const opts = { maxTokens: 1000, timeoutMs: 60_000 };
const valid = (v: unknown) => v as { ok: boolean };

describe("the tool loop", () => {
	it("answers the model's tool calls from the checkout, then takes its JSON", async () => {
		const { ctx, requests } = registry((n) => (n === 1 ? [text("let me look"), call("c1", "grep", { pattern: "capped at", literal: true })] : [text('{"ok": true}')]));
		const llm = new Llm(ctx, () => {});
		const tools = new RepoTools([{ name: "local:x", root }], { maxCalls: 5, maxOutputChars: 10_000 }, { rg: false });
		expect(await llm.json("analyze", spec, "sys", "input", valid, { ...opts, tools })).toEqual({ ok: true });
		expect(requests.map((r) => [r.toolChoice, r.tools?.length])).toEqual([
			["auto", 6],
			["auto", 6],
		]);
		const result = requests[1].messages.at(-1) as Extract<Message, { role: "toolResult" }>;
		expect(result).toMatchObject({ role: "toolResult", toolCallId: "c1", toolName: "grep", isError: false });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("tool.sh:2:# Output is capped at 50 lines.") });
		// the second call follows tool results: its cost is what the tools cost
		expect(llm.usage.analyze).toMatchObject({ calls: 2, toolRounds: 1, toolCost: 0.02 });
		expect(llm.usage.analyze?.cost).toBeCloseTo(0.03);
		expect(tools.stats).toMatchObject({ calls: 1, byTool: { grep: 1 } });
	});

	it("past the budget the model has to answer", async () => {
		const { ctx, requests } = registry((n) => (n === 1 ? [call("a", "ls", {}), call("b", "read", { path: "tool.sh" })] : [text('```json\n{"ok": true}\n```')]));
		const tools = new RepoTools([{ name: "local:x", root }], { maxCalls: 1, maxOutputChars: 10_000 });
		expect(await new Llm(ctx, () => {}).json("verify", spec, "sys", "input", valid, { ...opts, tools })).toEqual({ ok: true });
		const results = requests[1].messages.filter((m) => m.role === "toolResult") as Array<Extract<Message, { role: "toolResult" }>>;
		expect(results.map((r) => [r.toolCallId, r.isError])).toEqual([
			["a", false],
			["b", true],
		]);
		expect(results[1].content[0]).toMatchObject({ text: expect.stringContaining("Refused") });
		// the tools stay declared (the conversation has calls in it), but may not be called
		expect(requests[1].toolChoice).toBe("none");
		expect(requests[1].tools?.length).toBe(6);
	});

	it("stops a model that keeps calling tools, and asks again for JSON it cannot use", async () => {
		const { ctx, requests } = registry(() => [call(`c${Math.random()}`, "ls", {})]);
		const tools = new RepoTools([{ name: "local:x", root }], { maxCalls: 2, maxOutputChars: 10_000 });
		await expect(new Llm(ctx, () => {}).json("analyze", spec, "sys", "input", valid, { ...opts, tools })).rejects.toThrow("kept calling tools");
		expect(requests.length).toBe(6);
		expect(tools.stats.calls).toBe(2);
		// a bad answer is still asked again, tools or not
		const again = registry((n) => [text(n === 1 ? "no json here" : '{"ok": false}')]);
		expect(await new Llm(again.ctx, () => {}).json("cards", spec, "sys", "input", valid, opts)).toEqual({ ok: false });
		expect(again.requests.map((r) => [r.toolChoice, r.tools])).toEqual([
			[undefined, undefined],
			[undefined, undefined],
		]);
		expect(again.requests[1].messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("could not be used") });
	});
});
