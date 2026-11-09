/**
 * AGENTS.md / CLAUDE.md proposals.
 *
 * Edits are exact text replacements proposed by a dream. They wait in the
 * review like notes do; accepting one applies it to the file in the project's
 * working copy (nothing is committed — that stays with the user).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface AgentsEdit {
	old: string;
	new: string;
}

export const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", "AGENTS.MD", "CLAUDE.MD"];

export function findContextFile(dir: string | undefined): { path: string; rel: string } | undefined {
	if (!dir) return undefined;
	for (const rel of CONTEXT_FILES) {
		const path = join(dir, rel);
		if (existsSync(path)) return { path, rel };
	}
	return undefined;
}

export function applyEdits(content: string, edits: AgentsEdit[]): { content: string; skipped: number } | { error: string } {
	let out = content;
	let skipped = 0;
	for (const [i, e] of edits.entries()) {
		if (e.old === "") {
			if (e.new.trim() && out.includes(e.new.trim())) {
				skipped++;
				continue;
			}
			out = `${out.replace(/\s*$/, "")}\n\n${e.new.trim()}\n`;
			continue;
		}
		const first = out.indexOf(e.old);
		if (first < 0) {
			// Already applied.
			if (e.new && out.includes(e.new)) {
				skipped++;
				continue;
			}
			return { error: `edit ${i + 1}: text not found` };
		}
		if (out.indexOf(e.old, first + 1) >= 0) return { error: `edit ${i + 1}: text is not unique` };
		out = out.slice(0, first) + e.new + out.slice(first + e.old.length);
	}
	return { content: out, skipped };
}

export function renderEditsDiff(rel: string, edits: AgentsEdit[]): string {
	const blocks = edits.map((e) => {
		const minus = e.old ? e.old.split("\n").map((l) => `- ${l}`) : ["- (append at the end)"];
		const plus = e.new.split("\n").map((l) => `+ ${l}`);
		return [...minus, ...plus].join("\n");
	});
	return `\`${rel}\`\n\n\`\`\`diff\n${blocks.join("\n\n")}\n\`\`\``;
}
