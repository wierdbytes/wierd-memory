/**
 * Where a note comes from: the sessions (and inbox items, review comments,
 * hand edits) behind it, with the cited lines loaded from `POST /api/evidence`.
 */

import type { Evidence, EvidenceInfo } from "@wierd-memory/core";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { CopyButton, Icon, Spinner } from "../ui.tsx";
import { ago, clip, cls, errorText, EVIDENCE_KIND, fmtDay } from "../util.ts";

const cache = new Map<string, Promise<EvidenceInfo>>();

function loadEvidence(list: readonly Evidence[]): Promise<EvidenceInfo> {
	const refs = list.map((e) => ({ s: e.s, e: e.e }));
	const key = JSON.stringify(refs);
	let p = cache.get(key);
	if (!p) {
		p = api.evidence(refs);
		cache.set(key, p);
		p.catch(() => cache.delete(key));
		if (cache.size > 300) cache.delete(cache.keys().next().value as string);
	}
	return p;
}

function useEvidence(list: readonly Evidence[], on: boolean): { info?: EvidenceInfo; error?: string } {
	const key = JSON.stringify(list.map((e) => [e.s, e.e]));
	const [state, setState] = useState<{ key: string; info?: EvidenceInfo; error?: string }>({ key });
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the list
	useEffect(() => {
		if (!on || !list.length) return;
		let live = true;
		loadEvidence(list).then(
			(info) => live && setState({ key, info }),
			(err: unknown) => live && setState({ key, error: errorText(err) }),
		);
		return () => {
			live = false;
		};
	}, [key, on]);
	return state.key === key ? state : {};
}

type SourceKind = "session" | "inbox" | "review" | "manual" | "pr";

function sourceKind(e: Pick<Evidence, "s">): SourceKind {
	if (e.s.startsWith("inbox:")) return "inbox";
	if (e.s.startsWith("review:")) return "review";
	if (e.s.startsWith("pr#")) return "pr";
	if (e.s === "manual" || e.s.startsWith("manual")) return "manual";
	return "session";
}

function sourceTitle(e: Evidence, info: EvidenceInfo | undefined, titles: Record<string, string> | undefined): string {
	switch (sourceKind(e)) {
		case "inbox":
			return "Inbox item";
		case "review":
			return "Review comment";
		case "pr":
			return `Pull request comment ${e.s}`;
		case "manual":
			return "Hand edit";
		default: {
			const s = info?.sessions[e.s];
			return s?.name || titles?.[e.s] || (s?.first ? clip(s.first.replace(/\s+/g, " "), 90) : "") || `Session ${e.s.slice(0, 8)}`;
		}
	}
}

function kindLabel(e: Evidence): string {
	const k = e.kind ?? (sourceKind(e) === "manual" ? "manual" : sourceKind(e) === "inbox" ? "inbox" : sourceKind(e) === "review" ? "reviewer" : "");
	return k ? (EVIDENCE_KIND[k] ?? k) : "";
}

const isUser = (e: Evidence) => e.kind === "user";

function Line({ role, text }: { role: string; text: string }) {
	const [open, setOpen] = useState(false);
	const flat = text.trim().replace(/\n{3,}/g, "\n\n");
	const long = flat.length > 360;
	return (
		<div className={cls("ev-line", `ev-role-${role.toLowerCase()}`)}>
			<span className="ev-role">{role.toLowerCase()}</span>
			<span className="ev-text">
				{open || !long ? flat : clip(flat, 360)}
				{long ? (
					<button type="button" className="linklike" onClick={() => setOpen(!open)}>
						{open ? "less" : "more"}
					</button>
				) : null}
			</span>
		</div>
	);
}

/** The cited lines of one piece of evidence. */
function Cited({ ev, info, error }: { ev: Evidence; info?: EvidenceInfo; error?: string }) {
	if (error) return <div className="ev-note ev-error">Could not load the lines: {error}</div>;
	const kind = sourceKind(ev);
	if (kind === "manual") return <div className="ev-note">Written or edited by hand.</div>;
	if (kind === "pr") return <div className="ev-note">A GitHub pull request comment (imported from pi-dream).</div>;
	if (!info)
		return (
			<div className="ev-note">
				<Spinner /> loading the cited lines…
			</div>
		);
	if (kind === "inbox") {
		const item = info.inbox[ev.s.slice("inbox:".length)];
		return item ? <Line role={item.source === "user" ? "user" : "agent"} text={item.text} /> : <div className="ev-note">The inbox item is gone.</div>;
	}
	if (kind === "review") return <div className="ev-note">A comment left in a review ({ev.e.join(", ") || ev.s.slice(7)}).</div>;
	const s = info.sessions[ev.s];
	if (!s || s.missing) return <div className="ev-note">This session has no digest (it may have been deleted): the lines cannot be shown.</div>;
	if (!ev.e.length) return <div className="ev-note">The whole session, no particular lines.</div>;
	return (
		<>
			{ev.e.map((id) => {
				const line = s.entries[id];
				return line ? (
					<Line key={id} role={line.role} text={line.text} />
				) : (
					<div key={id} className="ev-note">
						<code>{id}</code> — not in the digest
					</div>
				);
			})}
		</>
	);
}

function Resume({ id }: { id: string }) {
	const cmd = `pi --session ${id}`;
	return <CopyButton text={cmd} label={<code>{cmd}</code>} title="Copy the command that reopens this session" />;
}

/** Compact chips (a review item): click one to see the lines it cites. */
export function EvidenceChips({ evidence, titles }: { evidence: readonly Evidence[]; titles?: Record<string, string> }) {
	const [open, setOpen] = useState<number | null>(null);
	const { info, error } = useEvidence(evidence, open !== null);
	if (!evidence.length) return <span className="dim">no evidence</span>;
	const ev = open !== null ? evidence[open] : undefined;
	return (
		<div className="ev-chips">
			<div className="ev-chip-row">
				{evidence.map((e, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: evidence has no id of its own
					<button key={i} type="button" className={cls("ev-chip", open === i && "is-open", isUser(e) && "is-user")} onClick={() => setOpen(open === i ? null : i)} title={kindLabel(e) || undefined} aria-expanded={open === i}>
						{isUser(e) ? <Icon name="user" size={12} title="the user's own words" /> : null}
						<span className="ev-chip-title">{sourceTitle(e, info, titles)}</span>
						{e.date ? <span className="ev-chip-date">{e.date}</span> : null}
						{e.e.length ? <span className="ev-chip-n">{e.e.length}</span> : null}
					</button>
				))}
			</div>
			{ev ? (
				<div className="ev-open">
					<div className="ev-open-head">
						<span>{kindLabel(ev)}</span>
						{sourceKind(ev) === "session" ? <Resume id={ev.s} /> : null}
					</div>
					<Cited ev={ev} info={info} error={error} />
				</div>
			) : null}
		</div>
	);
}

/** The full list (a note's page): every source with its lines. */
export function EvidenceList({ evidence }: { evidence: readonly Evidence[] }) {
	const { info, error } = useEvidence(evidence, true);
	if (!evidence.length) return <div className="dim">No evidence is recorded for this note.</div>;
	return (
		<div className="ev-list">
			{evidence.map((e, i) => {
				const s = info?.sessions[e.s];
				const when = e.at ?? s?.started;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: evidence has no id of its own
					<div key={i} className="ev-item">
						<div className="ev-item-head">
							<span className="ev-date" title={when ? ago(when) : undefined}>
								{e.date ?? fmtDay(when)}
							</span>
							<span className="ev-item-title">{sourceTitle(e, info, undefined)}</span>
							{kindLabel(e) ? (
								<span className={cls("ev-kind", isUser(e) && "is-user")}>
									{isUser(e) ? <Icon name="user" size={12} /> : null}
									{kindLabel(e)}
								</span>
							) : null}
						</div>
						<div className="ev-lines">
							<Cited ev={e} info={info} error={error} />
						</div>
						{sourceKind(e) === "session" ? (
							<div className="ev-item-foot">
								<Resume id={e.s} />
								{s?.cwd ? <span className="dim mono">{s.cwd}</span> : null}
							</div>
						) : null}
					</div>
				);
			})}
		</div>
	);
}
