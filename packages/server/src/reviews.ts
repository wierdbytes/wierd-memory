/**
 * The review: what dreams propose waits here until a person decides.
 *
 * There is one branch for it, `dreams` (`memory.reviewBranch`), checked out as
 * a worktree. It holds approved memory plus everything still proposed; dreams
 * add to it whenever they run, and it never opens, closes or goes away. The
 * items are the difference between the approved branch and it, note by note
 * (`diffNotes`) — so the list always shows exactly what accepting would
 * change, whoever made the change: a dream, a review comment a dream applied,
 * or the reviewer's edit.
 *
 * Any subset of the items can be decided at any time:
 *   accept          the branch's files are copied to the approved branch (one commit)
 *   edit and accept the reviewer's text goes to the dreams branch first, then as above
 *   reject          the approved branch's files are copied back to the dreams branch
 * Either way the item's notes become equal on both sides and it leaves the
 * list; what is left stays until decided. Every decision goes to
 * `decisions.jsonl`. `ReviewItem.version` lets a client make sure it decides
 * what it showed.
 *
 * The approved branch changes too (hand edits, accepted items, a pull).
 * `sync` merges it into the dreams branch — a real merge commit, whose
 * content is worked out note by note and column by column (`rebaseNotes`)
 * rather than line by line. The dreams branch is thus always "approved +
 * what is still proposed", locally and in `git diff` or on GitHub
 * (`<approved>...dreams`).
 *
 * `review.json` keeps the dreams whose proposals are still pending (their
 * reports say why an item is proposed), comments for dreams and AGENTS.md
 * proposals.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentsProposal,
	applyEdits,
	buildIndex,
	countsLabel,
	diffKey,
	diffNotes,
	type DreamSubmit,
	type DreamSubmitResult,
	findRisky,
	GLOBAL_SCOPE,
	INDEX_MODES,
	isoMinute,
	type ItemKind,
	keyOfScope,
	mergeNote,
	type Note,
	NOTE_TYPES,
	type NoteDiff,
	type NoteEdit,
	oneOf,
	type Reach,
	rebaseNotes,
	type ReportData,
	type ReportItem,
	type ReviewAccept,
	type ReviewDecision,
	type ReviewItem,
	type ReviewPick,
	type ReviewReject,
	type ReviewSummary,
	type ReviewView,
	runTitle,
	sameNote,
	today,
} from "@wierd-memory/core";
import { type App, bad, DREAM_AUTHOR, HttpError, notFound, scopeShortName, SYSTEM_AUTHOR } from "./app.ts";
import { MAIN } from "./git.ts";
import type { ScopeRow, SkillRow } from "./memory.ts";
import { renderNote } from "./notefile.ts";

const DAY = 86_400_000;
/** How long decided AGENTS.md proposals and applied comments stay in the view. */
const KEEP_SHOWING = 14 * DAY;
const KIND_ORDER: ItemKind[] = ["added", "superseded", "updated", "moved", "deprecated", "removed", "skill", "confirmed"];
const INDEX_ORDER: Record<string, number> = { always: 0, pointer: 1, none: 2 };
/** The note stays in memory after this change, so its text matters. */
const lives = (k: ItemKind) => k === "added" || k === "updated" || k === "moved" || k === "superseded";

const skillKey = (s: { scope: string; name: string }) => `skill:${s.scope}/${s.name}`;
const sameSkill = (a?: SkillRow, b?: SkillRow) => (!a || !b ? a === b : a.description === b.description && a.body.trim() === b.body.trim());
const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 12);
const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

interface SkillDiff {
	key: string;
	main?: SkillRow;
	branch?: SkillRow;
}

interface Computed {
	main: Note[];
	branch: Note[];
	mainById: Map<string, Note>;
	branchById: Map<string, Note>;
	diffs: NoteDiff[];
	/** Skills that differ: the branch's version, or the main one when the branch dropped it. */
	skillDiffs: SkillDiff[];
}

export class Reviews {
	constructor(private app: App) {}

	/** The branch dreams write to. */
	get branch(): string {
		return this.app.reviewBranch;
	}

	// ── keeping the branch in step with main ─────────────────────────────

	/** Merge what the approved branch changed since the dreams branch last saw it into the dreams branch. */
	async sync(): Promise<void> {
		const { repo, mem, state } = this.app;
		const branch = this.branch;
		const head = await repo.head(MAIN);
		const known = await state.baseCommit();
		if (known === head) return;
		// No record (a fresh `.local`): the branches' common ancestor is what the dreams branch last took in.
		const baseCommit = known ?? (await repo.mergeBase(MAIN, branch));
		if (baseCommit === head) return void (await state.setBaseCommit(head));
		const base = baseCommit ? await mem.notesAt(baseCommit) : await mem.notes(MAIN);
		const [main, current] = await Promise.all([mem.notes(MAIN), mem.notes(branch)]);
		const rb = rebaseNotes(base, main, current);
		const [skillsBase, skillsMain, skillsBranch] = await Promise.all([baseCommit ? mem.skillsAt(baseCommit) : mem.skills(MAIN), mem.skills(MAIN), mem.skills(branch)]);
		// The merge keeps the dreams branch's files; what it should take from the approved branch is written below.
		await repo.beginMerge(branch, head);
		await mem.takeShared(branch, head);
		await mem.upsert(branch, rb.upsert, { like: MAIN });
		await mem.remove(branch, rb.remove);
		await mem.copyFiles(branch, MAIN);
		// Skills: whole files. One that nothing proposes a change to follows the approved branch.
		const by = (list: SkillRow[]) => new Map(list.map((s) => [skillKey(s), s]));
		const [sb, sm, sbr] = [by(skillsBase), by(skillsMain), by(skillsBranch)];
		for (const key of new Set([...sb.keys(), ...sm.keys()])) {
			if (sameSkill(sb.get(key), sm.get(key)) && sb.has(key) === sm.has(key)) continue;
			const cur = sbr.get(key);
			const touched = sb.has(key) !== sbr.has(key) || !sameSkill(sb.get(key), cur);
			if (touched) continue;
			const next = sm.get(key);
			if (next) await mem.upsertSkill(branch, next);
			else if (cur) await mem.removeSkill(branch, cur.scope, cur.name);
		}
		await repo.commit(branch, `in step with ${repo.branch} ${head.slice(0, 8)}`, SYSTEM_AUTHOR);
		await state.setBaseCommit(head);
		await this.pruneRuns();
		this.app.pushSoon();
	}

	// ── what waits for a decision ────────────────────────────────────────

	private async compute(): Promise<Computed> {
		const { mem } = this.app;
		const [main, branch, skillsMain, skillsBranch] = await Promise.all([this.app.notes(MAIN), this.app.notes(this.branch), mem.skills(MAIN), mem.skills(this.branch)]);
		const sm = new Map(skillsMain.map((s) => [skillKey(s), s]));
		const sb = new Map(skillsBranch.map((s) => [skillKey(s), s]));
		const skillDiffs: SkillDiff[] = [];
		for (const key of new Set([...sm.keys(), ...sb.keys()])) {
			if (sm.has(key) && sb.has(key) && sameSkill(sm.get(key), sb.get(key))) continue;
			skillDiffs.push({ key, main: sm.get(key), branch: sb.get(key) });
		}
		return { main, branch, mainById: new Map(main.map((n) => [n.id, n])), branchById: new Map(branch.map((n) => [n.id, n])), diffs: diffNotes(main, branch), skillDiffs };
	}

	/** What deciding a note item would change: every note it covers, on both branches (the file's canonical form). */
	private noteVersion(c: Computed, ids: readonly string[]): string {
		const at = (n: Note | undefined) => (n ? renderNote(n) : null);
		return hash([...ids].sort().map((id) => [id, at(c.branchById.get(id)), at(c.mainById.get(id))]));
	}

	private skillVersion(s: SkillDiff): string {
		const at = (x?: SkillRow) => (x ? { description: x.description, body: x.body.trim() } : null);
		return hash([s.key, at(s.branch), at(s.main)]);
	}

	private versions(c: Computed): Map<string, { version: string; title: string }> {
		const out = new Map<string, { version: string; title: string }>();
		for (const d of c.diffs) out.set(diffKey(d), { version: this.noteVersion(c, d.ids), title: d.note.title });
		for (const s of c.skillDiffs) {
			const cur = s.branch ?? s.main;
			out.set(s.key, { version: this.skillVersion(s), title: cur ? `${cur.name}: ${cur.description}` : s.key });
		}
		return out;
	}

	/** Refuse when an item the client showed changed or is gone since (nothing is decided then). */
	private checkVersions(c: Computed, versions: ReviewPick["versions"]): void {
		if (!versions || typeof versions !== "object") return;
		const now = this.versions(c);
		for (const [key, v] of Object.entries(versions)) {
			const cur = now.get(key);
			if (!cur) throw new HttpError(409, `${key} was decided or withdrawn since you looked`);
			if (cur.version !== v) throw new HttpError(409, `«${clip(cur.title)}» changed since you looked — reload`);
		}
	}

	/** The items a decision is about. */
	private pick(c: Computed, pick: ReviewPick): { diffs: NoteDiff[]; skills: SkillDiff[] } {
		const keys = Array.isArray(pick.keys) ? pick.keys.filter((k): k is string => typeof k === "string" && !!k) : [];
		if (pick.all !== true && !keys.length) throw bad("say which items: keys, or all: true");
		const wanted = pick.all === true ? undefined : new Set(keys);
		const diffs = c.diffs.filter((d) => !wanted || wanted.has(diffKey(d)));
		const skills = c.skillDiffs.filter((s) => !wanted || wanted.has(s.key));
		if (wanted && !diffs.length && !skills.length) throw notFound("such item to decide (decided already?)");
		return { diffs, skills };
	}

	/** Keep only the dreams something of which still waits: an item their reports explain, or an AGENTS.md proposal. */
	private async pruneRuns(c?: Computed): Promise<void> {
		const { state } = this.app;
		const runs = await state.reviewRuns();
		if (!runs.length) return;
		const cc = c ?? (await this.compute());
		const ids = new Set(cc.diffs.flatMap((d) => d.ids));
		const skills = new Set(cc.skillDiffs.map((s) => s.key));
		const keep = new Set((await state.agentsProposals({ status: "pending" })).map((a) => a.runId));
		for (const rep of await state.runReports(runs)) {
			const pending = rep.items.some((it) => (it.id && ids.has(it.id)) || (it.old?.id && ids.has(it.old.id)) || (it.kind === "skill" && skills.has(`skill:${it.scope}/${it.title.split(":")[0]}`)));
			if (pending) keep.add(rep.runId);
		}
		await state.setReviewRuns(runs.filter((r) => keep.has(r)));
	}

	private scopeNames(scopes: readonly ScopeRow[], ids: Iterable<string>, reports: readonly ReportData[]): Record<string, string> {
		const out: Record<string, string> = {};
		for (const s of scopes) out[s.id] = this.app.scopeName(s.id, scopes);
		for (const id of ids) {
			if (out[id]) continue;
			const key = reports.map((rep) => rep.scopeTitles?.[id]).find(Boolean) ?? keyOfScope(id) ?? id;
			out[id] = id === GLOBAL_SCOPE ? "Global" : scopeShortName(key);
		}
		return out;
	}

	private items(c: Computed, reports: readonly ReportData[], names: Record<string, string>): ReviewItem[] {
		// What each dream said about a note, oldest first.
		const said = new Map<string, Array<{ run: string; it: ReportItem }>>();
		for (const rep of reports)
			for (const it of rep.items)
				for (const id of new Set([it.id, it.old?.id])) {
					if (!id) continue;
					const list = said.get(id) ?? [];
					list.push({ run: rep.runId, it });
					said.set(id, list);
				}
		// How each proposed note would reach agents once accepted.
		const reach = new Map<string, Reach>();
		const byScope = new Map<string, Note[]>();
		for (const n of c.branch) {
			const list = byScope.get(n.scope) ?? [];
			list.push(n);
			byScope.set(n.scope, list);
		}
		for (const [scope, list] of byScope) for (const [id, how] of this.app.reachOf(scope, list)) reach.set(id, how);

		const items: ReviewItem[] = c.diffs.map((d) => {
			const n = d.note;
			const recs = [...(said.get(n.id) ?? []), ...(d.kind === "superseded" && d.before ? (said.get(d.before.id) ?? []) : [])];
			const its = recs.map((x) => x.it);
			const remarks = [...new Set(its.map((x) => x.note).filter((x): x is string => !!x))];
			const kind: ItemKind = d.kind;
			return {
				key: diffKey(d),
				kind,
				ids: d.ids,
				scope: n.scope,
				scopeName: names[n.scope] ?? n.scope,
				from: d.kind === "moved" ? d.before?.scope : undefined,
				fromName: d.kind === "moved" && d.before ? (names[d.before.scope] ?? d.before.scope) : undefined,
				note: n,
				before: d.before,
				fields: d.fields,
				reach: d.kind === "removed" ? "archived" : (reach.get(n.id) ?? "none"),
				evidence: d.evidence,
				why: [...new Set(its.flatMap((x) => x.why).map((w) => w.trim()).filter(Boolean))],
				check: its.findLast((x) => x.check)?.check,
				reviewer: its.some((x) => x.reviewer) || undefined,
				risky: lives(kind) ? findRisky(`${n.title}\n${n.body}`) : [],
				newerEvidence: d.kind === "superseded" || d.kind === "deprecated" ? its.findLast((x) => x.newerEvidence?.length)?.newerEvidence : undefined,
				remark: remarks.join(" · ") || undefined,
				runs: [...new Set(recs.map((x) => x.run))],
				version: this.noteVersion(c, d.ids),
				editable: lives(kind),
			};
		});
		for (const s of c.skillDiffs) {
			const cur = s.branch ?? s.main;
			if (!cur) continue;
			const rec = reports.flatMap((rep) => rep.items.filter((it) => it.kind === "skill" && it.scope === cur.scope && it.title.split(":")[0] === cur.name).map((it) => ({ run: rep.runId, it })));
			items.push({
				key: s.key,
				kind: s.branch ? "skill" : "removed",
				ids: [],
				scope: cur.scope,
				scopeName: names[cur.scope] ?? cur.scope,
				note: { id: "", scope: cur.scope, title: `${cur.name}: ${cur.description}`, type: "procedure", status: "active", index: "none", body: cur.body, pinned: false, enabled: true, created: "", updated: "", supersedes: [], evidence: [], extra: {} },
				fields: [],
				reach: "none",
				evidence: rec.flatMap((x) => x.it.evidence),
				why: [...new Set(rec.flatMap((x) => x.it.why))],
				check: rec.findLast((x) => x.it.check)?.it.check,
				risky: findRisky(cur.body),
				runs: [...new Set(rec.map((x) => x.run))],
				version: this.skillVersion(s),
				editable: false,
				skill: { scope: cur.scope, name: cur.name, description: cur.description, body: cur.body, before: s.branch && s.main ? { description: s.main.description, body: s.main.body } : undefined },
			});
		}
		const count = new Map<string, number>();
		for (const it of items) count.set(it.scope, (count.get(it.scope) ?? 0) + 1);
		return items.sort(
			(a, b) =>
				Number(b.scope === GLOBAL_SCOPE) - Number(a.scope === GLOBAL_SCOPE) ||
				(count.get(b.scope) ?? 0) - (count.get(a.scope) ?? 0) ||
				a.scope.localeCompare(b.scope) ||
				KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
				(INDEX_ORDER[a.note.index] ?? 2) - (INDEX_ORDER[b.note.index] ?? 2) ||
				a.key.localeCompare(b.key),
		);
	}

	private counts(c: Computed): ReviewSummary["counts"] {
		const out: ReviewSummary["counts"] = {};
		for (const kind of [...c.diffs.map((d) => d.kind as ItemKind), ...c.skillDiffs.filter((s) => s.branch ?? s.main).map((s): ItemKind => (s.branch ? "skill" : "removed"))]) out[kind] = (out[kind] ?? 0) + 1;
		return out;
	}

	/** What waits for a decision, in short (for status lines). */
	async summary(): Promise<ReviewSummary> {
		const { state } = this.app;
		const [c, agents, comments] = await Promise.all([this.compute(), state.agentsProposals({ status: "pending" }), state.comments()]);
		const counts = this.counts(c);
		const items = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);
		return { pending: items + agents.length, counts, agentsPending: agents.length, waitingComments: comments.filter((x) => !x.processedRun).length };
	}

	/** Everything that waits for a decision, as the reviewer sees it. */
	async view(): Promise<ReviewView> {
		const { state, mem } = this.app;
		await this.app.lock(() => this.sync());
		const runs = await state.reviewRuns();
		const [c, reports, scopes, recent, allComments, allAgents, runInfos] = await Promise.all([
			this.compute(),
			state.runReports(runs),
			mem.scopes(MAIN),
			state.decisions(30),
			state.comments(),
			state.agentsProposals(),
			Promise.all(runs.map((x) => state.run(x))),
		]);
		const since = Date.now() - KEEP_SHOWING;
		const recently = (iso: string | undefined) => !!iso && Date.parse(iso) >= since;
		const agents: AgentsProposal[] = allAgents
			.filter((a) => a.status === "pending" || recently(a.decidedAt ?? a.createdAt))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map((p) => ({ ...p, projectName: scopeShortName(p.projectKey || scopes.find((s) => s.root === p.repoRoot)?.key || p.repoRoot) }));
		const comments = allComments.filter((x) => !x.processedRun || recently(x.processedAt ?? x.at)).map(({ processedAt: _at, ...x }) => x);
		// A project whose first note is still a proposal has its folder on the dreams branch only.
		const proposed = (await mem.scopes(this.branch)).filter((x) => !scopes.some((y) => y.id === x.id));
		const names = this.scopeNames([...scopes, ...proposed], [...c.branch.map((n) => n.scope), ...c.main.map((n) => n.scope), ...recent.map((d) => d.scope ?? "").filter(Boolean)], reports);
		const items = this.items(c, reports, names);
		const warnings: string[] = [];
		for (const it of items) {
			const ref = `${it.note.id ? `${it.note.id} ` : ""}«${it.note.title.slice(0, 70)}»`;
			for (const risk of it.risky) warnings.push(`${ref}: ${risk === "pipe-to-shell" ? "the text has `curl … | sh` — check the source" : risk}`);
			if (it.newerEvidence?.length) warnings.push(`${ref}: the note it closes has evidence newer than this change — check that it no longer holds`);
		}
		const last = reports[reports.length - 1];
		for (const i of last?.indexes ?? []) if (i.dropped.length) warnings.push(`the ${names[i.scope] ?? i.scope} index is over its token budget — search only: ${i.dropped.length}`);
		for (const x of comments) if (x.unhandled) warnings.push(`a comment was not applied: ${x.unhandled}`);
		for (const a of agents) if (a.status === "failed") warnings.push(`${a.projectName} ${a.rel}: the edit did not apply — ${a.error ?? ""}`);
		const counts: ReviewView["counts"] = {};
		for (const it of items) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
		const agentsPending = agents.filter((a) => a.status === "pending").length;
		return {
			pending: items.length + agentsPending,
			counts,
			agentsPending,
			waitingComments: allComments.filter((x) => !x.processedRun).length,
			branch: this.branch,
			items,
			agents,
			comments,
			recent,
			rejectedByCheck: reports.flatMap((rep) => rep.rejected.map((x) => ({ ...x, run: rep.runId }))),
			warnings,
			runInfos: runInfos
				.filter((x): x is NonNullable<typeof x> => !!x)
				.map(({ report: _report, opts: _opts, ...info }) => info)
				.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)),
			sessionTitles: Object.assign({}, ...reports.map((rep) => rep.sessionTitles ?? {})),
			scopeNames: names,
			compareUrl: this.compareUrl(),
		};
	}

	/** Where GitHub shows the same difference (when the remote is GitHub). */
	private compareUrl(): string | undefined {
		const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(this.app.remote.url ?? "");
		return m ? `https://github.com/${m[1]}/${m[2]}/compare/${this.app.repo.branch}...${this.branch}` : undefined;
	}

	/** The decision log, newest first. */
	decisions(limit = 100): Promise<ReviewDecision[]> {
		return this.app.state.decisions(limit);
	}

	// ── deciding ─────────────────────────────────────────────────────────

	private applyEdit(n: Note, edit: NoteEdit): Note {
		const out: Note = { ...n, evidence: [...n.evidence] };
		if (typeof edit.title === "string" && edit.title.trim()) out.title = edit.title.trim();
		if (typeof edit.body === "string") out.body = edit.body.trim();
		if (edit.when !== undefined) out.when = edit.when?.trim() || undefined;
		if (oneOf(INDEX_MODES, edit.index)) out.index = edit.index;
		if (oneOf(NOTE_TYPES, edit.type)) out.type = edit.type;
		if (typeof edit.scope === "string" && edit.scope) out.scope = edit.scope;
		if (sameNote(n, out)) return n;
		out.updated = today();
		// The reviewer's own word, as of now (dreams weigh it against older evidence).
		out.evidence = [...out.evidence.filter((e) => e.s !== "review"), { s: "review", e: [], date: today(), at: isoMinute(Date.now()), kind: "reviewer" }];
		return out;
	}

	/**
	 * Accept items: their rows on the dreams branch become approved memory.
	 * `edit` (one item only) changes the proposed text first.
	 */
	accept(pick: ReviewAccept, actor = ""): Promise<ReviewView> {
		return this.app
			.lock(async () => {
				const { mem, repo, state } = this.app;
				const branch = this.branch;
				await this.sync();
				let c = await this.compute();
				this.checkVersions(c, pick.versions);
				let { diffs: picked, skills } = this.pick(c, pick);
				const edit = pick.edit && typeof pick.edit === "object" && Object.keys(pick.edit).length ? pick.edit : undefined;
				let edited = false;
				if (edit) {
					if (picked.length !== 1 || skills.length) throw bad("an edit applies to exactly one item");
					const d = picked[0];
					if (!lives(d.kind)) throw bad(`a ${d.kind} item has no text to edit`);
					if (edit.scope && edit.scope !== d.note.scope) {
						if (edit.scope !== GLOBAL_SCOPE && !/^projects\/[A-Za-z0-9._-]+$/.test(edit.scope)) throw bad(`bad scope "${edit.scope}"`);
						await mem.ensureScope(MAIN, { id: edit.scope, key: keyOfScope(edit.scope) });
					}
					const next = this.applyEdit(d.note, edit);
					if (next !== d.note) {
						await mem.upsert(branch, [next], { like: MAIN });
						await repo.commit(branch, `edit ${next.id} before accepting it`, this.app.identity);
						edited = true;
						c = await this.compute();
						picked = c.diffs.filter((x) => x.ids.includes(next.id));
					}
				}
				if (!picked.length && !skills.length) return; // `all` with nothing left
				const scopesNeeded = new Set<string>();
				const upsert: Note[] = [];
				const remove: string[] = [];
				for (const d of picked)
					for (const id of d.ids) {
						const n = c.branchById.get(id);
						if (n) {
							upsert.push(n);
							scopesNeeded.add(n.scope);
						} else remove.push(id);
					}
				// A project's folder (its scope.json) comes along with its first accepted note.
				const known = new Set((await mem.scopes(MAIN)).map((s) => s.id));
				const proposed = await mem.scopes(branch);
				for (const scope of scopesNeeded) {
					if (known.has(scope)) continue;
					const meta = proposed.find((x) => x.id === scope);
					await mem.ensureScope(MAIN, { id: scope, key: meta?.key ?? keyOfScope(scope), root: meta?.root });
				}
				await mem.upsert(MAIN, upsert, { like: branch });
				await mem.remove(MAIN, remove);
				await mem.copyFiles(MAIN, branch, upsert.map((n) => n.id));
				for (const s of skills) {
					if (s.branch) await mem.upsertSkill(MAIN, s.branch);
					else if (s.main) await mem.removeSkill(MAIN, s.main.scope, s.main.name);
				}
				const total = picked.length + skills.length;
				const lines = [...picked.map((d) => `${d.kind} ${d.note.id}: ${d.note.title}`), ...skills.map((s) => `skill ${s.key.slice(6)}`)];
				const message = total === 1 ? `accept ${lines[0]}` : `accept ${total} changes (${countsLabel([...picked, ...skills.map(() => ({ kind: "skill" }))])})\n\n${lines.map((l) => `- ${l}`).join("\n")}`;
				await repo.commit(MAIN, actor ? `${message}\n\nvia ${actor}` : message, this.app.identity);
				const at = new Date().toISOString();
				const by = actor || "user";
				await state.addDecisions([
					...picked.map((d): ReviewDecision => ({ key: diffKey(d), kind: d.kind, noteId: d.note.id, title: d.note.title, scope: d.note.scope, decision: edited ? "edited" : "accepted", at, by })),
					...skills.map((s): ReviewDecision => ({ key: s.key, kind: "skill", title: s.key.slice(6), scope: (s.branch ?? s.main)?.scope, decision: "accepted", at, by })),
				]);
				// Brings what is left on the dreams branch in step with the new commit, and pushes.
				await this.app.afterMainChange();
				await this.pruneRuns();
			})
			.then(() => this.view());
	}

	/** Reject items: the dreams branch takes the approved rows back. Their titles are not proposed again without new evidence. */
	reject(pick: ReviewReject, actor = ""): Promise<ReviewView> {
		return this.app
			.lock(async () => {
				const { mem, repo, state } = this.app;
				const branch = this.branch;
				await this.sync();
				const c = await this.compute();
				this.checkVersions(c, pick.versions);
				const { diffs: picked, skills } = this.pick(c, pick);
				if (!picked.length && !skills.length) return;
				const reason = typeof pick.reason === "string" && pick.reason.trim() ? pick.reason.trim() : undefined;
				const upsert: Note[] = [];
				const remove: string[] = [];
				for (const d of picked)
					for (const id of d.ids) {
						const n = c.mainById.get(id);
						if (n) upsert.push(n);
						else remove.push(id);
					}
				await mem.upsert(branch, upsert, { like: MAIN });
				await mem.remove(branch, remove);
				await mem.copyFiles(branch, MAIN, upsert.map((n) => n.id));
				for (const s of skills) {
					if (s.main) await mem.upsertSkill(branch, s.main);
					else if (s.branch) await mem.removeSkill(branch, s.branch.scope, s.branch.name);
				}
				const lines = [...picked.map((d) => `${d.kind} ${d.note.id}: ${d.note.title}`), ...skills.map((s) => `skill ${s.key.slice(6)}`)];
				const message = `reject ${lines.length === 1 ? lines[0] : `${lines.length} changes\n\n${lines.map((l) => `- ${l}`).join("\n")}`}${reason ? `\n\n${reason}` : ""}`;
				await repo.commit(branch, actor ? `${message}\n\nvia ${actor}` : message, this.app.identity);
				const at = new Date().toISOString();
				const by = actor || "user";
				await state.addDecisions([
					...picked.map((d): ReviewDecision => ({ key: diffKey(d), kind: d.kind, noteId: d.note.id, title: d.note.title, scope: d.note.scope, decision: "rejected", at, by, ...(reason ? { reason } : {}) })),
					...skills.map((s): ReviewDecision => ({ key: s.key, kind: "skill", title: s.key.slice(6), scope: (s.branch ?? s.main)?.scope, decision: "rejected", at, by, ...(reason ? { reason } : {}) })),
				]);
				for (const d of picked) if (d.kind === "added" || d.kind === "superseded") await state.addRejection(d.note.title, d.note.id);
				await this.pruneRuns();
				this.app.bump("review");
				this.app.pushSoon();
			})
			.then(() => this.view());
	}

	// ── comments for dreams ──────────────────────────────────────────────

	async comment(body: string, noteId: string | undefined, actor = ""): Promise<ReviewView> {
		if (!body.trim()) throw bad("an empty comment");
		await this.app.lock(async () => {
			await this.app.state.addComment(body.trim(), actor || "user", noteId);
			this.app.bump("review");
		});
		return this.view();
	}

	/** Remove a comment no dream has applied yet. */
	async removeComment(commentId: string): Promise<ReviewView> {
		await this.app.lock(async () => {
			const res = await this.app.state.removeComment(commentId);
			if (res === "gone") throw notFound(`comment ${commentId}`);
			if (res === "applied") throw new HttpError(409, `a dream has applied comment ${commentId} already`);
			this.app.bump("review");
		});
		return this.view();
	}

	// ── AGENTS.md proposals ──────────────────────────────────────────────

	/** Apply an AGENTS.md / CLAUDE.md proposal to the project's working copy. Nothing is committed there. */
	async applyAgents(id: string, edits?: AgentsProposal["edits"]): Promise<void> {
		await this.app.lock(async () => {
			const { state } = this.app;
			const p = await state.agentsProposal(id);
			if (!p) throw notFound(`proposal ${id}`);
			if (p.status === "applied") return;
			const use = edits?.length ? edits : p.edits;
			const file = join(p.repoRoot, p.rel);
			if (!existsSync(file)) {
				await state.updateAgentsProposal(id, { status: "failed", error: `${file} does not exist` });
				throw new HttpError(409, `${file} does not exist`);
			}
			const before = readFileSync(file, "utf-8");
			const res = applyEdits(before, use);
			if ("error" in res) {
				await state.updateAgentsProposal(id, { status: "failed", error: res.error });
				throw new HttpError(409, `${p.rel}: ${res.error} (the file changed since the dream read it)`);
			}
			if (res.content !== before) writeFileSync(file, res.content, "utf-8");
			await state.updateAgentsProposal(id, { status: "applied", error: null, edits: use });
			await this.pruneRuns();
			this.app.bump("review");
		});
	}

	async rejectAgents(id: string): Promise<void> {
		await this.app.lock(async () => {
			const { state } = this.app;
			const p = await state.agentsProposal(id);
			if (!p) throw notFound(`proposal ${id}`);
			await state.updateAgentsProposal(id, { status: "rejected", error: null });
			await this.pruneRuns();
			this.app.bump("review");
		});
	}

	// ── what a dream hands in ────────────────────────────────────────────

	/** Take a dream's result: its changes go to the dreams branch, the rest to the state. */
	submit(sub: DreamSubmit): Promise<DreamSubmitResult> {
		return this.app.lock(async () => {
			const { mem, repo, state } = this.app;
			const branch = this.branch;
			const run = await state.run(sub.runId);
			if (!run) throw notFound(`run ${sub.runId}`);
			if (run.status !== "running") throw new HttpError(409, `run ${run.id} is ${run.status}`);
			const finishedAt = new Date().toISOString();
			const title = runTitle(sub.report);
			if (run.kind === "dry") {
				await state.updateRun(run.id, { status: sub.status, finishedAt, report: sub.report, sessions: sub.sessions, cost: sub.cost, title });
				this.app.bump("dream");
				return { status: sub.status };
			}
			await state.setMarks(sub.marks ?? {});
			await state.setInboxStatus(sub.inboxDone ?? [], "done", run.id);
			await state.addVotes(sub.votes ?? {});
			await state.markComments(sub.commentsDone ?? [], run.id);

			await this.sync();
			const ch = sub.changes ?? { notes: [], removed: [], scopes: [], skills: [] };
			const hasChanges = ch.notes.length + ch.removed.length + ch.skills.length > 0;
			if (hasChanges) {
				const cur = new Map((await mem.notes(branch)).map((n) => [n.id, n]));
				const upsert: Note[] = [];
				const remove: string[] = [];
				for (const { before, after } of ch.notes) {
					// What the reviewer did to the note while the dream ran stays.
					const next = mergeNote(before, cur.get(after.id), after);
					if (next && !sameNote(cur.get(after.id), next)) upsert.push(next);
				}
				for (const gone of ch.removed) {
					const now = cur.get(gone.id);
					if (now && sameNote(now, gone)) remove.push(gone.id);
				}
				// A project that gets its first note: its folder (scope.json) is proposed with the note.
				const known = new Set((await mem.scopes(branch)).map((x) => x.id));
				for (const sc of ch.scopes ?? []) if (!known.has(sc.id)) await mem.ensureScope(branch, sc);
				await mem.upsert(branch, upsert, { like: MAIN });
				await mem.remove(branch, remove);
				for (const s of ch.skills) await mem.upsertSkill(branch, s);
				await repo.commit(branch, `${title}\n\nrun ${run.id}`, DREAM_AUTHOR);
			}
			for (const a of sub.agents ?? []) await state.addAgentsProposal({ ...a, runId: run.id });
			const proposed = hasChanges || !!sub.agents?.length;
			if (proposed) await state.setReviewRuns([...(await state.reviewRuns()).filter((r) => r !== run.id), run.id]);
			const status = proposed ? "ok" : sub.status === "ok" ? "ok" : "noop";
			// The report first: it is what keeps the run among those whose proposals are pending.
			await state.updateRun(run.id, { status, finishedAt, report: sub.report, sessions: sub.sessions, cost: sub.cost, title });
			const c = await this.compute();
			await this.pruneRuns(c);
			const items = c.diffs.length + c.skillDiffs.length + (await state.agentsProposals({ status: "pending" })).length;
			this.app.bump("dream");
			this.app.pushSoon();
			return { status, url: proposed ? `${this.app.url}/#/review` : undefined, items };
		});
	}

	/** What the index of a scope would hold if everything proposed were accepted (for previews). */
	async preview(scope: string): Promise<{ text: string; tokens: number; over: number }> {
		const notes = (await this.app.notes(this.branch)).filter((n) => n.scope === scope);
		const idx = buildIndex(notes, scope, this.app.budgetOf(scope));
		return { text: idx.text, tokens: idx.tokens, over: idx.dropped.length };
	}
}
