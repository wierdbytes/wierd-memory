/**
 * Inbox: things agents (or the user) asked to remember, waiting for the next
 * dream to turn them into notes.
 */

import type { InboxItem, InboxKind } from "@wierd-mem/core";
import { useState } from "react";
import { api } from "../api.ts";
import { useBusy, useData } from "../hooks.ts";
import { AutoTextarea, Button, Chip, confirmDialog, Empty, Field, Icon, LoadState } from "../ui.tsx";
import { ago, clip, fmtDateTime, INBOX_KINDS, plural } from "../util.ts";

export function InboxScreen() {
	const inbox = useData(() => api.inbox(), ["inbox"]);
	const { busy, run } = useBusy();

	const dismiss = async (item: InboxItem) => {
		const { ok } = await confirmDialog({ title: "Dismiss this item?", body: <p>“{clip(item.text, 200)}” — the next dream will not see it.</p>, confirm: "Dismiss", danger: true });
		if (ok) void run(`dismiss:${item.id}`, () => api.dismissInbox(item.id), "Dismissed");
	};

	return (
		<div className="page">
			<header className="page-head">
				<div className="page-title-row">
					<h1>Inbox</h1>
					{inbox.data ? <span className="dim">{plural(inbox.data.length, "item")} waiting for the next dream</span> : null}
				</div>
				<p className="dim">What agents saved with memory_inbox and what you add here. A dream reads the inbox, checks each item against the sessions and proposes notes — nothing here is memory yet.</p>
			</header>

			<AddForm />

			{!inbox.data ? (
				<LoadState error={inbox.error} loading={inbox.loading} reload={inbox.reload} />
			) : inbox.data.length ? (
				<div className="cards">
					{inbox.data.map((item) => (
						<article key={item.id} className="item inbox-item">
							<div className="item-head">
								<Chip tone={item.source === "user" ? "blue" : "purple"}>
									{item.source === "user" ? <Icon name="user" size={12} /> : null}
									{item.source === "user" ? "you" : "agent"}
								</Chip>
								{item.kind ? <span className="type-chip">{item.kind}</span> : null}
								<span className="scope-pill">→ {item.scope === "global" || item.scopeId === "global" ? "Global" : (item.projectName ?? "project")}</span>
								{item.scope === undefined && item.scopeId !== "global" ? <span className="dim small">the dream decides: project or global</span> : null}
								<span className="spacer" />
								<span className="dim nowrap" title={fmtDateTime(item.ts)}>
									{ago(item.ts)}
								</span>
								<span className="mono dim">{item.id}</span>
							</div>
							<div className="inbox-text">{item.text}</div>
							<div className="item-actions">
								<Button small variant="danger" busy={busy === `dismiss:${item.id}`} disabled={!!busy} onClick={() => void dismiss(item)}>
									Dismiss
								</Button>
								{item.cwd ? <span className="dim mono small">{item.cwd}</span> : null}
							</div>
						</article>
					))}
				</div>
			) : (
				<Empty title="The inbox is empty">Nothing waits for the next dream.</Empty>
			)}
		</div>
	);
}

function AddForm() {
	const scopes = useData(() => api.scopes(), ["scopes"]);
	const [text, setText] = useState("");
	const [target, setTarget] = useState("global");
	const [kind, setKind] = useState<InboxKind | "">("");
	const { busy, run } = useBusy();
	const projects = (scopes.data ?? []).filter((s) => s.root);
	const add = async () => {
		const project = projects.find((s) => s.id === target);
		const item = await run(
			"add",
			() => api.addInbox({ text: text.trim(), scope: project ? "project" : "global", cwd: project?.root ?? undefined, kind: kind || undefined }),
			"Added: the next dream will consider it",
		);
		if (item) setText("");
	};
	return (
		<form
			className="panel add-form"
			onSubmit={(ev) => {
				ev.preventDefault();
				void add();
			}}
			onKeyDown={(ev) => {
				if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
					ev.preventDefault();
					if (text.trim()) void add();
				}
			}}
		>
			<Field label="Something agents should remember" wide>
				<AutoTextarea minRows={2} value={text} onChange={(ev) => setText(ev.target.value)} placeholder="A preference, a procedure that worked, a pitfall and its fix — with the specifics (commands, paths, reasons)" />
			</Field>
			<div className="form-row">
				<Field label="For">
					<select value={target} onChange={(ev) => setTarget(ev.target.value)}>
						<option value="global">Global — every project</option>
						{projects.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name}
							</option>
						))}
					</select>
				</Field>
				<Field label="Kind">
					<select value={kind} onChange={(ev) => setKind(ev.target.value as InboxKind | "")}>
						<option value="">let the dream decide</option>
						{INBOX_KINDS.map((k) => (
							<option key={k} value={k}>
								{k}
							</option>
						))}
					</select>
				</Field>
				<div className="form-actions">
					<Button type="submit" variant="primary" icon="plus" busy={busy === "add"} disabled={!text.trim()}>
						Add to inbox
					</Button>
				</div>
			</div>
		</form>
	);
}
