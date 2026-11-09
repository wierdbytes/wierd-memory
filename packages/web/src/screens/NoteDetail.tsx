/**
 * One approved note: its text, how it reaches agents, the actions on it
 * (turn off / on, edit, pin, close / reopen, move, delete), where it came
 * from and its history.
 */

import type { NoteHistoryEntry, NotePatch, NoteView, ScopeInfo } from "@wierd-mem/core";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { type ChangePairs, Changes } from "../components/DiffText.tsx";
import { EvidenceList } from "../components/Evidence.tsx";
import { Markdown, TitleText } from "../components/Markdown.tsx";
import { draftOf, NoteForm } from "../components/NoteForm.tsx";
import { ReachChip } from "../components/ReachMark.tsx";
import { go, href, useBusy, useData } from "../hooks.ts";
import { Button, Callout, Chip, confirmDialog, CopyButton, Fold, LoadState } from "../ui.tsx";
import { ago, clip, cls, firstLine, fmtDateTime } from "../util.ts";

interface Props {
	id: string;
	scopes: ScopeInfo[];
	/** Loaded notes, for the titles of linked notes. */
	notes: NoteView[];
}

export function NoteDetail({ id, scopes, notes }: Props) {
	const note = useData(() => api.note(id), ["note", id]);
	const history = useData(() => api.noteHistory(id), ["note-history", id]);
	const [editing, setEditing] = useState(false);
	const { busy, run } = useBusy();
	// biome-ignore lint/correctness/useExhaustiveDependencies: another note closes the form
	useEffect(() => setEditing(false), [id]);

	const n = note.data;
	if (!n) {
		const gone = !!note.error && !note.loading;
		return (
			<div className="detail">
				{gone ? (
					<Callout tone="yellow" title={`Note ${id} is not in memory`}>
						{note.error}. If it was deleted, its history below still has every version — restore one to bring it back.
					</Callout>
				) : (
					<LoadState loading />
				)}
				{gone && history.data?.length ? <History id={id} entries={history.data} scopes={scopes} deleted busy={busy} run={run} /> : null}
			</div>
		);
	}

	const patch = (name: string, p: NotePatch, done: string) =>
		run(name, async () => {
			note.set(await api.patchNote(n.id, p));
		}, done);

	const remove = async () => {
		const { ok } = await confirmDialog({
			title: "Delete this note?",
			body: (
				<>
					<p>“{clip(n.title, 140)}”</p>
					<p>The note leaves memory for good; dreams may propose it again. Its history stays and a version can be restored from the History screen. To only stop agents from getting it, turn it off instead.</p>
				</>
			),
			confirm: "Delete",
			danger: true,
		});
		if (!ok) return;
		const done = await run("delete", () => api.deleteNote(n.id), `Deleted ${n.id}`);
		if (done) go("memory", n.scope);
	};

	const archived = n.status !== "active";
	const titleOf = (nid: string) => notes.find((x) => x.id === nid)?.title;

	return (
		<div className={cls("detail", !n.enabled && "is-off", archived && "is-archived")}>
			{editing ? (
				<>
					<div className="detail-kicker">
						Editing <span className="mono">{n.id}</span> — saved at once as one commit, no review needed
					</div>
					<NoteForm
						initial={draftOf(n)}
						scopes={scopes.map((s) => ({ id: s.id, name: s.name }))}
						submit="Save"
						busy={busy === "edit"}
						onCancel={() => setEditing(false)}
						onSubmit={(_draft, edit) =>
							void run("edit", async () => {
								note.set(await api.patchNote(n.id, edit));
								setEditing(false);
							}, edit.scope ? "Saved and moved" : "Saved")
						}
					/>
				</>
			) : (
				<>
					<h1 className="detail-title">
						<TitleText text={n.title} />
					</h1>
					<div className="chips">
						<ReachChip reach={n.reach} scopeName={n.scopeName} />
						<span className="type-chip">{n.type}</span>
						<a className="chip" href={href("memory", n.scope)} title="Scope">
							{n.scopeName}
						</a>
						{n.pinned ? <Chip tone="yellow" title="First in the index; a dream never closes a pinned note">pinned</Chip> : null}
						{!n.enabled ? <Chip tone="red">turned off</Chip> : null}
						{n.status === "deprecated" ? <Chip tone="dim">closed{n.validUntil ? ` ${n.validUntil}` : ""}</Chip> : null}
						{n.status === "superseded" ? <Chip tone="dim">superseded</Chip> : null}
						<CopyButton text={n.id} label={<span className="mono">{n.id}</span>} title="Copy the note id" />
					</div>
					<div className="detail-dates">
						created {n.created}
						{n.updated && n.updated !== n.created ? ` · updated ${n.updated}` : ""}
						{n.confirmed ? ` · confirmed ${n.confirmed}` : ""}
						{n.stats && (n.stats.helpful || n.stats.harmful) ? (
							<span title="Usefulness votes from session cards: how often the note helped or misled an agent">
								{" "}
								· <span className="text-green">helpful {n.stats.helpful}</span> · <span className={n.stats.harmful ? "text-red" : undefined}>harmful {n.stats.harmful}</span>
							</span>
						) : null}
					</div>

					<div className="detail-actions">
						{n.enabled ? (
							<Button icon="power" busy={busy === "toggle"} disabled={!!busy} onClick={() => void patch("toggle", { enabled: false }, "Turned off: agents no longer get it")} title="Agents stop getting this note and dreams leave it alone; nothing is deleted">
								Turn off
							</Button>
						) : (
							<Button variant="primary" icon="power" busy={busy === "toggle"} disabled={!!busy} onClick={() => void patch("toggle", { enabled: true }, "Turned on")}>
								Turn on
							</Button>
						)}
						<Button icon="edit" disabled={!!busy} onClick={() => setEditing(true)}>
							Edit
						</Button>
						<Button icon="pin" busy={busy === "pin"} disabled={!!busy} onClick={() => void patch("pin", { pinned: !n.pinned }, n.pinned ? "Unpinned" : "Pinned")} title="A pinned note is first in the index and a dream never closes it">
							{n.pinned ? "Unpin" : "Pin"}
						</Button>
						{n.status === "active" ? (
							<Button busy={busy === "status"} disabled={!!busy} onClick={() => void patch("status", { status: "deprecated" }, "Closed: moved to the archive")} title="Deprecate: the note no longer holds. It moves to the archive and can be reopened.">
								Close
							</Button>
						) : (
							<Button busy={busy === "status"} disabled={!!busy} onClick={() => void patch("status", { status: "active" }, "Reopened")}>
								Reopen
							</Button>
						)}
						<span className="spacer" />
						<Button variant="danger" icon="trash" busy={busy === "delete"} disabled={!!busy} onClick={() => void remove()}>
							Delete
						</Button>
					</div>

					{n.when ? (
						<div className="detail-when">
							<div className="label">When it applies</div>
							<div>{n.when}</div>
						</div>
					) : null}
					<Markdown text={n.body} className="detail-body" />

					{n.supersedes.length || n.supersededBy ? (
						<div className="links">
							{n.supersededBy ? (
								<div>
									<span className="label">Superseded by</span> <NoteLink id={n.supersededBy} title={titleOf(n.supersededBy)} />
								</div>
							) : null}
							{n.supersedes.map((sid) => (
								<div key={sid}>
									<span className="label">Supersedes</span> <NoteLink id={sid} title={titleOf(sid)} />
								</div>
							))}
						</div>
					) : null}
				</>
			)}

			<Fold title="Where it came from" count={n.evidence.length} defaultOpen className="section">
				<EvidenceList evidence={n.evidence} />
			</Fold>

			<Fold title="History" count={history.data?.length} defaultOpen className="section">
				{history.data ? <History id={n.id} entries={history.data} scopes={scopes} busy={busy} run={run} onRestored={(v) => note.set(v)} /> : <LoadState error={history.error} loading={history.loading} reload={history.reload} />}
			</Fold>
		</div>
	);
}

function NoteLink({ id, title }: { id: string; title?: string }) {
	return (
		<a href={href("note", id)}>
			<span className="mono">{id}</span>
			{title ? ` ${clip(title, 110)}` : ""}
		</a>
	);
}

const TYPE_LABEL: Record<string, string> = { added: "created", modified: "changed", removed: "deleted" };

interface HistoryProps {
	id: string;
	entries: NoteHistoryEntry[];
	scopes: ScopeInfo[];
	deleted?: boolean;
	busy: string | null;
	run: ReturnType<typeof useBusy>["run"];
	onRestored?: (note: NoteView) => void;
}

function History({ id, entries, scopes, deleted, busy, run, onRestored }: HistoryProps) {
	const scopeName = (sid: string) => scopes.find((s) => s.id === sid)?.name ?? sid;
	const restore = async (h: NoteHistoryEntry) => {
		const { ok } = await confirmDialog({
			title: "Restore this version?",
			body: <p>The note becomes what it was after “{clip(firstLine(h.message), 80)}” ({fmtDateTime(h.date)}). It is a new commit: the current version stays in the history.</p>,
			confirm: "Restore",
		});
		if (!ok) return;
		const v = await run(`restore:${h.commit}`, () => api.restoreNote(id, h.commit), "Restored");
		if (v) {
			onRestored?.(v);
			if (deleted) go("note", id);
		}
	};
	if (!entries.length) return <div className="dim">No commits touched this note.</div>;
	return (
		<div className="history">
			{entries.map((h, i) => {
				const created = h.type === "added";
				const removed = h.type === "removed";
				const canRestore = !removed && (deleted || i > 0);
				return (
					<div key={`${h.commit}:${i}`} className="history-entry">
						<div className="history-head">
							<Chip tone={created ? "green" : removed ? "red" : "blue"}>{TYPE_LABEL[h.type] ?? h.type}</Chip>
							<span className="nowrap" title={fmtDateTime(h.date)}>
								{ago(h.date)}
							</span>
							<span className="dim nowrap">{h.author}</span>
							<span className="mono dim">{h.commit.slice(0, 8)}</span>
							{i === 0 && !deleted && !removed ? <Chip tone="dim">current</Chip> : null}
							<span className="spacer" />
							{canRestore ? (
								<Button small busy={busy === `restore:${h.commit}`} disabled={!!busy} onClick={() => void restore(h)}>
									Restore this version
								</Button>
							) : null}
						</div>
						<div className="history-msg">{firstLine(h.message)}</div>
						{created ? (
							<Fold title="The first version">
								<Created changes={h.changes as ChangePairs} />
							</Fold>
						) : removed ? null : (
							<Changes pairs={h.changes as ChangePairs} scopeName={scopeName} />
						)}
					</div>
				);
			})}
		</div>
	);
}

function Created({ changes }: { changes: ChangePairs }) {
	const val = (f: string) => {
		const v = changes[f]?.[1];
		return typeof v === "string" ? v : "";
	};
	return (
		<div className="created">
			<div className="replaced-title">
				<TitleText text={val("title")} />
			</div>
			{val("when") ? (
				<div className="when">
					<span className="when-label">when</span> {val("when")}
				</div>
			) : null}
			<Markdown text={val("body")} className="item-text" />
		</div>
	);
}
