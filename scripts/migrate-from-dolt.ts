/**
 * One-off: move this machine's wierd-mem from Dolt to the git repository.
 *
 * Reads the dump made from the old server (`~/.wierd-mem/dolt-export`: the
 * API's answers and the state tables as JSON) and writes it into the new
 * storage: the state files, the runs with their reports, and the open review
 * as a branch with the same proposals. Approved notes are checked against the
 * files of the approved branch (they came from the same repository).
 *
 *   wmem init --repo <url> --branch v2 --from main   # first
 *   bun scripts/migrate-from-dolt.ts
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { diffNotes, type InboxItem, type Note, type ReportData, type ReviewView, type RunInfo, sameNote, type SessionMark } from "../packages/core/src/index.ts";
import { App, DREAM_AUTHOR } from "../packages/server/src/app.ts";
import { MAIN, REVIEW_PREFIX } from "../packages/server/src/git.ts";

const D = join(homedir(), ".wierd-mem", "dolt-export");
const api = <T>(name: string): T => JSON.parse(readFileSync(join(D, "api", `${name}.json`), "utf-8")) as T;
const rows = (name: string): Array<Record<string, string | null>> => (JSON.parse(readFileSync(join(D, "sql", `${name}.json`), "utf-8")) as { rows?: Array<Record<string, string | null>> }).rows ?? [];
const strip = (n: Note): Note => {
	const { reach: _r, scopeName: _s, file: _f, stats: _st, ...note } = n as Note & { reach?: string; scopeName?: string; file?: string };
	return note as Note;
};

const app = await App.start({ noSchedule: true });
const { state, mem, repo } = app;
console.log(`memory: ${app.paths.memory} (branch ${repo.branch} at ${(await repo.head(MAIN)).slice(0, 8)})`);

// ── approved notes: the files must say what the database said ────────────
const oldMain = api<{ notes: Note[] }>("notes").notes.map(strip);
const files = new Map((await mem.notes(MAIN)).map((n) => [n.id, n]));
const differs = oldMain.filter((n) => !sameNote(files.get(n.id), n));
const extra = [...files.keys()].filter((id) => !oldMain.some((n) => n.id === id));
console.log(`approved notes: ${oldMain.length} in Dolt, ${files.size} in files, ${differs.length} differ, ${extra.length} only in files`);
if (differs.length) {
	await mem.upsert(MAIN, differs);
	const hash = await repo.commit(MAIN, `migrate from Dolt: ${differs.length} notes`, app.identity);
	console.log(`  wrote them: commit ${hash?.slice(0, 8)}`);
}

// ── state ────────────────────────────────────────────────────────────────
const kv = Object.fromEntries(rows("state_kv").map((r) => [r.k, JSON.parse(r.v ?? "null")]));
if (typeof kv.cutoffMs === "number") await state.set("cutoffMs", kv.cutoffMs);
const marks: Record<string, SessionMark> = {};
for (const r of rows("state_session_marks")) marks[r.path as string] = { size: Number(r.size), mtimeMs: Number(r.mtime_ms), at: r.at as string, ok: r.ok === "1", failures: Number(r.failures) };
await state.setMarks(marks);
const have = new Set((await state.inbox("all")).map((i) => i.id));
let inbox = 0;
for (const r of rows("state_inbox").sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
	if (have.has(r.id as string)) continue;
	const item: Omit<InboxItem, "status"> & { status: InboxItem["status"] } = {
		id: r.id as string,
		ts: r.ts as string,
		source: r.source === "user" ? "user" : "agent",
		text: r.text as string,
		kind: (r.kind ?? undefined) as InboxItem["kind"],
		scope: (r.scope ?? undefined) as InboxItem["scope"],
		cwd: r.cwd ?? "",
		projectKey: r.project_key ?? "",
		sessionId: r.session_id ?? undefined,
		sessionFile: r.session_file ?? undefined,
		entryId: r.entry_id ?? undefined,
		status: (r.status ?? "pending") as InboxItem["status"],
	};
	await state.addInbox(item);
	if (item.status !== "pending") await state.setInboxStatus([item.id], item.status, r.run_id ?? undefined);
	inbox++;
}
for (const r of rows("state_rejections")) await state.addRejection(r.title as string, r.review_id ?? undefined, r.note_id ?? undefined);
for (const r of rows("state_note_stats")) await state.setStats(r.note_id as string, { helpful: Number(r.helpful), harmful: Number(r.harmful) });
console.log(`state: ${Object.keys(marks).length} sessions read, ${inbox} inbox items (${(await state.inbox("pending")).length} pending), ${rows("state_rejections").length} rejected titles, ${rows("state_note_stats").length} notes with votes`);

// ── runs ─────────────────────────────────────────────────────────────────
const known = new Set((await state.runs(10_000)).map((r) => r.id));
for (const row of rows("state_runs").sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))) {
	const id = row.id as string;
	if (known.has(id)) continue;
	const run = api<RunInfo & { opts?: Record<string, unknown>; report?: ReportData }>(`run_${id}`);
	const { report, opts, ...info } = run;
	await state.createRun({ ...info, opts });
	if (report) await state.updateRun(id, { report });
	console.log(`run ${id}: ${info.status}${info.title ? ` — ${info.title}` : ""}${report ? `, report with ${report.items.length} items` : ""}`);
}

// ── the open review: the same proposals, as a branch ─────────────────────
const old = api<ReviewView | null>("review");
if (old && !(await state.review(old.id))) {
	const proposed = api<{ notes: Note[] }>("notes_review").notes.map(strip);
	const diffs = diffNotes(oldMain, proposed);
	const changed = proposed.filter((n) => diffs.some((d) => d.ids.includes(n.id)));
	const gone = diffs.filter((d) => d.kind === "removed").map((d) => d.note.id);
	const branch = `${REVIEW_PREFIX}${old.id}`;
	await repo.createBranch(branch, MAIN);
	const mainScopes = new Set((await mem.scopes(MAIN)).map((s) => s.id));
	for (const s of rows("review_scopes")) if (!mainScopes.has(s.id as string) && changed.some((n) => n.scope === s.id)) await mem.ensureScope(branch, { id: s.id as string, key: s.project_key ?? undefined, root: s.root ?? undefined });
	await mem.upsert(branch, changed, { like: MAIN });
	await mem.remove(branch, gone);
	const run = old.runInfos[old.runInfos.length - 1];
	const hash = await repo.commit(branch, `${run?.title ?? old.title}\n\n${old.runs.map((r) => `run ${r}`).join("\n")}\nmoved from Dolt as it stood (${old.items.length} proposals, none decided)`, DREAM_AUTHOR);
	await state.saveReview({ id: old.id, branch, status: "open", title: old.title, createdAt: old.createdAt, baseCommit: await repo.head(MAIN), runs: old.runs });
	for (const c of old.comments) await state.addComment(old.id, c.body, c.author, c.noteId);
	console.log(`review ${old.id}: branch ${branch} at ${hash?.slice(0, 8)} with ${changed.length} notes written`);
}

// ── does the review look the same? ───────────────────────────────────────
const now = await app.reviews.view();
if (old) {
	const sig = (v: ReviewView | null) => (v?.items ?? []).map((i) => [i.key, i.kind, i.scope, i.note.title, i.note.body, i.note.index, i.reach, JSON.stringify(i.why), JSON.stringify(i.check ?? null), JSON.stringify(i.evidence), i.fields.join(",")].join(" | ")).sort();
	const a = sig(old);
	const b = sig(now);
	const same = a.length === b.length && a.every((x, i) => x === b[i]);
	console.log(`review after the move: ${now?.items.length} items, ${same ? "identical to what Dolt showed (keys, kinds, scopes, texts, reach, why, check, evidence)" : "DIFFERS from what Dolt showed"}`);
	if (!same) for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) console.log(`  was: ${a[i]?.slice(0, 300)}\n  now: ${b[i]?.slice(0, 300)}`);
}
const st = await app.status();
console.log(`status: ${st.notes.active} active notes in ${st.notes.scopes} scopes, inbox ${st.inbox}, review ${st.review ? `${st.review.pending} to decide` : "none"}, memory ${st.memver}`);
await app.stop();
