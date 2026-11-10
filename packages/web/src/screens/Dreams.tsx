/**
 * Dreams: the background runs that read past sessions and propose changes to
 * memory — start one, watch it, see what past ones reported.
 */

import type { DreamStatus, ReportData, ReportItem, RunInfo, ScopeInfo, Stage } from "@wierd-memory/core";
import { useEffect, useRef, useState } from "react";
import { api, type DreamMode, type RunDetail } from "../api.ts";
import { EvidenceChips } from "../components/Evidence.tsx";
import { Markdown, TitleText } from "../components/Markdown.tsx";
import { go, href, useBusy, useData, useNow } from "../hooks.ts";
import { Button, Callout, Chip, confirmDialog, CopyButton, Empty, Field, Fold, LoadState, Spinner } from "../ui.tsx";
import { ago, cls, dueText, errorText, firstLine, fmtDateTime, INDEX_LABEL, kindInfo, money, plural, runDuration, scopeLabel, STAGES } from "../util.ts";

const STATUS_TONE: Record<RunInfo["status"], string> = { running: "blue", ok: "green", noop: "dim", error: "red", cancelled: "yellow" };
const STATUS_LABEL: Record<RunInfo["status"], string> = { running: "running", ok: "done", noop: "nothing to do", error: "failed", cancelled: "cancelled" };
const KIND_LABEL: Record<RunInfo["kind"], string> = { run: "dream", review: "review comments", dry: "dry run", reindex: "reindex" };

export function DreamsScreen({ arg }: { arg?: string }) {
	return arg ? <RunPage id={arg} /> : <DreamsHome />;
}

function StatusChip({ run }: { run: RunInfo }) {
	return (
		<Chip tone={STATUS_TONE[run.status]}>
			{run.status === "running" ? <Spinner size={10} /> : null}
			{STATUS_LABEL[run.status] ?? run.status}
		</Chip>
	);
}

// ── home ─────────────────────────────────────────────────────────────────

function DreamsHome() {
	const dreams = useData(() => api.dreams(60), ["dreams"]);
	const { busy, run } = useBusy();
	const [maxSessions, setMaxSessions] = useState("");
	const [sinceDays, setSinceDays] = useState("");
	const d = dreams.data;
	if (!d) {
		return (
			<div className="page">
				<LoadState error={dreams.error} loading={dreams.loading} reload={dreams.reload} />
			</div>
		);
	}

	const start = (mode: DreamMode, done: string) => {
		const opts: { sinceDays?: number; maxSessions?: number } = {};
		if (mode === "run" || mode === "dry") {
			const m = Number(maxSessions);
			const s = Number(sinceDays);
			if (maxSessions.trim() && Number.isFinite(m) && m > 0) opts.maxSessions = Math.round(m);
			if (sinceDays.trim() && Number.isFinite(s) && s > 0) opts.sinceDays = s;
		}
		return run(`start:${mode}`, () => api.startDream(mode, opts), done);
	};
	const toggleSchedule = () => run("schedule", () => api.saveConfig({ schedule: { ...d.schedule, enabled: !d.schedule.enabled } }), d.schedule.enabled ? "Schedule off: dreams start only by hand" : "Schedule on");
	const running = d.running;
	const due = dueText(d.due, d.schedule.enabled);

	return (
		<div className="page">
			<header className="page-head">
				<h1>Dreams</h1>
				<p className="dim">A dream reads the sessions since the last one, plus the inbox and review comments, and proposes changes to memory. Proposals wait in Review; nothing becomes memory by itself.</p>
			</header>

			{running ? <Running run={running} /> : <Resting status={d} />}

			<section className="section panel">
				<h2>Start</h2>
				<div className="form-row">
					<Field label="Max sessions" hint="this run only">
						<input type="number" min={1} value={maxSessions} onChange={(ev) => setMaxSessions(ev.target.value)} placeholder="default" />
					</Field>
					<Field label="Look back, days" hint="this run only">
						<input type="number" min={1} value={sinceDays} onChange={(ev) => setSinceDays(ev.target.value)} placeholder="since the last dream" />
					</Field>
					<div className="form-actions">
						<Button variant="primary" icon="moon" busy={busy === "start:run"} disabled={!!running || !!busy} onClick={() => void start("run", "A dream has started")}>
							Dream now
						</Button>
						<Button busy={busy === "start:dry"} disabled={!!running || !!busy} onClick={() => void start("dry", "A dry run has started")} title="Goes through the motions and reports what it would propose; writes nothing">
							Dry run
						</Button>
					</div>
				</div>
				<div className="row-actions">
					<Button busy={busy === "start:review"} disabled={!!running || !!busy} onClick={() => void start("review", "A dream is applying the review comments")} title="Only applies the comments left in Review; reads no new sessions">
						Apply review comments
					</Button>
					<Button busy={busy === "start:reindex"} disabled={!!running || !!busy} onClick={() => void start("reindex", "Rebuilding the search index")} title="Rebuilds the digests of past sessions that memory_search looks through; no model calls for notes">
						Rebuild search index
					</Button>
					{running ? <span className="dim">One dream runs at a time.</span> : null}
				</div>
			</section>

			<section className="section panel">
				<h2>Schedule</h2>
				<div className="toggle-row">
					<label className="switch">
						<input type="checkbox" checked={d.schedule.enabled} disabled={busy === "schedule"} onChange={() => void toggleSchedule()} />
						<span>Let the server start dreams on its own</span>
					</label>
					<span className="dim">
						at most every {d.schedule.minHoursBetween}h, once {plural(d.schedule.minNewSessions, "new session")} (or inbox {d.schedule.minNewSessions === 1 ? "item" : "items"}) piled up · <a href={href("settings")}>change</a>
					</span>
				</div>
				<p className={due.due ? "text-yellow" : "dim"}>{due.text}</p>
			</section>

			<section className="section">
				<h2>Runs</h2>
				{d.runs.length ? <RunTable runs={d.runs} /> : <Empty title="No dream has run yet" />}
			</section>
		</div>
	);
}

function Resting({ status: d }: { status: DreamStatus }) {
	const last = d.last;
	return (
		<section className="section panel">
			<h2>Now</h2>
			{last ? (
				<p>
					Idle. Last run: <a href={href("dreams", last.id)}>{KIND_LABEL[last.kind]}</a> {ago(last.finishedAt ?? last.startedAt)} <StatusChip run={last} /> {last.title ? <span className="dim">{last.title}</span> : null}
					{last.status === "error" && last.error ? <span className="text-red"> — {firstLine(last.error)}</span> : null}
				</p>
			) : (
				<p>Idle. No dream has run yet.</p>
			)}
		</section>
	);
}

function Running({ run: r }: { run: RunInfo }) {
	const now = useNow(true);
	const { busy, run } = useBusy();
	const cancel = async () => {
		const { ok } = await confirmDialog({ title: "Cancel the running dream?", body: <p>The process is stopped; what it already summarized is kept for the next dream, nothing is proposed from this one.</p>, confirm: "Cancel the dream", danger: true });
		if (ok) void run("cancel", () => api.cancelDream(r.id), "Cancelling…");
	};
	return (
		<section className="section panel is-running">
			<div className="panel-head">
				<h2>
					<Spinner /> {KIND_LABEL[r.kind]} running
				</h2>
				<span className="mono">{runDuration(r, now)}</span>
				<span className="dim">
					started {fmtDateTime(r.startedAt)}
					{r.trigger ? ` by ${r.trigger}` : ""}
				</span>
				<span className="spacer" />
				<a href={href("dreams", r.id)} className="mono">
					{r.id}
				</a>
				<Button small variant="danger" busy={busy === "cancel"} onClick={() => void cancel()}>
					Cancel
				</Button>
			</div>
			<RunLog id={r.id} live />
		</section>
	);
}

/** The tail of a run's log; polled every 3 s while the run is going. */
function RunLog({ id, live }: { id: string; live: boolean }) {
	const [text, setText] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const ref = useRef<HTMLPreElement>(null);
	const stick = useRef(true);
	useEffect(() => {
		let on = true;
		const load = () =>
			api.dreamLog(id, 200).then(
				(t) => {
					if (!on) return;
					setText(typeof t === "string" ? t : "");
					setError(null);
				},
				(err: unknown) => on && setError(errorText(err)),
			);
		void load();
		const timer = live ? setInterval(() => void load(), 3000) : undefined;
		return () => {
			on = false;
			if (timer) clearInterval(timer);
		};
	}, [id, live]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: follow the tail when the text grows
	useEffect(() => {
		const el = ref.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [text]);
	if (error && text === null) return <div className="dim">No log: {error}</div>;
	if (text === null) return <LoadState loading />;
	return (
		<pre
			ref={ref}
			className="pre log"
			onScroll={(ev) => {
				const el = ev.currentTarget;
				stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
			}}
		>
			{text.trimEnd() || "(the log is empty)"}
		</pre>
	);
}

function RunTable({ runs }: { runs: RunInfo[] }) {
	return (
		<table className="table table-rows">
			<thead>
				<tr>
					<th>Status</th>
					<th>Kind</th>
					<th>Started</th>
					<th className="num">Took</th>
					<th className="num">Sessions</th>
					<th className="num">Cost</th>
					<th>Result</th>
				</tr>
			</thead>
			<tbody>
				{runs.map((r) => (
					<tr key={r.id} className="is-link" onClick={() => go("dreams", r.id)}>
						<td>
							<StatusChip run={r} />
						</td>
						<td>
							{KIND_LABEL[r.kind] ?? r.kind}
							{r.trigger ? <span className="dim"> · {r.trigger}</span> : null}
						</td>
						<td className="nowrap" title={fmtDateTime(r.startedAt)}>
							<a href={href("dreams", r.id)} onClick={(ev) => ev.stopPropagation()}>
								{ago(r.startedAt)}
							</a>
						</td>
						<td className="num nowrap">{runDuration(r)}</td>
						<td className="num">{r.sessions ?? ""}</td>
						<td className="num">{r.cost ? money(r.cost) : ""}</td>
						<td className="wrap">{r.error ? <span className="text-red">{firstLine(r.error)}</span> : (r.title ?? "")}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

// ── one run ──────────────────────────────────────────────────────────────

function RunPage({ id }: { id: string }) {
	const run = useData(() => api.dream(id), ["dream", id]);
	const scopes = useData(() => api.scopes(), ["scopes"]);
	const actions = useBusy();
	const r = run.data;
	const now = useNow(r?.status === "running");
	if (!r) {
		return (
			<div className="page">
				<a className="back" href={href("dreams")}>
					← Dreams
				</a>
				<LoadState error={run.error} loading={run.loading} reload={run.reload} />
			</div>
		);
	}
	const cancel = async () => {
		const { ok } = await confirmDialog({ title: "Cancel the running dream?", confirm: "Cancel the dream", danger: true });
		if (ok) void actions.run("cancel", () => api.cancelDream(r.id), "Cancelling…");
	};
	return (
		<div className="page">
			<a className="back" href={href("dreams")}>
				← Dreams
			</a>
			<header className="page-head">
				<div className="page-title-row">
					<h1>{r.title ?? `${KIND_LABEL[r.kind]} ${r.id}`}</h1>
					<StatusChip run={r} />
					{r.status === "running" ? (
						<Button small variant="danger" busy={actions.busy === "cancel"} onClick={() => void cancel()}>
							Cancel
						</Button>
					) : null}
				</div>
				<div className="dim">
					{KIND_LABEL[r.kind]}
					{r.trigger ? ` · started by ${r.trigger}` : ""} · {fmtDateTime(r.startedAt)} · took {runDuration(r, now)}
					{r.sessions !== undefined ? ` · ${plural(r.sessions, "session")}` : ""}
					{r.cost ? ` · ${money(r.cost)}` : ""} · <span className="mono">{r.id}</span>
					{r.opts?.maxSessions ? ` · max ${r.opts.maxSessions} sessions` : ""}
					{r.opts?.sinceDays ? ` · ${r.opts.sinceDays} days back` : ""}
				</div>
				{r.kind !== "dry" && r.status === "ok" && ((r.report?.items?.length ?? 0) > 0 || (r.report?.agents?.length ?? 0) > 0) ? (
					<div>
						Its proposals went to <a href={href("review")}>Review</a>.
					</div>
				) : null}
				{r.error ? (
					<Callout tone="red" title="The dream failed">
						<pre className="pre-plain">{r.error}</pre>
					</Callout>
				) : null}
			</header>

			{r.report ? <Report report={r.report} scopes={scopes.data ?? []} /> : r.status !== "running" ? <div className="dim section">This run left no report.</div> : null}

			<Fold title="Log" defaultOpen={r.status === "running" || !r.report} className="section">
				<RunLog id={r.id} live={r.status === "running"} />
			</Fold>
		</div>
	);
}

function Report({ report: d, scopes }: { report: RunDetail["report"] & ReportData; scopes: ScopeInfo[] }) {
	const items = d.items ?? [];
	const byScope = new Map<string, ReportItem[]>();
	for (const it of items) byScope.set(it.scope, [...(byScope.get(it.scope) ?? []), it]);
	const usage = d.usage ?? {};
	const stages = STAGES.filter((s) => usage[s]);
	const total = stages.reduce((n, s) => n + (usage[s]?.cost ?? 0), 0);
	const scopeName = (id: string) => scopes.find((s) => s.id === id)?.name ?? scopeLabel(id);
	return (
		<>
			<div className="chips section">
				<Chip>{plural(d.sessions?.length ?? 0, "session")} read</Chip>
				<Chip>{plural(d.inbox ?? 0, "inbox item")}</Chip>
				<Chip>{plural(d.feedback ?? 0, "review comment")}</Chip>
				<Chip>{plural(d.votes ?? 0, "usefulness vote")}</Chip>
				<Chip>writes in {d.language}</Chip>
			</div>

			{d.problems?.length ? (
				<Callout tone="yellow" title="Problems">
					<ul className="plain-list">
						{d.problems.map((p) => (
							<li key={p}>{p}</li>
						))}
					</ul>
				</Callout>
			) : null}
			{d.unhandled?.length ? (
				<Callout tone="yellow" title="Review comments it could not apply">
					<ul className="plain-list">
						{d.unhandled.map((u) => (
							<li key={u.comment}>
								“{u.comment}” — {u.reason}
							</li>
						))}
					</ul>
				</Callout>
			) : null}

			<section className="section">
				<h2>
					What it proposed <span className="count">{items.length}</span>
				</h2>
				{!items.length ? <div className="dim">No changes to memory.</div> : null}
				{[...byScope.entries()].map(([scope, list]) => (
					<div key={scope} className="report-scope">
						<h3>
							{scopeName(scope)} <span className="count">{list.length}</span> {scope !== "global" ? <span className="dim mono scope-id">{d.scopeTitles?.[scope] ?? scope.replace(/^projects\//, "")}</span> : null}
						</h3>
						{list.map((it, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: report items may lack ids
							<ReportRow key={`${it.id ?? ""}:${i}`} item={it} titles={d.sessionTitles ?? {}} scopeName={scopeName} />
						))}
					</div>
				))}
			</section>

			{d.agents?.length ? (
				<section className="section">
					<h2>AGENTS.md proposals</h2>
					{d.agents.map((a) => (
						<div key={`${a.project}:${a.rel}`} className="report-item">
							<div className="report-item-head">
								<span className="kind-badge tone-blue">{a.rel}</span>
								<span className="report-title">
									{a.project}
									{a.title ? ` — ${a.title}` : ""}
								</span>
							</div>
							{a.error ? <div className="text-red">{a.error}</div> : null}
							{a.rationale.map((w) => (
								<div key={w} className="report-sub">
									why: {w}
								</div>
							))}
							{a.patch ? <pre className="pre">{a.patch}</pre> : null}
						</div>
					))}
				</section>
			) : null}

			{d.rejected?.length ? (
				<Fold title="Rejected by the fact check" count={d.rejected.length} className="section">
					<div className="rows">
						{d.rejected.map((x) => (
							<div key={x.ref} className="row row-top">
								<Chip tone="dim">{x.op}</Chip>
								<span className="row-main">
									<span>{x.title}</span>
									<span className="row-sub">{x.reason}</span>
								</span>
							</div>
						))}
					</div>
				</Fold>
			) : null}

			{d.sessions?.length ? (
				<Fold title="Sessions it read" count={d.sessions.length} className="section">
					<table className="table">
						<thead>
							<tr>
								<th>Date</th>
								<th>Project</th>
								<th>Session</th>
								<th>Outcome</th>
								<th className="num">Learnings</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{d.sessions.map((s) => (
								<tr key={s.sessionId}>
									<td className="nowrap">{s.date}</td>
									<td>{s.project}</td>
									<td className="wrap">{s.title}</td>
									<td>{s.outcome}</td>
									<td className="num">{s.learnings}</td>
									<td>
										<CopyButton text={`pi --session ${s.sessionId}`} label={<span className="mono">{s.sessionId.slice(0, 8)}</span>} title="Copy the command that reopens this session" />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</Fold>
			) : null}

			{stages.length ? (
				<section className="section">
					<h2>
						Cost <span className="count">{money(total)}</span>
					</h2>
					<table className="table">
						<thead>
							<tr>
								<th>Stage</th>
								<th>Model</th>
								<th className="num">Calls</th>
								<th className="num">Input</th>
								<th className="num">Cached</th>
								<th className="num">Output</th>
								<th className="num">Failures</th>
								<th className="num">Cost</th>
							</tr>
						</thead>
						<tbody>
							{stages.map((s: Stage) => {
								const u = usage[s];
								if (!u) return null;
								return (
									<tr key={s}>
										<td>{s === "analyze" ? "curator" : s === "verify" ? "fact check" : "session cards"}</td>
										<td className="mono">{d.models?.[s] ?? ""}</td>
										<td className="num">{u.calls}</td>
										<td className="num">{u.input.toLocaleString("en-US")}</td>
										<td className="num">{u.cacheRead.toLocaleString("en-US")}</td>
										<td className="num">{u.output.toLocaleString("en-US")}</td>
										<td className={cls("num", u.failures > 0 && "text-red")}>{u.failures || ""}</td>
										<td className="num">{money(u.cost)}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</section>
			) : null}

			{d.indexes?.length ? (
				<Fold title="Indexes after this dream" count={d.indexes.length} className="section">
					<table className="table">
						<thead>
							<tr>
								<th>Scope</th>
								<th className="num">Tokens</th>
								<th className="num">Budget</th>
								<th className="num">In the index</th>
								<th className="num">Over budget</th>
							</tr>
						</thead>
						<tbody>
							{d.indexes.map((x) => (
								<tr key={x.scope}>
									<td>{scopeName(x.scope)}</td>
									<td className="num">{x.tokens}</td>
									<td className="num">{x.budget}</td>
									<td className="num">{x.included.length}</td>
									<td className={cls("num", x.dropped.length > 0 && "text-yellow")}>{x.dropped.length || ""}</td>
								</tr>
							))}
						</tbody>
					</table>
				</Fold>
			) : null}
		</>
	);
}

function ReportRow({ item: it, titles, scopeName }: { item: ReportItem; titles: Record<string, string>; scopeName: (id: string) => string }) {
	const k = kindInfo(it.kind);
	const [open, setOpen] = useState(false);
	return (
		<div className="report-item">
			<button type="button" className="report-item-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				<span className={cls("kind-badge", `tone-${k.tone}`)}>
					<span className="kind-glyph">{k.glyph}</span>
					{k.label}
				</span>
				<span className="report-title">
					<TitleText text={it.title} />
				</span>
				{it.index && it.index !== "none" ? <span className={cls("reach-chip", `reach-${it.index}`)}>{INDEX_LABEL[it.index]}</span> : null}
				{it.id ? <span className="mono dim">{it.id}</span> : null}
			</button>
			{it.old ? (
				<div className="report-sub">
					was: {it.old.title} {it.old.id ? <span className="mono">{it.old.id}</span> : null}
				</div>
			) : null}
			{it.from ? (
				<div className="report-sub">
					moved from {scopeName(it.from)} to {scopeName(it.scope)}
				</div>
			) : null}
			{it.why.map((w) => (
				<div key={w} className="report-sub">
					why: {w}
				</div>
			))}
			{it.check && (it.check.verdict !== "supported" || it.check.corrected) ? (
				<div className="report-sub text-yellow">
					fact check: {it.check.verdict}
					{it.check.corrected ? " (corrected)" : ""}
					{it.check.reason ? ` — ${it.check.reason}` : ""}
				</div>
			) : null}
			{it.risky?.map((x) => (
				<div key={x} className="report-sub text-red">
					risky: {x}
				</div>
			))}
			{it.newerEvidence?.length ? <div className="report-sub text-yellow">the old note has evidence newer than this change</div> : null}
			{it.note ? <div className="report-sub">{it.note}</div> : null}
			{open ? (
				<div className="report-open">
					{it.when ? (
						<div className="when">
							<span className="when-label">when</span> {it.when}
						</div>
					) : null}
					{it.body ? <Markdown text={it.body} className="item-text" /> : null}
					<EvidenceChips evidence={it.evidence ?? []} titles={titles} />
					{it.id ? (
						<div className="small">
							<a href={href("note", it.id)}>Open {it.id} in memory</a> <span className="dim">(if it was accepted)</span>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
