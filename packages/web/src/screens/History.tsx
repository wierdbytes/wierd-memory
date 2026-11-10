/**
 * History: the commits on approved memory; a commit opens to the notes it
 * changed, field by field.
 */

import type { CommitInfo } from "@wierd-memory/core";
import { useState } from "react";
import { api, type CommitChange } from "../api.ts";
import { Changes, notePairs } from "../components/DiffText.tsx";
import { Markdown, TitleText } from "../components/Markdown.tsx";
import { href, useData } from "../hooks.ts";
import { Chip, CopyButton, Empty, Fold, Icon, LoadState } from "../ui.tsx";
import { ago, cls, firstLine, fmtDateTime, plural, scopeLabel } from "../util.ts";

export function HistoryScreen() {
	const [limit, setLimit] = useState(100);
	const history = useData(() => api.history(limit), ["history", limit]);
	const scopes = useData(() => api.scopes(), ["scopes"]);
	const [open, setOpen] = useState<string | null>(null);
	const scopeName = (id: string) => scopes.data?.find((s) => s.id === id)?.name ?? scopeLabel(id);
	const list = history.data;
	return (
		<div className="page">
			<header className="page-head">
				<h1>History</h1>
				<p className="dim">Every change to approved memory is a commit in its git repository: accepted reviews, hand edits (here or in an editor), what was pulled from the remote. Open one to see the notes it changed; a note’s own page can restore any of its versions.</p>
			</header>
			{!list ? (
				<LoadState error={history.error} loading={history.loading} reload={history.reload} />
			) : !list.length ? (
				<Empty title="No commits yet" />
			) : (
				<div className="commits">
					{list.map((c) => (
						<Commit key={c.hash} commit={c} open={open === c.hash} onToggle={() => setOpen(open === c.hash ? null : c.hash)} scopeName={scopeName} />
					))}
					{list.length >= limit ? (
						<button type="button" className="linklike more" onClick={() => setLimit(limit * 4)}>
							Show older commits
						</button>
					) : null}
				</div>
			)}
		</div>
	);
}

function Commit({ commit: c, open, onToggle, scopeName }: { commit: CommitInfo; open: boolean; onToggle: () => void; scopeName: (id: string) => string }) {
	const rest = c.message.split("\n").slice(1).join("\n").trim();
	return (
		<div className={cls("commit", open && "is-open")}>
			<button type="button" className="commit-head" onClick={onToggle} aria-expanded={open}>
				<Icon name="chevron" size={12} />
				<span className="commit-date nowrap" title={fmtDateTime(c.date)}>
					{ago(c.date)}
				</span>
				<span className="commit-msg">{firstLine(c.message)}</span>
				<span className="dim nowrap">{c.author}</span>
				<span className="mono dim">{c.hash.slice(0, 8)}</span>
			</button>
			{open ? (
				<div className="commit-body">
					<div className="dim small commit-meta">
						{fmtDateTime(c.date)} · {c.author} &lt;{c.email}&gt; · <CopyButton text={c.hash} label={<span className="mono">{c.hash}</span>} title="Copy the commit hash" />
					</div>
					{rest ? <pre className="pre-plain dim">{rest}</pre> : null}
					<CommitChanges hash={c.hash} scopeName={scopeName} />
				</div>
			) : null}
		</div>
	);
}

const TYPE: Record<string, { label: string; tone: string }> = {
	added: { label: "added", tone: "green" },
	modified: { label: "changed", tone: "blue" },
	removed: { label: "deleted", tone: "red" },
};

function CommitChanges({ hash, scopeName }: { hash: string; scopeName: (id: string) => string }) {
	const changes = useData(() => api.commit(hash), ["commit", hash], { live: false });
	if (!changes.data) return <LoadState error={changes.error} loading={changes.loading} reload={changes.reload} />;
	if (!changes.data.length) return <div className="dim">This commit changed no notes (settings, charters, prompts or skills).</div>;
	const order = { modified: 0, removed: 1, added: 2 } as Record<string, number>;
	const list = [...changes.data].sort((a, b) => (order[a.type] ?? 3) - (order[b.type] ?? 3));
	return (
		<>
			<div className="dim small">{plural(list.length, "note")} changed</div>
			{list.map((ch, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a commit's changes are a fixed list
				<ChangeRow key={i} change={ch} scopeName={scopeName} many={list.length > 6} />
			))}
		</>
	);
}

function ChangeRow({ change: ch, scopeName, many }: { change: CommitChange; scopeName: (id: string) => string; many: boolean }) {
	const n = ch.after ?? ch.before;
	if (!n) return null;
	const t = TYPE[ch.type] ?? { label: ch.type, tone: "dim" };
	const head = (
		<>
			<Chip tone={t.tone}>{t.label}</Chip> <TitleText text={n.title} />
		</>
	);
	const right = (
		<>
			<span className="dim">{scopeName(n.scope)}</span>
			{ch.after ? (
				<a className="mono id-link" href={href("note", n.id)}>
					{n.id}
				</a>
			) : (
				<span className="mono dim">{n.id}</span>
			)}
		</>
	);
	return (
		<Fold title={head} right={right} defaultOpen={ch.type === "modified" && !many} className="commit-change">
			{ch.type === "modified" ? (
				<Changes pairs={notePairs(ch.before, ch.after)} scopeName={scopeName} />
			) : (
				<>
					{n.when ? (
						<div className="when">
							<span className="when-label">when</span> {n.when}
						</div>
					) : null}
					<Markdown text={n.body} className="item-text" />
				</>
			)}
		</Fold>
	);
}
