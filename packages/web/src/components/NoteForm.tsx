/**
 * The form a note's text is edited in: in a review ("edit and accept"), on a
 * note's page, and for a new note. The draft lives here, so a refetch of the
 * data around it never touches what the user is typing.
 */

import type { IndexMode, Note, NoteEdit, NoteType } from "@wierd-memory/core";
import { useEffect, useRef, useState } from "react";
import { AutoTextarea, Button, Field } from "../ui.tsx";
import { cls, INDEX_LABEL, INDEX_MODES, NOTE_TYPES, REACH } from "../util.ts";

export interface NoteDraft {
	title: string;
	body: string;
	when: string;
	index: IndexMode;
	type: NoteType;
	scope: string;
}

export function draftOf(note: Pick<Note, "title" | "body" | "when" | "index" | "type" | "scope">): NoteDraft {
	return { title: note.title, body: note.body, when: note.when ?? "", index: note.index, type: note.type, scope: note.scope };
}

/** What the draft changes against where it started (`when: null` clears it). */
export function draftEdit(initial: NoteDraft, draft: NoteDraft): NoteEdit {
	const edit: NoteEdit = {};
	if (draft.title.trim() !== initial.title.trim()) edit.title = draft.title.trim();
	if (draft.body.trim() !== initial.body.trim()) edit.body = draft.body.trim();
	if (draft.when.trim() !== initial.when.trim()) edit.when = draft.when.trim() || null;
	if (draft.index !== initial.index) edit.index = draft.index;
	if (draft.type !== initial.type) edit.type = draft.type;
	if (draft.scope !== initial.scope) edit.scope = draft.scope;
	return edit;
}

export interface ScopeOption {
	id: string;
	name: string;
}

interface Props {
	initial: NoteDraft;
	scopes: readonly ScopeOption[];
	submit: string;
	busy?: boolean;
	/** Allow submitting an untouched draft ("save & accept" of a proposal as it is). */
	allowUnchanged?: boolean;
	onSubmit: (draft: NoteDraft, edit: NoteEdit) => void;
	onCancel: () => void;
}

export function NoteForm({ initial, scopes, submit, busy, allowUnchanged, onSubmit, onCancel }: Props) {
	const [draft, setDraft] = useState<NoteDraft>(initial);
	const start = useRef(initial);
	const titleRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		const el = titleRef.current;
		if (!el) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
	}, []);
	const edit = draftEdit(start.current, draft);
	const dirty = Object.keys(edit).length > 0;
	const valid = draft.title.trim().length > 0;
	const set = <K extends keyof NoteDraft>(k: K, v: NoteDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
	const options = scopes.some((s) => s.id === draft.scope) ? scopes : [...scopes, { id: draft.scope, name: draft.scope }];
	const send = () => {
		if (!valid || busy || (!dirty && !allowUnchanged)) return;
		onSubmit(draft, edit);
	};
	return (
		<form
			className="note-form"
			onSubmit={(ev) => {
				ev.preventDefault();
				send();
			}}
			onKeyDown={(ev) => {
				if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
					ev.preventDefault();
					send();
				} else if (ev.key === "Escape" && !dirty) {
					ev.stopPropagation();
					onCancel();
				}
			}}
		>
			<Field label="Title" hint="One line: this is what agents see in their context." wide>
				<AutoTextarea ref={titleRef} className="input-title" minRows={1} value={draft.title} onChange={(ev) => set("title", ev.target.value.replace(/\n/g, " "))} />
			</Field>
			<Field label="When it applies" hint="The situation in which an agent should open this note (used for “when relevant”)." wide>
				<input type="text" value={draft.when} onChange={(ev) => set("when", ev.target.value)} placeholder="optional" />
			</Field>
			<Field label="Text" hint="Markdown. The specifics an agent reads after opening the note." wide>
				<AutoTextarea className="mono" minRows={5} value={draft.body} onChange={(ev) => set("body", ev.target.value)} />
			</Field>
			<div className="form-row">
				<div className="field">
					<span className="field-label">Reaches agents</span>
					<div className="segmented" role="radiogroup" aria-label="Reaches agents">
						{INDEX_MODES.map((m) => (
							<button key={m} type="button" role="radio" aria-checked={draft.index === m} className={cls(draft.index === m && "is-on", `reach-${m}`)} onClick={() => set("index", m)} title={REACH[m].hint}>
								<span className="reach-glyph">{REACH[m].glyph}</span>
								{INDEX_LABEL[m]}
							</button>
						))}
					</div>
				</div>
				<Field label="Type">
					<select value={draft.type} onChange={(ev) => set("type", ev.target.value as NoteType)}>
						{NOTE_TYPES.map((t) => (
							<option key={t} value={t}>
								{t}
							</option>
						))}
					</select>
				</Field>
				<Field label="Scope">
					<select value={draft.scope} onChange={(ev) => set("scope", ev.target.value)}>
						{options.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name}
							</option>
						))}
					</select>
				</Field>
			</div>
			<div className="form-actions">
				<Button type="submit" variant="primary" busy={busy} disabled={!valid || (!dirty && !allowUnchanged)} kbd="⌘↵">
					{submit}
				</Button>
				<Button onClick={onCancel} disabled={busy}>
					Cancel
				</Button>
				{dirty ? <span className="dim">unsaved changes</span> : null}
				{!valid ? <span className="form-error">a title is required</span> : null}
			</div>
		</form>
	);
}
