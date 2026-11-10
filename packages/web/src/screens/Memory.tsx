/**
 * Memory: approved notes by scope — browse, search, open one; a scope's
 * purpose (charter) and what its index puts into every session.
 */

import type { NoteView, ScopeInfo } from "@wierd-memory/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type PromptsInfo, type SkillInfo } from "../api.ts";
import { Markdown, TitleText } from "../components/Markdown.tsx";
import { NoteForm } from "../components/NoteForm.tsx";
import { ReachMark } from "../components/ReachMark.tsx";
import { go, href, type Route, useBusy, useData, useHotkeys } from "../hooks.ts";
import { AutoTextarea, Button, Chip, confirmDialog, Empty, Fold, Icon, LoadState, Meter } from "../ui.tsx";
import { cls, GLOBAL_SCOPE, plural, REACH } from "../util.ts";
import { NoteDetail } from "./NoteDetail.tsx";

const ALL = "";
/** The scope the list showed last: a note opened from it keeps the list in place. */
let lastScope = ALL;

function matches(n: NoteView, words: string[]): boolean {
	if (!words.length) return true;
	const hay = `${n.title}\n${n.when ?? ""}\n${n.body}\n${n.id}`.toLowerCase();
	return words.every((w) => hay.includes(w));
}

export function MemoryScreen({ route }: { route: Route }) {
	const notes = useData(() => api.notes(), ["notes"]);
	const scopes = useData(() => api.scopes(), ["scopes"]);
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const [archivedOpen, setArchivedOpen] = useState(false);
	const searchRef = useRef<HTMLInputElement>(null);

	const all = notes.data ?? [];
	const scopeList = scopes.data ?? [];
	const noteId = route.name === "note" ? route.arg : undefined;
	const current = noteId ? all.find((n) => n.id === noteId) : undefined;
	let scope = route.name === "memory" ? (route.arg ?? ALL) : lastScope;
	if (current && scope !== ALL && current.scope !== scope) scope = current.scope;
	lastScope = scope;
	const scopeInfo = scopeList.find((s) => s.id === scope);

	// biome-ignore lint/correctness/useExhaustiveDependencies: leaving the place closes the new-note form
	useEffect(() => setCreating(false), [route.name, route.arg]);

	const words = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);
	const inScope = useMemo(() => (scope === ALL ? all : all.filter((n) => n.scope === scope)), [all, scope]);
	const found = useMemo(() => inScope.filter((n) => matches(n, words)), [inScope, words]);
	const elsewhere = useMemo(() => (scope === ALL || !words.length ? 0 : all.filter((n) => n.scope !== scope && matches(n, words)).length), [all, scope, words]);
	const live = found.filter((n) => n.status === "active");
	const archived = found.filter((n) => n.status !== "active");
	const visible = words.length ? [...live, ...archived] : live;

	const step = (d: number) => {
		if (!visible.length) return;
		const at = visible.findIndex((n) => n.id === noteId);
		const next = visible[Math.min(visible.length - 1, Math.max(0, at + d))];
		if (next && next.id !== noteId) go("note", next.id);
	};
	useHotkeys({
		"/": () => {
			searchRef.current?.focus();
			searchRef.current?.select();
		},
		j: () => step(1),
		k: () => step(-1),
		n: () => setCreating(true),
	});

	if (!notes.data || !scopes.data) {
		return (
			<div className="page">
				<LoadState error={notes.error ?? scopes.error} loading reload={notes.reload} />
			</div>
		);
	}

	const groups: Array<{ scope: ScopeInfo | undefined; id: string; notes: NoteView[] }> = [];
	if (scope === ALL) {
		for (const s of scopeList) {
			const list = live.filter((n) => n.scope === s.id);
			if (list.length) groups.push({ scope: s, id: s.id, notes: list });
		}
		const known = new Set(scopeList.map((s) => s.id));
		const rest = live.filter((n) => !known.has(n.scope));
		if (rest.length) groups.push({ scope: undefined, id: "?", notes: rest });
	} else groups.push({ scope: scopeInfo, id: scope, notes: live });

	const total = scopeList.reduce((n, s) => n + s.counts.active + s.counts.off, 0);

	return (
		<div className="memory">
			<nav className="pane pane-scopes" aria-label="Scopes">
				<a className={cls("scope-row", scope === ALL && "is-on")} href={href("memory")}>
					<span className="scope-name">All</span>
					<span className="count">{total}</span>
				</a>
				{scopeList.map((s) => (
					<a key={s.id} className={cls("scope-row", scope === s.id && "is-on")} href={href("memory", s.id)} title={s.key}>
						<span className="scope-name">{s.name}</span>
						{s.index.over > 0 ? (
							<span className="over-mark" title={`${plural(s.index.over, "note")} did not fit the index budget`}>
								!
							</span>
						) : null}
						<Meter value={s.index.tokens} max={s.budget} over={s.index.over > 0} />
						<span className="count">{s.counts.active + s.counts.off}</span>
					</a>
				))}
				<div className="legend">
					{(["always", "pointer", "none", "over", "off", "archived"] as const).map((r) => (
						<div key={r} title={REACH[r].hint}>
							<ReachMark reach={r} /> {REACH[r].label}
						</div>
					))}
				</div>
			</nav>

			<div className="pane pane-notes">
				<div className="pane-head">
					<div className="search">
						<input ref={searchRef} type="search" value={query} placeholder="Search title, text, id   /" onChange={(ev) => setQuery(ev.target.value)} onKeyDown={(ev) => ev.key === "Escape" && (query ? setQuery("") : ev.currentTarget.blur())} />
					</div>
					<Button small icon="plus" onClick={() => setCreating(true)} title="New note (n)">
						New note
					</Button>
				</div>
				<div className="note-list">
					{words.length ? (
						<div className="list-info">
							{plural(found.length, "match", "matches")} in {scope === ALL ? "all scopes" : (scopeInfo?.name ?? scope)}
							{elsewhere ? (
								<>
									{" · "}
									<a href={href("memory")}>{elsewhere} more in other scopes</a>
								</>
							) : null}
						</div>
					) : null}
					{groups.map((g) => (
						<div key={g.id} className="note-group">
							{scope === ALL ? (
								<a className="note-group-head" href={g.scope ? href("memory", g.scope.id) : undefined}>
									{g.scope?.name ?? "Unknown scope"} <span className="count">{g.notes.length}</span>
								</a>
							) : null}
							{g.notes.map((n) => (
								<NoteRow key={n.id} note={n} on={n.id === noteId} />
							))}
						</div>
					))}
					{!found.length ? <div className="list-info">{words.length ? "Nothing matches." : "No notes here yet."}</div> : null}
					{archived.length ? (
						<Fold title="Archived" count={archived.length} open={archivedOpen || words.length > 0 || archived.some((n) => n.id === noteId)} onToggle={setArchivedOpen}>
							{archived.map((n) => (
								<NoteRow key={n.id} note={n} on={n.id === noteId} />
							))}
						</Fold>
					) : null}
				</div>
			</div>

			<div className="pane pane-detail">
				{creating ? (
					<NewNote scopes={scopeList} scope={scope === ALL ? GLOBAL_SCOPE : scope} onClose={() => setCreating(false)} />
				) : noteId ? (
					<NoteDetail id={noteId} scopes={scopeList} notes={all} />
				) : scopeInfo ? (
					<ScopeOverview scope={scopeInfo} notes={all.filter((n) => n.scope === scopeInfo.id)} />
				) : (
					<AllOverview scopes={scopeList} />
				)}
			</div>
		</div>
	);
}

function NoteRow({ note: n, on }: { note: NoteView; on: boolean }) {
	const ref = useRef<HTMLAnchorElement>(null);
	useEffect(() => {
		if (on) ref.current?.scrollIntoView({ block: "nearest" });
	}, [on]);
	return (
		<a ref={ref} className={cls("note-row", on && "is-on", n.reach === "off" && "is-off", n.reach === "archived" && "is-archived")} href={href("note", n.id)}>
			<ReachMark reach={n.reach} />
			<span className="note-row-main">
				<span className="note-row-title">
					<TitleText text={n.title} />
				</span>
				<span className="note-row-sub">
					{n.type}
					{n.pinned ? " · pinned" : ""}
					{n.reach === "off" ? " · off" : ""}
					{n.status !== "active" ? ` · ${n.status === "deprecated" ? "closed" : n.status}` : ""}
				</span>
			</span>
		</a>
	);
}

function NewNote({ scopes, scope, onClose }: { scopes: ScopeInfo[]; scope: string; onClose: () => void }) {
	const { busy, run } = useBusy();
	return (
		<div className="detail">
			<h1 className="detail-title">New note</h1>
			<div className="detail-kicker">Written by hand: it becomes approved memory at once, as one commit.</div>
			<NoteForm
				initial={{ title: "", body: "", when: "", index: "pointer", type: "fact", scope }}
				scopes={scopes.map((s) => ({ id: s.id, name: s.name }))}
				submit="Create note"
				busy={busy === "create"}
				onCancel={onClose}
				onSubmit={(d) =>
					void run("create", () => api.createNote({ scope: d.scope, title: d.title.trim(), body: d.body.trim(), when: d.when.trim() || undefined, index: d.index, type: d.type }), "Note created").then((n) => {
						if (n) go("note", n.id);
					})
				}
			/>
		</div>
	);
}

// ── a scope ──────────────────────────────────────────────────────────────

function ScopeOverview({ scope, notes }: { scope: ScopeInfo; notes: NoteView[] }) {
	const prompts = useData(() => api.prompts(), ["prompts"]);
	const skills = useData(() => api.skills(), ["skills"]);
	const byId = new Map(notes.map((n) => [n.id, n]));
	const indexed = scope.index.ids.map((id) => byId.get(id)).filter((n): n is NoteView => !!n);
	const always = indexed.filter((n) => n.reach === "always");
	const pointer = indexed.filter((n) => n.reach === "pointer");
	const over = notes.filter((n) => n.reach === "over");
	const mine = (skills.data ?? []).filter((s) => s.scope === scope.id);
	return (
		<div className="detail">
			<h1 className="detail-title">{scope.name}</h1>
			<div className="chips">
				<Chip>{plural(scope.counts.active, "active note")}</Chip>
				{scope.counts.off ? <Chip tone="red">{scope.counts.off} off</Chip> : null}
				{scope.counts.archived ? <Chip tone="dim">{scope.counts.archived} archived</Chip> : null}
				{scope.id !== GLOBAL_SCOPE ? <span className="mono dim">{scope.key}</span> : <span className="dim">memory for every project</span>}
			</div>
			{scope.root ? <div className="detail-dates mono">{scope.root}</div> : null}

			<Charter scope={scope} prompts={prompts.data} />

			<section className="section">
				<h2>In every session{scope.id === GLOBAL_SCOPE ? "" : ` of ${scope.name}`}</h2>
				<div className="budget">
					<Meter value={scope.index.tokens} max={scope.budget} over={scope.index.over > 0} />
					<span>
						<b>{scope.index.tokens}</b> of {scope.budget} tokens
					</span>
					<span className="dim">· {plural(indexed.length, "note")} in the index</span>
					{scope.index.over ? <span className="text-yellow">· {scope.index.over} over budget</span> : null}
				</div>
				{!indexed.length && !over.length ? <div className="dim">Nothing from this scope is injected: its notes are found through search only.</div> : null}
				<IndexList title="Always in context" hint="the title is in the context" notes={always} />
				<IndexList title="When relevant" hint="a “when → id” line is in the context" notes={pointer} showWhen />
				<IndexList title="Over budget" hint="meant for the index, did not fit: search only until the budget grows or other notes leave" notes={over} tone="yellow" />
				<Fold title="The exact text a session gets">
					<InjectedText cwd={scope.root ?? "/"} global={scope.id === GLOBAL_SCOPE} />
				</Fold>
			</section>

			{mine.length ? (
				<section className="section">
					<h2>Skills</h2>
					{mine.map((s) => (
						<SkillRow key={s.name} skill={s} />
					))}
				</section>
			) : null}
		</div>
	);
}

function IndexList({ title, hint, notes, showWhen, tone }: { title: string; hint: string; notes: NoteView[]; showWhen?: boolean; tone?: string }) {
	if (!notes.length) return null;
	return (
		<div className="index-list">
			<div className={cls("index-list-head", tone && `text-${tone}`)}>
				{title} <span className="count">{notes.length}</span> <span className="dim">— {hint}</span>
			</div>
			{notes.map((n) => (
				<a key={n.id} className="index-row" href={href("note", n.id)}>
					<ReachMark reach={n.reach} />
					<span>
						{showWhen && n.when ? <span className="dim">{n.when} → </span> : null}
						<TitleText text={n.title} />
						{n.pinned ? <span className="dim"> · pinned</span> : null}
					</span>
				</a>
			))}
		</div>
	);
}

function InjectedText({ cwd, global }: { cwd: string; global: boolean }) {
	const ctx = useData(() => api.context(cwd), ["context", cwd]);
	if (!ctx.data) return <LoadState error={ctx.error} loading={ctx.loading} reload={ctx.reload} />;
	return (
		<>
			<div className="dim small">
				{global ? "The <memory> section of a session started outside any project with memory" : `The <memory> section of a session started in ${cwd} (Global first, then this project)`} — {ctx.data.injection.tokens} tokens.
			</div>
			<pre className="pre">{ctx.data.injection.text ?? "(nothing is injected)"}</pre>
		</>
	);
}

function Charter({ scope, prompts }: { scope: ScopeInfo; prompts: PromptsInfo | undefined }) {
	const [draft, setDraft] = useState<string | null>(null);
	const { busy, run } = useBusy();
	const fallback = prompts ? (scope.id === GLOBAL_SCOPE ? prompts.charters.global : (prompts.charters.projectOverride ?? prompts.charters.project)) : "";
	const text = scope.charter ?? fallback;
	// biome-ignore lint/correctness/useExhaustiveDependencies: another scope closes the editor
	useEffect(() => setDraft(null), [scope.id]);
	const save = (charter: string | null) =>
		run("charter", async () => {
			await api.setCharter(scope.id, charter);
			setDraft(null);
		}, charter === null ? "Back to the default purpose" : "Purpose saved");
	return (
		<section className="section">
			<h2>
				What this memory is for {scope.charter === null ? <Chip tone="dim">default</Chip> : <Chip tone="blue">custom</Chip>}
			</h2>
			{draft === null ? (
				<>
					<p className="charter">{text || "…"}</p>
					<div className="row-actions">
						<Button small icon="edit" onClick={() => setDraft(text)}>
							Edit
						</Button>
						{scope.charter !== null ? (
							<Button small busy={busy === "charter"} onClick={() => void save(null)}>
								Use the default
							</Button>
						) : null}
						<span className="dim small">The charter steers dreams: what belongs in this scope and what does not.</span>
					</div>
				</>
			) : (
				<>
					<AutoTextarea autoFocus minRows={3} value={draft} onChange={(ev) => setDraft(ev.target.value)} />
					<div className="row-actions">
						<Button small variant="primary" busy={busy === "charter"} disabled={!draft.trim() || draft.trim() === (scope.charter ?? "")} onClick={() => void save(draft.trim())}>
							Save
						</Button>
						<Button small onClick={() => setDraft(null)} disabled={!!busy}>
							Cancel
						</Button>
					</div>
				</>
			)}
		</section>
	);
}

function SkillRow({ skill: s }: { skill: SkillInfo }) {
	const { busy, run } = useBusy();
	const remove = async () => {
		const { ok } = await confirmDialog({ title: `Delete the skill ${s.name}?`, body: <p>pi stops loading it in sessions of this scope. History keeps it.</p>, confirm: "Delete", danger: true });
		if (ok) void run("delete", () => api.deleteSkill(s.scope, s.name), `Skill ${s.name} deleted`);
	};
	return (
		<Fold
			title={
				<>
					<code>{s.name}</code> <span className="dim">{s.description}</span>
				</>
			}
			right={
				<Button small variant="danger" busy={busy === "delete"} onClick={() => void remove()}>
					Delete
				</Button>
			}
		>
			<Markdown text={s.body} className="item-text" />
		</Fold>
	);
}

function AllOverview({ scopes }: { scopes: ScopeInfo[] }) {
	if (!scopes.length) return <Empty title="Memory is empty">Notes appear here once a dream’s proposals are accepted, or write one by hand with “New note”.</Empty>;
	return (
		<div className="detail">
			<h1 className="detail-title">Memory</h1>
			<p className="dim">Approved notes, by scope. Pick a note to read, edit or turn off; pick a scope to see what it puts into every session.</p>
			<table className="table">
				<thead>
					<tr>
						<th>Scope</th>
						<th className="num">Active</th>
						<th className="num">Off</th>
						<th className="num">Archived</th>
						<th>Index (tokens of budget)</th>
					</tr>
				</thead>
				<tbody>
					{scopes.map((s) => (
						<tr key={s.id}>
							<td>
								<a href={href("memory", s.id)}>{s.name}</a>
							</td>
							<td className="num">{s.counts.active}</td>
							<td className="num">{s.counts.off || ""}</td>
							<td className="num">{s.counts.archived || ""}</td>
							<td>
								<Meter value={s.index.tokens} max={s.budget} over={s.index.over > 0} /> {s.index.tokens} / {s.budget}
								{s.index.over ? (
									<span className="text-yellow">
										{" "}
										<Icon name="warn" size={12} /> {s.index.over} over
									</span>
								) : null}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
