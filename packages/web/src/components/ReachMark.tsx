/**
 * How a note reaches agents: ● always in context, ○ when relevant,
 * · search only, ! over budget, ⊘ off, — archived.
 */

import type { Reach } from "@wierd-memory/core";
import { cls, REACH } from "../util.ts";

export function ReachMark({ reach }: { reach: Reach }) {
	const r = REACH[reach];
	return (
		<span className={cls("reach-mark", `reach-${reach}`)} title={`${r.label} — ${r.hint}`}>
			{r.glyph}
		</span>
	);
}

/** The mark with its meaning spelled out; `always` is loud on purpose (`quiet`: when nothing about it changes). */
export function ReachChip({ reach, scopeName, quiet }: { reach: Reach; scopeName?: string; quiet?: boolean }) {
	const r = REACH[reach];
	return (
		<span className={cls("reach-chip", `reach-${reach}`, quiet && "is-quiet")} title={r.hint}>
			<span className="reach-glyph">{r.glyph}</span>
			{r.label}
			{reach === "always" && scopeName && !quiet ? <span className="reach-where"> · every {scopeName === "Global" ? "session" : `${scopeName} session`}</span> : null}
		</span>
	);
}
