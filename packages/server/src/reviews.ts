/**
 * Reviews: what dreams propose waits here until a person decides.
 *
 * A review is a Dolt branch off `main` (`review-<id>`). Dreams commit their
 * changes to it; while it is open, later dreams add to it. The items of a
 * review are the difference between `main` and the branch, note by note
 * (`diffNotes`) — so the list always shows exactly what accepting would
 * change, whoever made the change: a dream, a review comment a dream applied,
 * or the reviewer's own edit.
 *
 * Deciding an item:
 *   accept          the branch's rows are copied to `main` (one commit)
 *   edit and accept the reviewer's text goes to the branch first, then as above
 *   reject          `main`'s rows are copied back to the branch
 * Either way the item's rows become equal on both sides and it leaves the
 * list. When nothing is left the review closes and its branch is deleted.
 *
 * `main` can change while a review is open (hand edits, accepted items).
 * `sync` carries those changes into the branch column by column
 * (`rebaseNotes`), so the branch stays "main + what is still proposed".
 */

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
	type ReviewDecision,
	type ReviewItem,
	type ReviewSummary,
	type ReviewView,
	runTitle,
	sameNote,
	today,
} from "@wierd-mem/core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type App, bad, DREAM_AUTHOR, HttpError, notFound, scopeShortName, SYSTEM_AUTHOR } from "./app.ts";
import { MAIN } from "./dolt.ts";
import type { ScopeRow, SkillRow } from "./memory.ts";
import type { ReviewRow } from "./state.ts";

const KIND_ORDER: ItemKind[] = ["added", "superseded", "updated", "moved", "deprecated", "removed", "skill", "confirmed"];
const INDEX_ORDER: Record<string, number> = { always: 0, pointer: 1, none: 2 };
/** The note stays in memory after this change, so its text matters. */
const lives = (k: ItemKind) => k === "added" || k === "updated" || k === "moved" || k === "superseded";

const skillKey = (s: { scope: string; name: string }) => `skill:${s.scope}/${s.name}`;
const sameSkill = (a?: SkillRow, b?: SkillRow) => (!a || !b ? a === b : a.description === b.description && a.body.trim() === b.body.trim());

function newReviewId(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `r-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${Math.random().toString(16).slice(2, 6).padEnd(4, "0")}`;
}

interface Computed {
	main: Note[];
	branch: Note[];
	diffs: NoteDiff[];
	skillsMain: SkillRow[];
	skillsBranch: SkillRow[];
	/** Skills that differ: the branch's version, or the main one when the branch dropped it. */
	skillDiffs: Array<{ key: string; main?: SkillRow; branch?: SkillRow }>;
}

export class Reviews {
	constructor(private app: App) {}

	// ── keeping the branch in step with main ─────────────────────────────

	/** Carry what `main` changed since the branch last saw it into the branch. */
	async sync(r: ReviewRow): Promise<void> {
		const { db, mem, state } = this.app;
		const head = await db.head(MAIN);
		if (r.baseCommit === head) return;
		const base = r.baseCommit ? await mem.notesAt(r.baseCommit) : await mem.notes(MAIN);
		const [main, branch] = await Promise.all([mem.notes(MAIN), mem.notes(r.branch)]);
		const rb = rebaseNotes(base, main, branch);
		await mem.upsert(r.branch, rb.upsert);
		await mem.remove(r.branch, rb.remove);
		// Skills: whole rows. One the branch does not propose a change to follows main.
		const [skillsBase, skillsMain, skillsBranch] = await Promise.all([r.baseCommit ? this.skillsAt(r.baseCommit) : mem.skills(MAIN), mem.skills(MAIN), mem.skills(r.branch)]);
		const by = (list: SkillRow[]) => new Map(list.map((s) => [skillKey(s), s]));
		const [sb, sm, sbr] = [by(skillsBase), by(skillsMain), by(skillsBranch)];
		for (const key of new Set([...sb.keys(), ...sm.keys()])) {
			if (sameSkill(sb.get(key), sm.get(key)) && sb.has(key) === sm.has(key)) continue;
			const cur = sbr.get(key);
			const touched = sb.has(key) !== sbr.has(key) || !sameSkill(sb.get(key), cur);
			if (touched) continue;
			const next = sm.get(key);
			if (next) await mem.upsertSkill(r.branch, next, today());
			else if (cur) await mem.removeSkill(r.branch, cur.scope, cur.name);
		}
		await mem.copyShared(r.branch);
		await db.commit(r.branch, `in step with main ${head.slice(0, 8)}`, SYSTEM_AUTHOR);
		r.baseCommit = head;
		await state.saveReview(r);
	}

	private async skillsAt(commit: string): Promise<SkillRow[]> {
		return this.app.db.onBranch(MAIN, async (c) => {
			const [rows] = await c.query("SELECT scope, name, description, body FROM skills AS OF ?", [commit]);
			return (rows as Array<Record<string, unknown>>).map((x) => ({ scope: String(x.scope), name: String(x.name), description: String(x.description ?? ""), body: String(x.body ?? "") }));
		});
	}

	// ── what a review holds ──────────────────────────────────────────────

	private async compute(r: ReviewRow): Promise<Computed> {
		const { mem } = this.app;
		const [main, branch, skillsMain, skillsBranch] = await Promise.all([this.app.notes(MAIN), this.app.notes(r.branch), mem.skills(MAIN), mem.skills(r.branch)]);
		const sm = new Map(skillsMain.map((s) => [skillKey(s), s]));
		const sb = new Map(skillsBranch.map((s) => [skillKey(s), s]));
		const skillDiffs: Computed["skillDiffs"] = [];
		for (const key of new Set([...sm.keys(), ...sb.keys()])) {
			if (sm.has(key) && sb.has(key) && sameSkill(sm.get(key), sb.get(key))) continue;
			skillDiffs.push({ key, main: sm.get(key), branch: sb.get(key) });
		}
		return { main, branch, diffs: diffNotes(main, branch), skillsMain, skillsBranch, skillDiffs };
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

	private async agentsOf(reviewId: string, scopes: readonly ScopeRow[]): Promise<AgentsProposal[]> {
		const list = await this.app.state.agentsProposals({ reviewId });
		return list.map((p) => ({ ...p, projectName: scopeShortName(p.projectKey || scopes.find((s) => s.root === p.repoRoot)?.key || p.repoRoot) }));
	}

	private async summarize(r: ReviewRow, pending?: number): Promise<ReviewSummary> {
		const counts = (await this.app.state.decisionCounts([r.id]))[r.id] ?? { accepted: 0, rejected: 0 };
		return { id: r.id, status: r.status, title: r.title, createdAt: r.createdAt, closedAt: r.closedAt, pending: pending ?? 0, accepted: counts.accepted, rejected: counts.rejected, runs: r.runs };
	}

	/** The open review in short (for status lines), or null. */
	async openSummary(): Promise<ReviewSummary | null> {
		const r = await this.app.state.openReview();
		if (!r) return null;
		const c = await this.compute(r);
		const agents = await this.app.state.agentsProposals({ reviewId: r.id, status: "pending" });
		return this.summarize(r, c.diffs.length + c.skillDiffs.length + agents.length);
	}

	async list(limit = 50): Promise<ReviewSummary[]> {
		const rows = await this.app.state.reviews(limit);
		const counts = await this.app.state.decisionCounts(rows.map((r) => r.id));
		const out: ReviewSummary[] = [];
		for (const r of rows) {
			let pending = 0;
			if (r.status === "open") pending = (await this.openSummary())?.pending ?? 0;
			const c = counts[r.id] ?? { accepted: 0, rejected: 0 };
			out.push({ id: r.id, status: r.status, title: r.title, createdAt: r.createdAt, closedAt: r.closedAt, pending, accepted: c.accepted, rejected: c.rejected, runs: r.runs });
		}
		return out;
	}

	/** A review as the reviewer sees it. `id` "open" (or none): the open one. */
	async view(id?: string): Promise<ReviewView | null> {
		const { state, mem } = this.app;
		const r = !id || id === "open" ? await state.openReview() : await state.review(id);
		if (!r) {
			if (!id || id === "open") return null;
			throw notFound(`review ${id}`);
		}
		const [reports, scopes, decisions, comments, runInfos] = await Promise.all([
			state.runReports(r.runs),
			mem.scopes(MAIN),
			state.decisions(r.id),
			state.comments(r.id),
			Promise.all(r.runs.map((x) => state.run(x))),
		]);
		const agents = await this.agentsOf(r.id, scopes);
		let items: ReviewItem[] = [];
		let names = this.scopeNames(scopes, decisions.map((d) => d.scope ?? "").filter(Boolean), reports);
		if (r.status === "open") {
			await this.app.lock(() => this.sync(r));
			const c = await this.compute(r);
			names = this.scopeNames(scopes, [...c.branch.map((n) => n.scope), ...c.main.map((n) => n.scope)], reports);
			items = this.items(c, reports, names);
		}
		const warnings: string[] = [];
		for (const it of items) {
			const ref = `${it.note.id ? `${it.note.id} ` : ""}«${it.note.title.slice(0, 70)}»`;
			for (const risk of it.risky) warnings.push(`${ref}: ${risk === "pipe-to-shell" ? "the text has `curl … | sh` — check the source" : risk}`);
			if (it.newerEvidence?.length) warnings.push(`${ref}: the note it closes has evidence newer than this change — check that it no longer holds`);
		}
		const last = reports[reports.length - 1];
		for (const i of last?.indexes ?? []) if (i.dropped.length) warnings.push(`the ${names[i.scope] ?? i.scope} index is over its token budget — search only: ${i.dropped.length}`);
		for (const c of comments) if (c.unhandled) warnings.push(`a comment was not applied: ${c.unhandled}`);
		for (const a of agents) if (a.status === "failed") warnings.push(`${a.projectName} ${a.rel}: the edit did not apply — ${a.error ?? ""}`);
		const counts: ReviewView["counts"] = {};
		for (const it of items) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
		const pendingAgents = agents.filter((a) => a.status === "pending").length;
		return {
			...(await this.summarize(r, items.length + pendingAgents)),
			branch: r.branch,
			items,
			decisions,
			comments,
			agents,
			rejectedByCheck: reports.flatMap((rep) => rep.rejected.map((x) => ({ ...x, run: rep.runId }))),
			warnings,
			runInfos: runInfos.filter((x): x is NonNullable<typeof x> => !!x).map(({ report: _report, opts: _opts, ...info }) => info),
			sessionTitles: Object.assign({}, ...reports.map((rep) => rep.sessionTitles ?? {})),
			scopeNames: names,
			counts,
		};
	}

	// ── deciding ─────────────────────────────────────────────────────────

	private async openById(id: string): Promise<ReviewRow> {
		const r = await this.app.state.review(id === "open" ? ((await this.app.state.openReview())?.id ?? "") : id);
		if (!r) throw notFound(`review ${id}`);
		if (r.status !== "open") throw new HttpError(409, `review ${r.id} is ${r.status}`);
		return r;
	}

	private applyEdit(n: Note, edit: NoteEdit, reviewId: string): Note {
		const out: Note = { ...n, evidence: [...n.evidence] };
		if (typeof edit.title === "string" && edit.title.trim()) out.title = edit.title.trim();
		if (typeof edit.body === "string") out.body = edit.body.trim();
		if (edit.when !== undefined) out.when = edit.when?.trim() || undefined;
		if (oneOf(INDEX_MODES, edit.index)) out.index = edit.index;
		if (oneOf(NOTE_TYPES, edit.type)) out.type = edit.type;
		if (typeof edit.scope === "string" && edit.scope) out.scope = edit.scope;
		if (sameNote(n, out)) return n;
		out.updated = today();
		const mark = `review:${reviewId}`;
		if (!out.evidence.some((e) => e.s === mark && !e.e.length)) out.evidence.push({ s: mark, e: [], date: today(), at: isoMinute(Date.now()), kind: "reviewer" });
		return out;
	}

	/**
	 * Accept items: their rows on the branch become approved memory. `edit`
	 * (one item only) changes the proposed text first.
	 */
	accept(reviewId: string, keys: readonly string[] | undefined, edit: NoteEdit | undefined, actor = ""): Promise<ReviewView | null> {
		return this.app
			.lock(async () => {
				const { mem, db, state } = this.app;
				const r = await this.openById(reviewId);
				await this.sync(r);
				let c = await this.compute(r);
				const wanted = keys ? new Set(keys) : undefined;
				let picked = c.diffs.filter((d) => !wanted || wanted.has(diffKey(d)));
				const skills = c.skillDiffs.filter((s) => !wanted || wanted.has(s.key));
				if (wanted && !picked.length && !skills.length) throw notFound("such item in the review (already decided?)");
				const edited = new Set<string>();
				if (edit && Object.keys(edit).length) {
					if (picked.length !== 1) throw bad("an edit applies to exactly one item");
					const d = picked[0];
					if (!lives(d.kind)) throw bad(`a ${d.kind} item has no text to edit`);
					if (edit.scope && edit.scope !== d.note.scope) {
						if (edit.scope !== GLOBAL_SCOPE && !/^projects\/[A-Za-z0-9._-]+$/.test(edit.scope)) throw bad(`bad scope "${edit.scope}"`);
						await mem.ensureScope(MAIN, { id: edit.scope, key: keyOfScope(edit.scope) });
					}
					const next = this.applyEdit(d.note, edit, r.id);
					if (next !== d.note) {
						await mem.upsert(r.branch, [next]);
						await db.commit(r.branch, `review ${r.id}: edit ${next.id} by hand`, this.app.identity);
						edited.add(diffKey(d));
						c = await this.compute(r);
						picked = c.diffs.filter((x) => x.ids.includes(next.id));
					}
				}
				const branchById = new Map(c.branch.map((n) => [n.id, n]));
				const scopesNeeded = new Set<string>();
				const upsert: Note[] = [];
				const remove: string[] = [];
				for (const d of picked)
					for (const id of d.ids) {
						const n = branchById.get(id);
						if (n) {
							upsert.push(n);
							scopesNeeded.add(n.scope);
						} else remove.push(id);
					}
				const known = new Set((await mem.scopes(MAIN)).map((s) => s.id));
				for (const scope of scopesNeeded) if (!known.has(scope)) await mem.ensureScope(MAIN, { id: scope, key: keyOfScope(scope) });
				await mem.upsert(MAIN, upsert);
				await mem.remove(MAIN, remove);
				for (const s of skills) {
					if (s.branch) await mem.upsertSkill(MAIN, s.branch, today());
					else if (s.main) await mem.removeSkill(MAIN, s.main.scope, s.main.name);
				}
				const total = picked.length + skills.length;
				const lines = [...picked.map((d) => `${d.kind} ${d.note.id}: ${d.note.title}`), ...skills.map((s) => `skill ${s.key.slice(6)}`)];
				const message = total === 1 ? `accept ${lines[0]}\n\nreview ${r.id}` : `accept ${total} changes (${countsLabel([...picked, ...skills.map(() => ({ kind: "skill" }))])})\n\nreview ${r.id}\n${lines.map((l) => `- ${l}`).join("\n")}`;
				const hash = await db.commit(MAIN, actor ? `${message}\nvia ${actor}` : message, this.app.identity);
				if (hash) {
					r.baseCommit = await db.head(MAIN);
					await mem.copyShared(r.branch);
					await db.commit(r.branch, `in step with main ${r.baseCommit.slice(0, 8)}`, SYSTEM_AUTHOR);
					await state.saveReview(r);
				}
				const at = new Date().toISOString();
				for (const d of picked) {
					const key = diffKey(d);
					await state.addDecision(r.id, { key, kind: d.kind, noteId: d.note.id, title: d.note.title, scope: d.note.scope, decision: edited.has(key) || (edit && picked.length === 1 && edited.size) ? "edited" : "accepted", at, by: actor || "user" });
				}
				for (const s of skills) await state.addDecision(r.id, { key: s.key, kind: "skill", title: s.key.slice(6), scope: (s.branch ?? s.main)?.scope, decision: "accepted", at, by: actor || "user" });
				await this.finishIfDone(r);
				await this.app.afterMainChange({ skills: skills.length > 0 });
				return r.id;
			})
			.then((id) => this.viewAfter(id));
	}

	/** Reject items: the branch takes `main`'s rows back. Their titles are not proposed again without new evidence. */
	reject(reviewId: string, keys: readonly string[] | undefined, reason: string | undefined, actor = ""): Promise<ReviewView | null> {
		return this.app
			.lock(async () => {
				const { mem, db, state } = this.app;
				const r = await this.openById(reviewId);
				await this.sync(r);
				const c = await this.compute(r);
				const wanted = keys ? new Set(keys) : undefined;
				const picked = c.diffs.filter((d) => !wanted || wanted.has(diffKey(d)));
				const skills = c.skillDiffs.filter((s) => !wanted || wanted.has(s.key));
				if (wanted && !picked.length && !skills.length) throw notFound("such item in the review (already decided?)");
				const mainById = new Map(c.main.map((n) => [n.id, n]));
				const upsert: Note[] = [];
				const remove: string[] = [];
				for (const d of picked)
					for (const id of d.ids) {
						const n = mainById.get(id);
						if (n) upsert.push(n);
						else remove.push(id);
					}
				await mem.upsert(r.branch, upsert);
				await mem.remove(r.branch, remove);
				for (const s of skills) {
					if (s.main) await mem.upsertSkill(r.branch, s.main, today());
					else if (s.branch) await mem.removeSkill(r.branch, s.branch.scope, s.branch.name);
				}
				const lines = [...picked.map((d) => `${d.kind} ${d.note.id}: ${d.note.title}`), ...skills.map((s) => `skill ${s.key.slice(6)}`)];
				await db.commit(r.branch, `review ${r.id}: reject ${lines.length === 1 ? lines[0] : `${lines.length} changes\n\n${lines.map((l) => `- ${l}`).join("\n")}`}`, this.app.identity);
				const at = new Date().toISOString();
				for (const d of picked) {
					await state.addDecision(r.id, { key: diffKey(d), kind: d.kind, noteId: d.note.id, title: d.note.title, scope: d.note.scope, decision: "rejected", at, by: actor || "user", reason });
					if (d.kind === "added" || d.kind === "superseded") await state.addRejection(d.note.title, r.id, d.note.id);
				}
				for (const s of skills) await state.addDecision(r.id, { key: s.key, kind: "skill", title: s.key.slice(6), scope: (s.branch ?? s.main)?.scope, decision: "rejected", at, by: actor || "user", reason });
				await this.finishIfDone(r);
				this.app.bump("review");
				return r.id;
			})
			.then((id) => this.viewAfter(id));
	}

	private async viewAfter(id: string): Promise<ReviewView | null> {
		return this.view(id);
	}

	/** Close the review once nothing is left to decide. */
	private async finishIfDone(r: ReviewRow): Promise<boolean> {
		const { state, db } = this.app;
		const c = await this.compute(r);
		if (c.diffs.length || c.skillDiffs.length) return false;
		if ((await state.agentsProposals({ reviewId: r.id, status: "pending" })).length) return false;
		const decisions = await state.decisions(r.id);
		const applied = (await state.agentsProposals({ reviewId: r.id })).some((a) => a.status === "applied");
		r.status = decisions.some((d) => d.decision !== "rejected") || applied ? "merged" : "closed";
		r.closedAt = new Date().toISOString();
		await state.saveReview(r);
		try {
			await db.deleteBranch(r.branch);
		} catch (err) {
			this.app.log(`review ${r.id}: could not delete branch ${r.branch}: ${err instanceof Error ? err.message : err}`);
		}
		return true;
	}

	/** Close the open review whatever is left in it: everything undecided counts as rejected. */
	async close(reviewId: string, actor = ""): Promise<ReviewView | null> {
		const r = await this.openById(reviewId);
		await this.reject(r.id, undefined, "review closed", actor).catch((err) => {
			if (!(err instanceof HttpError) || err.status !== 404) throw err;
		});
		await this.app.lock(async () => {
			for (const a of await this.app.state.agentsProposals({ reviewId: r.id, status: "pending" })) await this.app.state.updateAgentsProposal(a.id, { status: "rejected" });
			const fresh = await this.app.state.review(r.id);
			if (fresh?.status === "open") await this.finishIfDone(fresh);
			this.app.bump("review");
		});
		return this.view(r.id);
	}

	// ── comments for the next dream ──────────────────────────────────────

	async comment(reviewId: string, body: string, noteId: string | undefined, actor = ""): Promise<ReviewView | null> {
		const r = await this.openById(reviewId);
		if (!body.trim()) throw bad("an empty comment");
		await this.app.state.addComment(r.id, body.trim(), actor || "user", noteId);
		this.app.bump("review");
		return this.view(r.id);
	}

	async removeComment(reviewId: string, commentId: string): Promise<ReviewView | null> {
		await this.app.state.removeComment(commentId);
		this.app.bump("review");
		return this.view(reviewId);
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
			if (p.reviewId) {
				const r = await state.review(p.reviewId);
				if (r?.status === "open") await this.finishIfDone(r);
			}
			this.app.bump("review");
		});
	}

	async rejectAgents(id: string): Promise<void> {
		await this.app.lock(async () => {
			const { state } = this.app;
			const p = await state.agentsProposal(id);
			if (!p) throw notFound(`proposal ${id}`);
			await state.updateAgentsProposal(id, { status: "rejected", error: null });
			if (p.reviewId) {
				const r = await state.review(p.reviewId);
				if (r?.status === "open") await this.finishIfDone(r);
			}
			this.app.bump("review");
		});
	}

	// ── what a dream hands in ────────────────────────────────────────────

	/** Take a dream's result: its changes go to the review branch, the rest to the state. */
	submit(sub: DreamSubmit): Promise<DreamSubmitResult> {
		return this.app.lock(async () => {
			const { mem, db, state } = this.app;
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

			const ch = sub.changes ?? { notes: [], removed: [], scopes: [], skills: [] };
			const hasChanges = ch.notes.length + ch.removed.length + ch.skills.length > 0;
			let review = await state.openReview();
			let reviewId: string | undefined;
			let items = 0;
			let mainChanged = false;
			if (hasChanges || sub.agents?.length) {
				// A project's scope row is not memory: it goes straight to main.
				for (const s of ch.scopes ?? []) await mem.ensureScope(MAIN, s);
				if (await db.commit(MAIN, `scopes: ${(ch.scopes ?? []).map((s) => s.id).join(", ")}`, SYSTEM_AUTHOR)) mainChanged = true;
				if (!review) {
					const id = newReviewId();
					review = { id, branch: `review-${id.slice(2)}`, status: "open", title: "", createdAt: finishedAt, baseCommit: await db.head(MAIN), runs: [] };
					await db.createBranch(review.branch, MAIN);
					await state.saveReview(review);
				} else {
					await this.sync(review);
				}
				reviewId = review.id;
				if (hasChanges) {
					const cur = new Map((await mem.notes(review.branch)).map((n) => [n.id, n]));
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
					await mem.upsert(review.branch, upsert);
					await mem.remove(review.branch, remove);
					for (const s of ch.skills) await mem.upsertSkill(review.branch, s, today());
					await db.commit(review.branch, `${title}\n\nrun ${run.id}`, DREAM_AUTHOR);
				}
				for (const a of sub.agents ?? []) await state.addAgentsProposal({ ...a, runId: run.id, reviewId: review.id });
				if (!review.runs.includes(run.id)) review.runs.push(run.id);
				const c = await this.compute(review);
				const pendingAgents = (await state.agentsProposals({ reviewId: review.id, status: "pending" })).length;
				items = c.diffs.length + c.skillDiffs.length + pendingAgents;
				review.title = `review ${review.createdAt.slice(0, 10)}: ${countsLabel([...c.diffs, ...c.skillDiffs.map(() => ({ kind: "skill" }))], pendingAgents) || "nothing left"}`;
				await state.saveReview(review);
			}
			const status = hasChanges || sub.agents?.length ? "ok" : sub.status === "ok" ? "ok" : "noop";
			await state.updateRun(run.id, { status, finishedAt, report: sub.report, sessions: sub.sessions, cost: sub.cost, reviewId, title });
			// The dream may have emptied the review (dropped its own pending notes on a comment).
			if (review && reviewId) {
				await state.saveReview(review);
				await this.finishIfDone(review);
			}
			if (mainChanged) await this.app.afterMainChange();
			else this.app.bump("dream");
			return { status, reviewId, url: reviewId ? `${this.app.url}/#/review` : undefined, items };
		});
	}

	/** What the index of each scope would hold if the open review were accepted whole (for previews). */
	async preview(scope: string): Promise<{ text: string; tokens: number; over: number } | null> {
		const r = await this.app.state.openReview();
		if (!r) return null;
		const notes = (await this.app.notes(r.branch)).filter((n) => n.scope === scope);
		const idx = buildIndex(notes, scope, this.app.budgetOf(scope));
		return { text: idx.text, tokens: idx.tokens, over: idx.dropped.length };
	}
}
