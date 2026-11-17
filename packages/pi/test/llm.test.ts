/**
 * `Llm.json()` against a scripted model registry: a reply that cannot be used is asked for again, a usable one that
 * writes a note over the length limits is sent back once to be shortened, and a usable reply is never lost.
 */

import { describe, expect, it } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ParsedOps, parseOps } from "@wierd-memory/core";
import { Llm } from "../llm.ts";
import { shortenRequest } from "../pipeline.ts";

/** A model that answers with `replies`, one per call, and remembers what each call was sent. */
function scripted(replies: string[]) {
	const sent: Message[][] = [];
	const ctx = {
		modelRegistry: {
			find: () => ({ id: "m", provider: "p", reasoning: false }),
			hasConfiguredAuth: () => true,
			streamSimple: (_model: unknown, c: { messages: Message[] }) => {
				sent.push([...c.messages]);
				const text = replies.shift() ?? "";
				return { result: async () => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0.01 } } }) };
			},
		},
	} as unknown as ExtensionContext;
	const logs: string[] = [];
	return { llm: new Llm(ctx, (m) => logs.push(m)), sent, logs };
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `слово${i}`).join(" ");
const reply = (...bodies: number[]) => JSON.stringify({ ops: bodies.map((n, i) => ({ op: "add", ref: `op${i + 1}`, scope: "project", type: "fact", title: `Заметка ${i + 1}`, body: words(n), index: "none", rationale: "r", evidence: [{ s: "inbox:i1", e: [] }] })) });
const ask = (llm: Llm) => llm.json<ParsedOps>("analyze", { model: "p/m", thinking: "off" }, "system", "input", parseOps, { maxTokens: 1000, timeoutMs: 10_000, amend: shortenRequest });
const lastText = (msgs: Message[]) => {
	const m = msgs.at(-1);
	return typeof m?.content === "string" ? m.content : "";
};
const bodyWords = (p: ParsedOps) => p.ops.map((o) => (o.op === "add" ? (o.body ?? "").split(" ").length : 0));

describe("Llm.json", () => {
	it("sends a note over the length limits back once, with what is over, and takes the next usable reply", async () => {
		const { llm, sent, logs } = scripted([reply(30, 134), reply(30, 90)]);
		const out = await ask(llm);
		expect(bodyWords(out)).toEqual([30, 90]);
		expect(sent.length).toBe(2);
		const request = lastText(sent[1]);
		expect(request).toContain("op2 (add): body is 134 words, limit 120");
		expect(request).not.toContain("op1");
		expect(request).toContain("the whole corrected JSON object");
		// the model sees its own reply before the request
		expect(sent[1].map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(logs.some((l) => l.includes("asking once more"))).toBe(true);
		expect(llm.usage.analyze?.calls).toBe(2);
	});

	it("asks only once: a reply still over the limits is taken as it is", async () => {
		const { llm, sent } = scripted([reply(150), reply(125), reply(10)]);
		expect(bodyWords(await ask(llm))).toEqual([125]);
		expect(sent.length).toBe(2);
	});

	it("keeps the first usable reply when the ones after the request cannot be used", async () => {
		const { llm, sent, logs } = scripted([reply(140), "not json", '{"nope": 1}']);
		expect(bodyWords(await ask(llm))).toEqual([140]);
		expect(sent.length).toBe(3);
		expect(lastText(sent[2])).toContain("could not be used");
		expect(logs.at(-1)).toContain("keeping the one before");
	});

	it("does not ask to shorten on the last attempt, and still fails when no reply is usable", async () => {
		const late = scripted(["x", "y", reply(140)]);
		expect(bodyWords(await ask(late.llm))).toEqual([140]);
		expect(late.sent.length).toBe(3);
		const none = scripted(["x", "y", "z"]);
		await expect(ask(none.llm)).rejects.toThrow("no usable JSON after 3 attempts");
	});

	it("returns a reply within the limits at once", async () => {
		const { llm, sent } = scripted([reply(120)]);
		expect(bodyWords(await ask(llm))).toEqual([120]);
		expect(sent.length).toBe(1);
	});
});
