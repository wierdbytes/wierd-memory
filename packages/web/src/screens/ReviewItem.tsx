/**
 * The cards of a review: a proposed change to a note (with its actions and
 * forms), an AGENTS.md proposal, and the comments left for the dream.
 */

import type { AgentsProposal, NoteEdit, ReviewComment, ReviewItem, ReviewView } from "@wierd-memory/core";
import { useEffect, useRef, useState } from "react";
import { Changes, LineDiff, notePairs, WordDiff } from "../components/DiffText.tsx";
import { EvidenceChips } from "../components/Evidence.tsx";
import { Markdown, TitleText } from "../components/Markdown.tsx";
import { draftOf, NoteForm, type ScopeOption } from "../components/NoteForm.tsx";
import { ReachChip } from "../components/ReachMark.tsx";
import { href } from "../hooks.ts";
import { AutoTextarea, Button, Callout, Chip, confirmDialog, Fold, Icon } from "../ui.tsx";
import { ago, cls, kindInfo } from "../util.ts";

// ── an item ──────────────────────────────────────────────────────────────

interface ItemProps {
	item: ReviewItem;
	view: ReviewView;
	scopes: readonly ScopeOption[];
	focused: boolean;
	mode: "edit" | "reject" | "comment" | null;
	busy: string | null;
	register: (el: HTMLElement | null) => void;
	onFocus: () => void;
	onMode: (what: "edit" | "reject" | "comment" | null) => void;
	onAccept: (edit?: NoteEdit) => void;
	onReject: (reason?: string) => void;
	onComment: (body: string) => void;
	onRemoveComment: (c: ReviewComment) => void;
}

export function ItemCard({ item, view, scopes, focused, mode, busy, register, onFocus, onMode, onAccept, onReject, onComment, onRemoveComment }: ItemProps) {
	const k = kindInfo(item.kind);
	const scopeName = (id: string) => view.scopeNames[id] ?? id;
	const comments = view.comments.filter((c) => c.noteId && item.ids.includes(c.noteId));
	const closing = item.kind === "deprecated" || item.kind === "removed";
	const compact = item.kind === "confirmed";
	const inMemory = item.kind !== "added" && item.kind !== "skill" && !!item.note.id;
	const myBusy = busy?.endsWith(`:${item.key}`) ? busy.split(":")[0] : null;

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard walks the items with j / k
		<article ref={register} className={cls("item", `item-${item.kind}`, `tone-${k.tone}`, focused && "is-focused", compact && "item-compact")} onClick={onFocus} aria-current={focused || undefined}>
			<div className="item-head">
				<span className={cls("kind-badge", `tone-${k.tone}`)}>
					<span className="kind-glyph">{k.glyph}</span>
					{k.label}
				</span>
				{!closing ? <ReachChip reach={item.reach} scopeName={item.scopeName} quiet={compact} /> : null}
				{item.kind !== "skill" ? <span className="type-chip">{item.note.type}</span> : null}
				{item.note.pinned ? <Chip tone="yellow">pinned</Chip> : null}
				{item.reviewer ? <Chip tone="blue" title="Made on a review comment">from your comment</Chip> : null}
				<span className="spacer" />
				{item.note.id ? (
					inMemory ? (
						<a className="mono id-link" href={href("note", item.note.id)} title="Open the approved note">
							{item.note.id}
						</a>
					) : (
						<span className="mono dim">{item.note.id}</span>
					)
				) : null}
			</div>

			{mode === "edit" ? (
				<NoteForm initial={draftOf(item.note)} scopes={scopes} submit="Save & accept" allowUnchanged busy={myBusy === "accept"} onCancel={() => onMode(null)} onSubmit={(_d, edit) => onAccept(Object.keys(edit).length ? edit : undefined)} />
			) : (
				<ItemBody item={item} scopeName={scopeName} />
			)}

			{item.risky.length ? (
				<Callout tone="red" title="Risky content">
					{item.risky.map((r) => (r === "pipe-to-shell" ? "The text pipes a download into a shell (curl … | sh). Check the source before letting agents see it." : r)).join(" · ")}
				</Callout>
			) : null}
			{item.newerEvidence?.length ? (
				<Callout tone="yellow" title="The note this closes was seen in newer sessions than this change relies on">
					<span>Check that it really no longer holds.</span>
					<EvidenceChips evidence={item.newerEvidence} titles={view.sessionTitles} />
				</Callout>
			) : null}
			{item.check && (item.check.verdict !== "supported" || item.check.corrected) ? (
				<Callout tone="yellow" title={`Fact check: ${item.check.verdict}${item.check.corrected ? " — the dream corrected the text" : ""}`}>
					{item.check.reason}
				</Callout>
			) : null}

			{!compact || focused ? (
				<dl className="item-meta">
					{item.why.length ? (
						<>
							<dt>Why</dt>
							<dd>{item.why.length === 1 ? item.why[0] : <ul className="plain-list">{item.why.map((w) => <li key={w}>{w}</li>)}</ul>}</dd>
						</>
					) : null}
					{item.remark ? (
						<>
							<dt>Remark</dt>
							<dd>{item.remark}</dd>
						</>
					) : null}
					<dt>Evidence</dt>
					<dd>
						<EvidenceChips evidence={item.evidence} titles={view.sessionTitles} />
						{item.check?.verdict === "supported" && !item.check.corrected ? (
							<span className="check-ok" title="The dream's fact check found the cited lines support this">
								<Icon name="check" size={12} /> fact check: supported
							</span>
						) : null}
					</dd>
				</dl>
			) : null}

			{comments.length ? <Comments list={comments} busy={busy} onRemove={onRemoveComment} /> : null}

			{mode === "reject" ? (
				<RejectForm busy={myBusy === "reject"} onCancel={() => onMode(null)} onSubmit={onReject} />
			) : mode === "comment" ? (
				<CommentForm autoFocus busy={busy === `comment:${item.note.id}`} onCancel={() => onMode(null)} onSubmit={onComment} placeholder="What should the dream do with this note? (“split it”, “move to project X”, “shorter”)" />
			) : mode === "edit" ? null : (
				<div className="item-actions">
					<Button variant="primary" small busy={myBusy === "accept"} disabled={!!busy} onClick={() => onAccept()} kbd={focused ? "a" : undefined}>
						{closing ? (item.kind === "removed" ? "Accept: delete it" : "Accept: close it") : "Accept"}
					</Button>
					{item.editable ? (
						<Button small icon="edit" disabled={!!busy} onClick={() => onMode("edit")} kbd={focused ? "e" : undefined}>
							Edit…
						</Button>
					) : null}
					<Button small variant="danger" disabled={!!busy} onClick={() => onMode("reject")} kbd={focused ? "x" : undefined}>
						Reject
					</Button>
					{item.note.id ? (
						<Button small variant="ghost" disabled={!!busy} onClick={() => onMode("comment")}>
							Comment for the dream
						</Button>
					) : null}
				</div>
			)}
		</article>
	);
}

function ItemBody({ item, scopeName }: { item: ReviewItem; scopeName: (id: string) => string }) {
	const n = item.note;
	const title = (
		<h3 className="item-title">
			<TitleText text={n.title} />
		</h3>
	);
	const when = n.when ? (
		<div className="when">
			<span className="when-label">when</span> {n.when}
		</div>
	) : null;

	switch (item.kind) {
		case "skill": {
			const s = item.skill;
			if (!s) return title;
			return (
				<>
					<h3 className="item-title">
						<code>{s.name}</code>
					</h3>
					<div className="when">{s.description}</div>
					{s.before ? (
						<>
							{s.before.description !== s.description ? <Changes pairs={{ title: [s.before.description, s.description] }} /> : null}
							<Changes pairs={{ body: [s.before.body, s.body] }} />
						</>
					) : (
						<Markdown text={s.body} className="item-text" />
					)}
					<div className="dim small">A skill: a procedure pi loads as a folder with SKILL.md for sessions of this scope.</div>
				</>
			);
		}
		case "updated": {
			const pairs = notePairs(item.before, n, item.fields);
			const bodyChanged = !!pairs.body;
			return (
				<>
					{pairs.title && item.before ? (
						<h3 className="item-title">
							<WordDiff before={item.before.title} after={n.title} />
						</h3>
					) : (
						title
					)}
					{!pairs.when ? when : null}
					<Changes pairs={pairs} scopeName={scopeName} skip={["evidence", "title"]} />
					{!bodyChanged ? (
						<Fold title="Text (unchanged)">
							<Markdown text={n.body} className="item-text" />
						</Fold>
					) : null}
				</>
			);
		}
		case "moved": {
			const pairs = notePairs(item.before, n, item.fields);
			const rest = Object.keys(pairs).filter((f) => !["scope", "evidence", "updated", "confirmed"].includes(f));
			return (
				<>
					{title}
					<div className="move-line">
						<span className="scope-pill">{item.fromName ?? (item.from ? scopeName(item.from) : "?")}</span>
						<span className="arrow">→</span>
						<span className="scope-pill is-to">{item.scopeName}</span>
					</div>
					{when}
					{rest.length ? <Changes pairs={pairs} scopeName={scopeName} skip={["scope", "evidence", "updated", "confirmed"]} /> : null}
					<Fold title="Text">
						<Markdown text={n.body} className="item-text" />
					</Fold>
				</>
			);
		}
		case "superseded": {
			const old = item.before;
			return (
				<>
					{title}
					{when}
					<Markdown text={n.body} className="item-text" />
					{old ? (
						<Fold title="Replaces" right={<a className="mono id-link" href={href("note", old.id)}>{old.id}</a>} className="replaced">
							<div className="replaced-title">
								<TitleText text={old.title} />
							</div>
							{old.when ? (
								<div className="when">
									<span className="when-label">when</span> {old.when}
								</div>
							) : null}
							<Markdown text={old.body} className="item-text" />
							<Fold title="As a diff against the new note">
								<Changes pairs={notePairs(old, n, ["title", "when", "body", "index", "type"])} />
							</Fold>
						</Fold>
					) : null}
				</>
			);
		}
		case "deprecated":
		case "removed":
			return (
				<>
					<h3 className="item-title is-closing">
						<TitleText text={n.title} />
					</h3>
					<div className="dim small">
						{item.kind === "removed" ? "The note is deleted from memory (history keeps it)." : "The note is closed: it stays in the archive, agents no longer get it."}
						{n.validUntil ? ` Valid until ${n.validUntil}.` : ""}
					</div>
					<Fold title="Text of the note">
						{when}
						<Markdown text={n.body} className="item-text" />
					</Fold>
				</>
			);
		case "confirmed":
			return title;
		default:
			return (
				<>
					{title}
					{when}
					<Markdown text={n.body} className="item-text" />
				</>
			);
	}
}

function RejectForm({ busy, onSubmit, onCancel }: { busy: boolean; onSubmit: (reason?: string) => void; onCancel: () => void }) {
	const [reason, setReason] = useState("");
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => ref.current?.focus(), []);
	return (
		<form
			className="inline-form"
			onSubmit={(ev) => {
				ev.preventDefault();
				onSubmit(reason.trim() || undefined);
			}}
			onKeyDown={(ev) => {
				if (ev.key === "Escape") {
					ev.stopPropagation();
					onCancel();
				}
			}}
		>
			<input ref={ref} type="text" value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="Reason (optional) — Enter rejects, Esc cancels" />
			<Button type="submit" variant="danger" small busy={busy}>
				Reject
			</Button>
			<Button small onClick={onCancel} disabled={busy}>
				Cancel
			</Button>
		</form>
	);
}

export function CommentForm({ busy, onSubmit, onCancel, placeholder, autoFocus }: { busy: boolean; onSubmit: (body: string) => void; onCancel?: () => void; placeholder: string; autoFocus?: boolean }) {
	const [body, setBody] = useState("");
	const ref = useRef<HTMLTextAreaElement>(null);
	const sent = useRef(false);
	useEffect(() => {
		if (autoFocus) ref.current?.focus();
	}, [autoFocus]);
	// Clear the box once the comment is saved (the action is no longer busy).
	useEffect(() => {
		if (!busy && sent.current) {
			sent.current = false;
			setBody("");
		}
	}, [busy]);
	const send = () => {
		if (!body.trim() || busy) return;
		sent.current = true;
		onSubmit(body.trim());
	};
	return (
		<form
			className="inline-form inline-form-tall"
			onSubmit={(ev) => {
				ev.preventDefault();
				send();
			}}
			onKeyDown={(ev) => {
				if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
					ev.preventDefault();
					send();
				} else if (ev.key === "Escape" && onCancel && !body.trim()) {
					ev.stopPropagation();
					onCancel();
				}
			}}
		>
			<AutoTextarea ref={ref} minRows={1} value={body} onChange={(ev) => setBody(ev.target.value)} placeholder={placeholder} />
			<Button type="submit" small busy={busy} disabled={!body.trim()}>
				Add comment
			</Button>
			{onCancel ? (
				<Button small onClick={onCancel} disabled={busy}>
					Cancel
				</Button>
			) : null}
		</form>
	);
}

export function Comments({ list, busy, onRemove }: { list: ReviewComment[]; busy: string | null; onRemove?: (c: ReviewComment) => void }) {
	if (!list.length) return null;
	return (
		<div className="comments">
			{list.map((c) => (
				<div key={c.id} className={cls("comment", c.unhandled && "is-unhandled", c.processedRun && "is-done")}>
					<div className="comment-body">{c.body}</div>
					<div className="comment-meta">
						<span>
							{c.author} · {ago(c.at)}
						</span>
						{c.processedRun ? (
							<a href={href("dreams", c.processedRun)}>{c.unhandled ? "read by a dream" : "applied by a dream"}</a>
						) : (
							<>
								<span>{onRemove ? "waits for a dream" : "no dream read it"}</span>
								{onRemove ? (
									<Button variant="link" busy={busy === `uncomment:${c.id}`} disabled={!!busy} onClick={() => onRemove(c)}>
										Delete
									</Button>
								) : null}
							</>
						)}
					</div>
					{c.unhandled ? (
						<div className="comment-warn">
							<Icon name="warn" size={12} /> The dream could not apply it: {c.unhandled}
						</div>
					) : null}
				</div>
			))}
		</div>
	);
}

// ── AGENTS.md ────────────────────────────────────────────────────────────

export function AgentsCard({ proposal: a, busy, onApply, onReject }: { proposal: AgentsProposal; busy: string | null; onApply: () => void; onReject: () => void }) {
	const reject = async () => {
		const { ok } = await confirmDialog({ title: "Reject this proposal?", body: <p>The edit of {a.rel} is dropped; the file is not touched.</p>, confirm: "Reject", danger: true });
		if (ok) onReject();
	};
	return (
		<article className={cls("item tone-blue", a.status === "failed" && "is-failed")}>
			<div className="item-head">
				<span className="kind-badge tone-blue">{a.rel}</span>
				<span className="type-chip">{a.projectName}</span>
				<span className="spacer" />
				<span className="mono dim file-path">
					{a.repoRoot}/{a.rel}
				</span>
			</div>
			{a.summary ? <h3 className="item-title">{a.summary}</h3> : null}
			{a.status === "failed" ? (
				<Callout tone="red" title="Applying it failed">
					{a.error ?? "The file no longer matches what the dream read."}
				</Callout>
			) : null}
			{a.edits.map((e, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: edits have no ids
				<div key={i} className="agents-edit">
					<div className="change-label">{e.old ? `Edit ${i + 1}` : `Edit ${i + 1}: added at the end`}</div>
					<LineDiff before={e.old} after={e.new} context={3} />
				</div>
			))}
			{a.rationale.length ? (
				<dl className="item-meta">
					<dt>Why</dt>
					<dd>
						<ul className="plain-list">
							{a.rationale.map((r) => (
								<li key={r}>{r}</li>
							))}
						</ul>
					</dd>
				</dl>
			) : null}
			<div className="item-actions">
				<Button variant="primary" small busy={busy === `agents-apply:${a.id}`} disabled={!!busy} onClick={onApply}>
					{a.status === "failed" ? "Try to apply again" : "Apply to working copy"}
				</Button>
				<Button small variant="danger" busy={busy === `agents-reject:${a.id}`} disabled={!!busy} onClick={() => void reject()}>
					Reject
				</Button>
				<span className="dim small">Edits the file in the working copy; commits nothing.</span>
			</div>
		</article>
	);
}

export function AgentsDone({ list }: { list: AgentsProposal[] }) {
	if (!list.length) return null;
	return (
		<div className="rows">
			{list.map((a) => (
				<div key={a.id} className="row">
					<Chip tone={a.status === "applied" ? "green" : "red"}>{a.status}</Chip>
					<span className="row-main">
						{a.projectName} <code>{a.rel}</code>
						{a.summary ? ` — ${a.summary}` : ""}
					</span>
					<span className="dim">{ago(a.decidedAt)}</span>
				</div>
			))}
		</div>
	);
}
