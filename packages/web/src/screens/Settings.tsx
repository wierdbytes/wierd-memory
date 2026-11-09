/**
 * Settings: the server's config, the prompts dreams run with, and where the
 * data lives.
 */

import type { Stage, ThinkingLevel, WmemConfig } from "@wierd-mem/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { useBusy, useData, useStatus } from "../hooks.ts";
import { AutoTextarea, Button, Callout, Chip, confirmDialog, CopyButton, Field, Fold, LoadState } from "../ui.tsx";
import { ago, sameJson, STAGES, THINKING_LEVELS } from "../util.ts";

type Section = keyof WmemConfig;
const SECTIONS: readonly Section[] = ["language", "inject", "agentsMd", "budgets", "models", "schedule", "dream", "remote"];
const STAGE_LABEL: Record<Stage, { name: string; hint: string }> = {
	cards: { name: "Session cards", hint: "summarizes each session — many calls, a fast model" },
	analyze: { name: "Curator", hint: "decides what changes in memory — one long call, the strongest model" },
	verify: { name: "Fact check", hint: "tests each proposal against the cited lines — best from another vendor" },
};

export function SettingsScreen() {
	const config = useData(() => api.config(), ["config"]);
	const status = useStatus();
	const [base, setBase] = useState<WmemConfig | null>(null);
	const [draft, setDraft] = useState<WmemConfig | null>(null);
	const { busy, run } = useBusy();

	// Take the server's config; sections the user has touched keep the draft.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a new answer from the server merges
	useEffect(() => {
		const next = config.data;
		if (!next) return;
		if (!draft || !base) {
			setBase(next);
			setDraft(next);
			return;
		}
		const merged = { ...next } as Record<Section, unknown>;
		for (const k of SECTIONS) if (!sameJson(draft[k], base[k])) merged[k] = draft[k];
		setBase(next);
		setDraft(merged as unknown as WmemConfig);
	}, [config.data]);

	if (!draft || !base) {
		return (
			<div className="page">
				<LoadState error={config.error} loading={config.loading} reload={config.reload} />
			</div>
		);
	}

	const dirty = SECTIONS.filter((k) => !sameJson(draft[k], base[k]));
	const set = <K extends Section>(k: K, v: WmemConfig[K]) => setDraft({ ...draft, [k]: v });
	const save = () =>
		run("save", async () => {
			const patch: Partial<Record<Section, unknown>> = {};
			for (const k of dirty) patch[k] = draft[k];
			const saved = await api.saveConfig(patch as Partial<WmemConfig>);
			setBase(saved);
			setDraft(saved);
			config.set(saved);
		}, "Settings saved");
	const push = () => run("push", () => api.push(), (r) => r.message || "Pushed");
	const remoteSaved = base.remote.url.trim().length > 0 && sameJson(base.remote, draft.remote);

	return (
		<div className="page settings">
			<header className="page-head">
				<h1>Settings</h1>
			</header>

			<Group title="Memory in sessions">
				<Check label="Inject the memory index into sessions" hint="Off: agents get no notes in their context (search still works)." checked={draft.inject} onChange={(v) => set("inject", v)} />
				<div className="form-row">
					<Num label="Global index budget, tokens" hint="the Global index goes into every session" value={draft.budgets.globalTokens} min={0} onChange={(v) => set("budgets", { ...draft.budgets, globalTokens: v })} />
					<Num label="Project index budget, tokens" hint="a project's index goes into its sessions" value={draft.budgets.projectTokens} min={0} onChange={(v) => set("budgets", { ...draft.budgets, projectTokens: v })} />
				</div>
			</Group>

			<Group title="Dreams">
				<div className="form-row">
					<Field label="Language of notes" hint="dreams write titles and text in it">
						<input type="text" value={draft.language} onChange={(ev) => set("language", ev.target.value)} />
					</Field>
				</div>
				<Check label="Let dreams propose AGENTS.md / CLAUDE.md edits" hint="Reviewed like notes; applied to the working copy only when you say so." checked={draft.agentsMd} onChange={(v) => set("agentsMd", v)} />
				<h3>Models</h3>
				{STAGES.map((s) => (
					<div key={s} className="form-row model-row">
						<Field label={STAGE_LABEL[s].name} hint={STAGE_LABEL[s].hint}>
							<input type="text" className="mono" value={draft.models[s].model} placeholder="provider/model-id" onChange={(ev) => set("models", { ...draft.models, [s]: { ...draft.models[s], model: ev.target.value } })} />
						</Field>
						<Field label="Thinking">
							<select value={draft.models[s].thinking} onChange={(ev) => set("models", { ...draft.models, [s]: { ...draft.models[s], thinking: ev.target.value as ThinkingLevel } })}>
								{THINKING_LEVELS.map((t) => (
									<option key={t} value={t}>
										{t}
									</option>
								))}
							</select>
						</Field>
					</div>
				))}
				{STAGES.some((s) => !draft.models[s].model.includes("/")) ? <div className="form-error">A model id is “provider/model-id”; one without “/” is replaced by the default on save.</div> : null}

				<h3>Schedule</h3>
				<Check label="Let the server start dreams on its own" checked={draft.schedule.enabled} onChange={(v) => set("schedule", { ...draft.schedule, enabled: v })} />
				<div className="form-row">
					<Num label="At most every, hours" value={draft.schedule.minHoursBetween} min={0} onChange={(v) => set("schedule", { ...draft.schedule, minHoursBetween: v })} />
					<Num label="New sessions needed" hint="or inbox items, before a dream is due" value={draft.schedule.minNewSessions} min={1} onChange={(v) => set("schedule", { ...draft.schedule, minNewSessions: v })} />
				</div>

				<h3>Limits</h3>
				<div className="form-row">
					<Num label="Sessions per dream" hint="the rest wait for the next one" value={draft.dream.maxSessionsPerRun} min={1} onChange={(v) => set("dream", { ...draft.dream, maxSessionsPerRun: v })} />
					<Num label="First dream looks back, days" value={draft.dream.firstRunLookbackDays} min={0} onChange={(v) => set("dream", { ...draft.dream, firstRunLookbackDays: v })} />
					<Num label="Session idle for, minutes" hint="younger ones are still in use" value={draft.dream.minIdleMinutes} min={0} onChange={(v) => set("dream", { ...draft.dream, minIdleMinutes: v })} />
				</div>
				<div className="form-row">
					<Num label="Parallel card calls" value={draft.dream.concurrency} min={1} max={16} onChange={(v) => set("dream", { ...draft.dream, concurrency: v })} />
					<Num label="Max runtime, minutes" value={draft.dream.maxRuntimeMinutes} min={5} onChange={(v) => set("dream", { ...draft.dream, maxRuntimeMinutes: v })} />
					<Field label="pi executable" hint="pi from PATH by default">
						<input type="text" className="mono" value={draft.dream.piCommand} onChange={(ev) => set("dream", { ...draft.dream, piCommand: ev.target.value })} />
					</Field>
				</div>
				<Field label="Extensions for the dreaming pi" hint="One per line. The headless pi runs with --no-extensions; list provider / auth extensions here (npm:<name> resolves to pi's installed copy)." wide>
					<AutoTextarea
						className="mono"
						minRows={2}
						value={draft.dream.childExtensions.join("\n")}
						onChange={(ev) => set("dream", { ...draft.dream, childExtensions: ev.target.value.split("\n").map((x) => x.trimStart()) })}
						onBlur={() => set("dream", { ...draft.dream, childExtensions: draft.dream.childExtensions.map((x) => x.trim()).filter(Boolean) })}
					/>
				</Field>
			</Group>

			<Group title="Remote (backup / sync)">
				<Field label="Dolt remote URL" hint="e.g. file:///Volumes/backup/wmem or https://doltremoteapi.dolthub.com/<org>/<repo>; empty: none" wide>
					<input type="text" className="mono" value={draft.remote.url} onChange={(ev) => set("remote", { ...draft.remote, url: ev.target.value })} placeholder="none" />
				</Field>
				<Check label="Push after every change to approved memory" checked={draft.remote.autoPush} onChange={(v) => set("remote", { ...draft.remote, autoPush: v })} />
				<div className="row-actions">
					<Button busy={busy === "push"} disabled={!remoteSaved || !!busy} onClick={() => void push()}>
						Push now
					</Button>
					{!base.remote.url ? <span className="dim">Set a remote URL and save first.</span> : !remoteSaved ? <span className="dim">Save the remote settings first.</span> : null}
					{status?.remote.lastPush ? <span className="dim">last push {ago(status.remote.lastPush)}</span> : null}
				</div>
				{status?.remote.error ? (
					<Callout tone="red" title="The last push failed">
						{status.remote.error}
					</Callout>
				) : null}
			</Group>

			{dirty.length ? (
				<div className="save-bar">
					<span>Unsaved: {dirty.join(", ")}</span>
					<span className="spacer" />
					<Button onClick={() => setDraft(base)} disabled={!!busy}>
						Discard
					</Button>
					<Button variant="primary" busy={busy === "save"} onClick={() => void save()}>
						Save settings
					</Button>
				</div>
			) : null}

			<Prompts />

			<Group title="This server">
				{status ? (
					<dl className="kv">
						<dt>Version</dt>
						<dd>wierd-mem {status.version}</dd>
						<dt>Home</dt>
						<dd className="mono">{status.home}</dd>
						<dt>URL</dt>
						<dd>
							<span className="mono">{status.url}</span> <span className="dim">— the ports are set in config.json (or WMEM_PORT / WMEM_DOLT_PORT) and apply after a restart</span>
						</dd>
						<dt>Dolt</dt>
						<dd>
							<span className="mono">{status.dolt.version}</span> on port <span className="mono">{status.dolt.port}</span>, database <span className="mono">{status.dolt.database}</span>
						</dd>
						<dt>SQL access</dt>
						<dd>
							<CopyButton text={`mysql -h127.0.0.1 -P${status.dolt.port} -uroot ${status.dolt.database}`} label={<code>{`mysql -h127.0.0.1 -P${status.dolt.port} -uroot ${status.dolt.database}`}</code>} />
						</dd>
						<dt>Memory version</dt>
						<dd className="mono">{status.memver}</dd>
					</dl>
				) : (
					<LoadState loading />
				)}
			</Group>
		</div>
	);
}

function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="section panel settings-group">
			<h2>{title}</h2>
			{children}
		</section>
	);
}

function Check({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
	return (
		<div className="toggle-row">
			<label className="switch">
				<input type="checkbox" checked={checked} onChange={(ev) => onChange(ev.target.checked)} />
				<span>{label}</span>
			</label>
			{hint ? <span className="dim">{hint}</span> : null}
		</div>
	);
}

/** A number field that can be empty while it is typed in. */
function Num({ label, hint, value, min, max, onChange }: { label: string; hint?: string; value: number; min?: number; max?: number; onChange: (v: number) => void }) {
	const [text, setText] = useState(String(value));
	const last = useRef(value);
	if (last.current !== value) {
		last.current = value;
		if (Number(text) !== value) setText(String(value));
	}
	return (
		<Field label={label} hint={hint}>
			<input
				type="number"
				value={text}
				min={min}
				max={max}
				onChange={(ev) => {
					setText(ev.target.value);
					const n = Number(ev.target.value);
					if (ev.target.value.trim() && Number.isFinite(n)) {
						last.current = n;
						onChange(n);
					}
				}}
				onBlur={() => setText(String(value))}
			/>
		</Field>
	);
}

// ── prompts ──────────────────────────────────────────────────────────────

const PROMPT_INFO: Record<string, { label: string; hint: string }> = {
	cards: { label: "Session cards", hint: "Summarizes one session into a card: what happened and what is worth remembering." },
	curator: { label: "Curator", hint: "Turns the cards, the inbox and the current notes into proposed changes." },
	review: { label: "Review comments", hint: "Applies the comments you leave in a review." },
	verify: { label: "Fact check", hint: "Tests every proposed change against the session lines it cites." },
	project_charter: { label: "Default purpose of project memory", hint: "The charter of every project scope that has none of its own (a scope's own charter is edited in Memory)." },
};

function Prompts() {
	const prompts = useData(() => api.prompts(), ["prompts"]);
	const p = prompts.data;
	return (
		<section className="section panel settings-group">
			<h2>Prompts</h2>
			<p className="dim">The built-in text each dream stage runs with. An override replaces it whole; “reset” goes back to the built-in text (which follows new versions of wierd-mem).</p>
			{!p ? (
				<LoadState error={prompts.error} loading={prompts.loading} reload={prompts.reload} />
			) : (
				<>
					{p.prompts.map((x) => (
						<PromptEditor key={x.name} name={x.name} builtin={x.default} override={x.override} onSaved={prompts.reload} />
					))}
					<PromptEditor name="project_charter" builtin={p.charters.project} override={p.charters.projectOverride} onSaved={prompts.reload} />
				</>
			)}
		</section>
	);
}

function PromptEditor({ name, builtin, override, onSaved }: { name: string; builtin: string; override: string | null; onSaved: () => void }) {
	const [draft, setDraft] = useState<string | null>(null);
	const { busy, run } = useBusy();
	const info = PROMPT_INFO[name] ?? { label: name, hint: "" };
	const save = (body: string | null) =>
		run("save", async () => {
			await api.setPrompt(name, body);
			setDraft(null);
			onSaved();
		}, body === null ? `${info.label}: back to the built-in text` : `${info.label}: override saved`);
	const reset = async () => {
		const { ok } = await confirmDialog({ title: `Reset “${info.label}” to the built-in text?`, body: <p>Your override is removed (the History screen still has the commit that set it).</p>, confirm: "Reset to default", danger: true });
		if (ok) void save(null);
	};
	return (
		<Fold
			className="prompt"
			title={
				<>
					{info.label} <span className="mono dim">{name}</span>
				</>
			}
			right={override !== null ? <Chip tone="blue">overridden</Chip> : <Chip tone="dim">built-in</Chip>}
		>
			<p className="dim">{info.hint}</p>
			{draft === null ? (
				<>
					<div className="row-actions">
						<Button small icon="edit" onClick={() => setDraft(override ?? builtin)}>
							{override !== null ? "Edit the override" : "Override…"}
						</Button>
						{override !== null ? (
							<Button small variant="danger" busy={busy === "save"} onClick={() => void reset()}>
								Reset to default
							</Button>
						) : null}
					</div>
					{override !== null ? (
						<>
							<div className="label">Your override (in use)</div>
							<pre className="pre prompt-text">{override}</pre>
							<Fold title="The built-in text">
								<pre className="pre prompt-text">{builtin}</pre>
							</Fold>
						</>
					) : (
						<>
							<div className="label">The built-in text (in use)</div>
							<pre className="pre prompt-text">{builtin}</pre>
						</>
					)}
				</>
			) : (
				<>
					<AutoTextarea className="mono" minRows={8} maxHeight={640} value={draft} onChange={(ev) => setDraft(ev.target.value)} />
					<div className="row-actions">
						<Button small variant="primary" busy={busy === "save"} disabled={!draft.trim() || draft === (override ?? "")} onClick={() => void save(draft)}>
							Save override
						</Button>
						<Button small onClick={() => setDraft(builtin)} disabled={!!busy || draft === builtin}>
							Start again from the built-in text
						</Button>
						<Button small onClick={() => setDraft(null)} disabled={!!busy}>
							Cancel
						</Button>
					</div>
				</>
			)}
		</Fold>
	);
}
