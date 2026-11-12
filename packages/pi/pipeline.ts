/**
 * One dream, end to end. Runs inside a headless pi process (`runner.ts`),
 * started by the wierd-memory server.
 *
 * 1. ask the server what to work on: settings, which sessions were read, the
 *    inbox, the notes (approved + what is already proposed: the dreams branch),
 *    the review comments not applied yet
 * 2. rebuild digests of changed sessions (the search corpus)
 * 3. summarize pending sessions into cards (cheap model, cached)
 * 4. review pass: turn review comments into operations
 * 5. per project: the curator proposes operations (strong model) with history
 *    hits from older sessions and the list of the project's docs; withdrawals
 *    of earlier proposals apply at once, adds past `dream.maxNewNotesPerPass`
 *    are dropped; cited evidence is looked up in the raw sessions; an
 *    independent model checks every other operation against it
 * 6. code applies what passed to an in-memory copy of the notes
 * 7. hand the result to the server: it writes the changes to the dreams
 *    branch, where they wait for the user — nothing becomes memory here
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentsEdit,
	type AgentsMdOp,
	applyOp,
	applyVotes,
	Bm25,
	buildDigest,
	buildIndex,
	type Change,
	chunkDigest,
	clipHead,
	DEFAULT_GLOBAL_CHARTER,
	DEFAULT_PROJECT_CHARTER,
	digestHeader,
	type Doc,
	type DreamSubmit,
	type DreamSubmitResult,
	type DreamWorkspace,
	type Evidence,
	type EvidenceRef,
	evidenceTime,
	findContextFile,
	findRisky,
	GLOBAL_SCOPE,
	type HomePaths,
	homePaths,
	type InboxItem,
	indexStats,
	isoMinute,
	isSessionEvidence,
	keyToDir,
	listRepoDocs,
	listSessionFiles,
	type Note,
	type Op,
	type ParsedOps,
	parseOps,
	parseSession,
	pendingSessions,
	type ProjectInfo,
	ProjectMap,
	projectScope,
	renderDigest,
	renderEditsDiff,
	renderEntryFull,
	renderReport,
	type ReportAgents,
	type ReportData,
	type ReportItem,
	type ReportRejected,
	type ReportSession,
	resolveProject,
	type ReviewComment,
	SessionCache,
	type SessionFile,
	sessionIdFromPath,
	type SessionMark,
	shortKey,
	snippet,
	type Stage,
	type StageModel,
	type StageUsage,
	systemPrompt,
	today,
	type WmemConfig,
	Workspace,
} from "@wierd-memory/core";

const MINUTE = 60_000;
/** Note titles shown per other project (for duplicates across projects). */
const OTHER_PROJECT_TITLES = 60;
/** Size of the list of a project's docs given to the curator. */
const REPO_DOCS_CHARS = 4000;

/** The models, as the dream needs them (pi's registry in production, a script in tests). */
export interface DreamLlm {
	readonly usage: Partial<Record<Stage, StageUsage>>;
	totalCost(): number;
	json<T>(stage: Stage, spec: StageModel, system: string, user: string, validate: (v: unknown) => T, opts: { maxTokens: number; timeoutMs: number }): Promise<T>;
}

/** The server, as the dream needs it. */
export interface DreamApi {
	workspace(runId: string): Promise<DreamWorkspace>;
	submit(sub: DreamSubmit): Promise<DreamSubmitResult>;
}

export interface RunArgs {
	runId?: string;
	mode?: "run" | "review" | "dry" | "reindex";
	sinceDays?: number;
	maxSessions?: number;
}

export function parseRunArgs(args: string): RunArgs {
	const t = args.trim().split(/\s+/).filter(Boolean);
	const o: RunArgs = {};
	for (let i = 0; i < t.length; i++) {
		const a = t[i];
		if (a === "--run-id") o.runId = t[++i];
		else if (a === "--dry-run" || a === "--dry") o.mode = "dry";
		else if (a === "--reindex") o.mode = "reindex";
		else if (a === "--review-only") o.mode = "review";
		else if (a === "--since") o.sinceDays = Number(t[++i]);
		else if (a === "--max") o.maxSessions = Number(t[++i]);
	}
	if (o.sinceDays !== undefined && !Number.isFinite(o.sinceDays)) delete o.sinceDays;
	if (o.maxSessions !== undefined && !(o.maxSessions > 0)) delete o.maxSessions;
	return o;
}

// ── digests ──────────────────────────────────────────────────────────────

/** Bump when the digest format or its record changes: every digest is rebuilt. */
export const DIGEST_VERSION = 3;

export interface DigestRecord {
	v?: number;
	size: number;
	mtimeMs: number;
	sessionId: string;
	/** Project of the session's cwd. */
	projectKey: string;
	/** Root of that project (repo root or cwd). */
	root?: string;
	/** The root is a real project (git repo or project markers). */
	project?: boolean;
	dir: string;
	cwd: string;
	started: string;
	name?: string;
	userMessages: number;
	toolCalls: number;
	/** Paths the session worked with, most used first. */
	paths?: Array<[string, number]>;
	error?: string;
}

export type DigestIndex = Record<string, DigestRecord>;

export function loadDigestIndex(path: string): DigestIndex {
	try {
		return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as DigestIndex) : {};
	} catch {
		return {};
	}
}

function saveJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`, "utf-8");
}

export function digestFile(P: HomePaths, rec: Pick<DigestRecord, "dir" | "sessionId">): string {
	return join(P.digests, rec.dir, `${rec.sessionId}.txt`);
}

/** Project roots known from every session's cwd (existing ones only). */
export function knownProjects(digests: DigestIndex): ProjectMap {
	const byRoot = new Map<string, { key: string; project: boolean }>();
	for (const rec of Object.values(digests)) if (rec.root && rec.projectKey && !byRoot.has(rec.root)) byRoot.set(rec.root, { key: rec.projectKey, project: rec.project === true });
	return new ProjectMap([...byRoot.entries()].filter(([r]) => existsSync(r)).map(([root, v]) => ({ root, key: v.key, project: v.project })));
}

export async function updateDigests(files: SessionFile[], P: HomePaths, log: (m: string) => void, signal: AbortSignal): Promise<DigestIndex> {
	const idx = loadDigestIndex(P.digestIndex);
	const live = new Set(files.map((f) => f.path));
	for (const [k, rec] of Object.entries(idx)) {
		if (live.has(k)) continue;
		if (rec.dir) rmSync(digestFile(P, rec), { force: true });
		delete idx[k];
	}
	// Each folder is asked once per refresh, now: a folder that got a git remote since has another key.
	const asked = new Map<string, Promise<ProjectInfo>>();
	const ask = (dir: string) => {
		let p = asked.get(dir);
		if (!p) asked.set(dir, (p = resolveProject(dir, 0)));
		return p;
	};
	// A folder that is gone says nothing about its project: then the root the session was filed under speaks for it.
	const projectOf = async (cwd: string, root?: string) => {
		const p = await ask(cwd);
		if (p.exists || !root || root === cwd) return p;
		const r = await ask(root);
		return r.exists ? r : p;
	};
	// A digest filed under a key its folder no longer has is rebuilt under the current one.
	const rekeyed = new Set<string>();
	await pool(
		files.filter((f) => idx[f.path]?.cwd && idx[f.path]?.dir),
		8,
		async (f) => {
			const rec = idx[f.path];
			const proj = await projectOf(rec.cwd, rec.root);
			if (proj.exists && proj.key !== rec.projectKey) rekeyed.add(f.path);
		},
	);
	if (rekeyed.size) log(`digests: ${rekeyed.size} session(s) belong to another project key now`);
	const stale = files.filter((f) => idx[f.path]?.size !== f.size || idx[f.path]?.v !== DIGEST_VERSION || rekeyed.has(f.path));
	if (stale.length) log(`digests: rebuilding ${stale.length} of ${files.length} sessions`);
	/** Folders a digest moved out of: one left empty goes (search lists them as projects). */
	const left = new Set<string>();
	let n = 0;
	for (const f of stale) {
		if (signal.aborted) break;
		try {
			const s = await parseSession(f.path);
			if (!s) {
				idx[f.path] = { v: DIGEST_VERSION, size: f.size, mtimeMs: f.mtimeMs, sessionId: sessionIdFromPath(f.path), projectKey: "", dir: "", cwd: "", started: "", userMessages: 0, toolCalls: 0, error: "no header" };
				continue;
			}
			const prev = idx[f.path];
			const proj = await projectOf(s.header.cwd, prev?.cwd === s.header.cwd ? prev.root : undefined);
			const d = buildDigest(s);
			const dir = keyToDir(proj.key);
			if (prev?.dir && prev.dir !== dir) {
				rmSync(digestFile(P, prev), { force: true });
				left.add(prev.dir);
			}
			const rec: DigestRecord = {
				v: DIGEST_VERSION,
				size: f.size,
				mtimeMs: f.mtimeMs,
				sessionId: s.header.id,
				projectKey: proj.key,
				root: proj.exists ? proj.root : undefined,
				project: proj.project,
				dir,
				cwd: s.header.cwd,
				started: s.header.timestamp,
				name: s.name,
				userMessages: d.meta.userMessages,
				toolCalls: d.meta.toolCalls,
				paths: d.meta.paths,
			};
			mkdirSync(join(P.digests, dir), { recursive: true });
			writeFileSync(digestFile(P, rec), `${digestHeader(d.meta, proj.key)}\n${renderDigest(d)}\n`, "utf-8");
			idx[f.path] = rec;
		} catch (err) {
			log(`  ! digest ${f.path}: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (++n % 200 === 0) {
			saveJson(P.digestIndex, idx);
			log(`  digests ${n}/${stale.length}`);
		}
	}
	saveJson(P.digestIndex, idx);
	for (const dir of left) {
		try {
			rmdirSync(join(P.digests, dir));
		} catch {
			// not empty: other sessions are still filed there
		}
	}
	return idx;
}

// ── cards ────────────────────────────────────────────────────────────────

export interface Learning {
	n: string;
	kind: string;
	scope: "global" | "project";
	statement: string;
	details?: string;
	evidence: string[];
	source: "user" | "observed";
	confidence: string;
	why?: string;
}

export interface Card {
	sessionId: string;
	file: string;
	size: number;
	projectKey: string;
	date: string;
	title: string;
	summary: string;
	outcome: { status: string; signals: string[] };
	feedback: Array<{ entry: string; kind: string; quote: string }>;
	learnings: Learning[];
	memoryFeedback: Array<{ id: string; effect: string; entry?: string; note?: string }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const s = (v: unknown, max = 2000): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function validateCard(raw: unknown, ids: Set<string>, base: Pick<Card, "sessionId" | "file" | "size" | "projectKey" | "date">, fallbackTitle: string): Card {
	if (!isObj(raw)) throw new Error("expected a JSON object");
	const cleanId = (x: unknown) => s(x, 80).replace(/^\[|\]$/g, "");
	const outcome = isObj(raw.outcome) ? raw.outcome : {};
	const learnings: Learning[] = [];
	(Array.isArray(raw.learnings) ? raw.learnings : []).forEach((l) => {
		if (!isObj(l) || !s(l.statement)) return;
		const evidence = (Array.isArray(l.evidence) ? l.evidence : []).map(cleanId).filter((id) => ids.has(id));
		if (!evidence.length) return;
		learnings.push({
			n: `L${learnings.length + 1}`,
			kind: s(l.kind, 30) || "fact",
			scope: l.scope === "global" ? "global" : "project",
			statement: s(l.statement, 600),
			details: s(l.details, 1500) || undefined,
			evidence,
			source: l.source === "user" ? "user" : "observed",
			confidence: s(l.confidence, 10) || "medium",
			why: s(l.why, 400) || undefined,
		});
	});
	return {
		...base,
		title: s(raw.title, 120) || fallbackTitle,
		summary: s(raw.summary, 800),
		outcome: { status: s(outcome.status, 20) || "unclear", signals: (Array.isArray(outcome.signals) ? outcome.signals : []).map((x) => s(x, 300)).filter(Boolean) },
		feedback: (Array.isArray(raw.feedback) ? raw.feedback : [])
			.filter(isObj)
			.map((f) => ({ entry: cleanId(f.entry), kind: s(f.kind, 20), quote: s(f.quote, 400) }))
			.filter((f) => ids.has(f.entry) && f.quote),
		learnings,
		memoryFeedback: (Array.isArray(raw.memory_feedback) ? raw.memory_feedback : [])
			.filter(isObj)
			.map((f) => ({ id: s(f.id, 20), effect: s(f.effect, 10), entry: cleanId(f.entry) || undefined, note: s(f.note, 300) || undefined }))
			.filter((f) => /^m-[0-9a-f]{6,12}$/.test(f.id) && ["helpful", "harmful", "stale"].includes(f.effect)),
	};
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
	return out;
}

// ── evidence & verification ──────────────────────────────────────────────

interface EvidenceDeps {
	sessions: SessionCache;
	fileBySession: Map<string, string>;
	inboxById: Map<string, InboxItem>;
	comments: Map<string, ReviewComment>;
}

interface Resolved {
	op: Op;
	evidence: Evidence[];
	excerpts: string;
	error?: string;
	/** supersede / deprecate: the old note's evidence that is newer than this op's. */
	newer?: NewerEvidence;
}

function findSessionFile(deps: EvidenceDeps, id: string): string | undefined {
	const hit = deps.fileBySession.get(id);
	if (hit || id.length < 8) return hit;
	for (const [sid, file] of deps.fileBySession) if (sid.startsWith(id)) return file;
	return undefined;
}

async function resolveOp(op: Op, deps: EvidenceDeps): Promise<Resolved> {
	if (!op.evidence.length) return { op, evidence: [], excerpts: "", error: "no evidence cited" };
	return { op, ...(await resolveRefs(op.evidence, deps)) };
}

/** Look cited entries up in the raw sessions: stored evidence (with times) and transcript excerpts. */
async function resolveRefs(refs: EvidenceRef[], deps: EvidenceDeps): Promise<{ evidence: Evidence[]; excerpts: string; error?: string }> {
	const evidence: Evidence[] = [];
	const parts: string[] = [];
	const fail = (error: string) => ({ evidence, excerpts: "", error });
	for (const ref of refs) {
		if (ref.s.startsWith("inbox:")) {
			const item = deps.inboxById.get(ref.s.slice(6));
			if (!item) return fail(`unknown inbox item ${ref.s}`);
			const who = item.source === "user" ? "written by the user (/remember)" : "saved by the agent with memory_inbox";
			parts.push(`--- ${ref.s} (${who}, ${item.ts}, cwd ${item.cwd}) ---`, item.text);
			if (item.sessionFile && item.entryId && existsSync(item.sessionFile)) {
				const sess = await deps.sessions.get(item.sessionFile);
				const i = sess?.branch.findIndex((e) => e.id === item.entryId) ?? -1;
				if (sess && i >= 0) {
					parts.push("(session context before the item was saved)");
					for (let k = Math.max(0, i - 5); k <= i; k++) parts.push(renderEntryFull(sess.branch[k], 1200));
				}
			}
			evidence.push({ s: ref.s, e: [], date: item.ts.slice(0, 10), at: isoMinute(item.ts), kind: item.source === "user" ? "user" : "inbox" });
			continue;
		}
		if (ref.s.startsWith("comment:")) {
			const comment = deps.comments.get(ref.s.slice(8));
			if (!comment) return fail(`unknown review comment ${ref.s}`);
			parts.push(`--- review comment ${comment.id} by ${comment.author} (${comment.at}) ---`, comment.body);
			evidence.push({ s: ref.s, e: [], date: comment.at.slice(0, 10), at: isoMinute(comment.at), kind: "reviewer" });
			continue;
		}
		const file = findSessionFile(deps, ref.s);
		if (!file) return fail(`unknown session ${ref.s}`);
		const sess = await deps.sessions.get(file);
		if (!sess) return fail(`unreadable session ${ref.s}`);
		if (!ref.e.length) return fail(`no entry ids for session ${ref.s.slice(0, 8)}`);
		const pos = new Map(sess.branch.map((e, i) => [e.id, i]));
		const shown = new Set<number>();
		let isUser = false;
		let date: string | undefined;
		let latest: string | undefined;
		parts.push(`--- session ${sess.header.id} (started ${isoMinute(sess.header.timestamp) ?? "?"}, cwd ${sess.header.cwd}) ---`);
		for (const id of ref.e) {
			const i = pos.get(id);
			if (i === undefined) return fail(`entry ${id} is not in session ${ref.s.slice(0, 8)}`);
			const e = sess.branch[i];
			const isUserEntry = e.message?.role === "user";
			for (let k = Math.max(0, i - (isUserEntry ? 2 : 1)); k <= i; k++) {
				if (shown.has(k)) continue;
				shown.add(k);
				parts.push(renderEntryFull(sess.branch[k], k === i ? 4000 : 1500));
			}
			if (isUserEntry) isUser = true;
			date ??= e.timestamp?.slice(0, 10);
			if (e.timestamp && (!latest || Date.parse(e.timestamp) > Date.parse(latest))) latest = e.timestamp;
		}
		evidence.push({ s: sess.header.id, e: [...new Set(ref.e)], date: date ?? sess.header.timestamp.slice(0, 10), at: isoMinute(latest ?? sess.header.timestamp), kind: isUser ? "user" : "observed" });
	}
	return { evidence, excerpts: clipHead(parts.join("\n"), 16_000) };
}

type StartOf = (sessionId: string) => string | undefined;

/** The latest time among `evidence`, in ms. */
function latestTime(evidence: Evidence[], startOf: StartOf): number | undefined {
	let out: number | undefined;
	for (const e of evidence) {
		const t = evidenceTime(e, startOf);
		if (t !== undefined && (out === undefined || t > out)) out = t;
	}
	return out;
}

/** Evidence of an existing note observed after the evidence of an operation on it. */
interface NewerEvidence {
	evidence: Evidence[];
	excerpts: string;
}

/**
 * Before a note is superseded or deprecated: its evidence that is newer than
 * the operation's own. Newer sessions still saw the note hold — and a hand
 * edit or a review decision by the user after that time says so outright — so
 * the fact checker gets it and the reviewer gets a warning.
 */
async function newerNoteEvidence(note: Note, opEvidence: Evidence[], deps: EvidenceDeps, startOf: StartOf): Promise<NewerEvidence | undefined> {
	const since = latestTime(opEvidence, startOf);
	if (since === undefined) return undefined;
	const newer: Array<{ e: Evidence; t: number; excerpts: string }> = [];
	for (const old of note.evidence) {
		// The user's own word: a hand edit, an edit before accepting, a review comment a dream applied.
		if (old.s === "manual" || old.s === "review" || old.s.startsWith("comment:")) {
			const what = old.s === "manual" ? "the user edited this note by hand" : old.s.startsWith("comment:") ? "the note was changed on the user's review comment" : "the user edited this note before accepting it";
			const t = evidenceTime(old, startOf);
			if (t !== undefined && t > since) newer.push({ e: old, t, excerpts: `--- ${what} at ${old.at ?? old.date ?? "?"} ---` });
			continue;
		}
		const got = old.e.length || old.s.startsWith("inbox:") ? await resolveRefs([{ s: old.s, e: old.e }], deps) : undefined;
		const e = got && !got.error && got.evidence[0] ? { ...old, at: got.evidence[0].at ?? old.at } : old;
		const t = evidenceTime(e, startOf);
		if (t !== undefined && t > since) newer.push({ e, t, excerpts: got && !got.error ? got.excerpts : "" });
	}
	if (!newer.length) return undefined;
	newer.sort((a, b) => b.t - a.t);
	return {
		evidence: newer.map((n) => ({ ...n.e, at: n.e.at ?? isoMinute(n.t) })),
		excerpts: clipHead(
			newer
				.slice(0, 3)
				.map((n) => clipHead(n.excerpts, 5000))
				.filter(Boolean)
				.join("\n"),
			14_000,
		),
	};
}

interface Verdict {
	ref: string;
	verdict: "supported" | "partial" | "unsupported" | "contradicted";
	unsafe: boolean;
	reason: string;
	fix?: { title?: string; body?: string; scope?: string };
}

export function validateVerdicts(raw: unknown): Verdict[] {
	if (!isObj(raw) || !Array.isArray(raw.verdicts)) throw new Error('expected {"verdicts": [...]}');
	const kinds = ["supported", "partial", "unsupported", "contradicted"];
	return raw.verdicts.filter(isObj).flatMap((v) => {
		const verdict = s(v.verdict, 20);
		if (!s(v.ref, 40) || !kinds.includes(verdict)) return [];
		const scope = s(v.fix && isObj(v.fix) ? v.fix.scope : undefined, 200);
		const fix = isObj(v.fix) ? { title: s(v.fix.title, 300) || undefined, body: s(v.fix.body, 4000) || undefined, scope: scope === "global" || scope === "project" || scope.startsWith("project:") ? scope : undefined } : undefined;
		return [{ ref: s(v.ref, 40), verdict: verdict as Verdict["verdict"], unsafe: v.unsafe === true, reason: s(v.reason, 600), fix }];
	});
}

/** Where a note's evidence comes from and when it was observed, newest first. */
function evidenceForPrompt(evidence: Evidence[], startOf?: StartOf, max = 6) {
	return evidence
		.map((e) => ({ e, t: evidenceTime(e, startOf) }))
		.sort((a, b) => (b.t ?? 0) - (a.t ?? 0))
		.slice(0, max)
		.map(({ e, t }) => ({
			s: isSessionEvidence(e) ? e.s.slice(0, 8) : e.s,
			at: (t !== undefined ? isoMinute(t) : undefined) ?? e.date ?? "?",
			...(e.kind ? { kind: e.kind } : {}),
		}));
}

function noteForPrompt(n: Note, startOf?: StartOf) {
	return {
		id: n.id,
		type: n.type,
		index: n.index,
		title: n.title,
		...(n.when ? { when: n.when } : {}),
		body: clipHead(n.body, 700),
		evidence_count: n.evidence.length,
		evidence: evidenceForPrompt(n.evidence, startOf),
		updated: n.updated,
		...(n.pinned ? { pinned: true } : {}),
		...(n.enabled ? {} : { off: true }),
		...(n.stats && (n.stats.helpful || n.stats.harmful) ? { stats: n.stats } : {}),
	};
}

function opTitle(op: Op): string {
	switch (op.op) {
		case "add":
			return op.title;
		case "update":
			return op.title ?? op.id;
		case "supersede":
			return op.replacement.title;
		case "skill":
			return op.name;
		case "agents_md":
			return `AGENTS.md (${op.edits.length} edit(s))`;
		default:
			return op.id;
	}
}

function proposalForCheck(op: Op, ws: Workspace, startOf?: StartOf) {
	const current = "id" in op ? ws.find(op.id) : undefined;
	const base = { ref: op.ref, op: op.op, rationale: op.rationale, ...(current ? { current_note: noteForPrompt(current, startOf) } : {}) };
	switch (op.op) {
		case "add":
			return { ...base, scope: op.scope, proposal: { type: op.type, title: op.title, body: op.body, when: op.when, index: op.index } };
		case "update":
			return { ...base, ...(op.scope ? { scope: op.scope } : {}), proposal: { type: op.type, title: op.title, body: op.body, when: op.when, index: op.index } };
		case "supersede":
			return { ...base, proposal: op.replacement };
		case "skill":
			return { ...base, scope: op.scope, proposal: { name: op.name, description: op.description, body: op.body } };
		case "agents_md":
			return { ...base, proposal: { edits: op.edits } };
		default:
			return base;
	}
}

async function verifyOps(
	items: Resolved[],
	ws: Workspace,
	llm: DreamLlm,
	cfg: WmemConfig,
	prompt: string,
	save: (name: string, v: unknown) => void,
	tag: string,
	scopes: { project: string; other_projects: string[] },
	startOf: StartOf,
) {
	const verdicts = new Map<string, Verdict>();
	const batches: Resolved[][] = [];
	let cur: Resolved[] = [];
	let size = 0;
	for (const r of items) {
		const sz = r.excerpts.length + (r.newer?.excerpts.length ?? 0) + 1500;
		if (cur.length && (cur.length >= 10 || size + sz > 110_000)) {
			batches.push(cur);
			cur = [];
			size = 0;
		}
		cur.push(r);
		size += sz;
	}
	if (cur.length) batches.push(cur);
	for (const [i, batch] of batches.entries()) {
		const input = {
			scopes,
			proposals: batch.map((r) => ({
				...proposalForCheck(r.op, ws, startOf),
				evidence: evidenceForPrompt(r.evidence, startOf),
				excerpts: r.excerpts,
				...(r.newer ? { newer_note_evidence: evidenceForPrompt(r.newer.evidence, startOf), newer_note_excerpts: r.newer.excerpts || "(transcripts not available)" } : {}),
			})),
		};
		const out = await llm.json("verify", cfg.models.verify, prompt, JSON.stringify(input, null, 1), validateVerdicts, { maxTokens: 32_000, timeoutMs: 12 * MINUTE });
		save(`verify-${tag}-${i + 1}.json`, { input, out });
		for (const v of out) verdicts.set(v.ref, v);
	}
	return verdicts;
}

function decide(v: Verdict | undefined): { apply: boolean; fix?: Verdict["fix"]; reason: string } {
	if (!v) return { apply: false, reason: "no verdict from the fact check" };
	if (v.unsafe) return { apply: false, reason: `unsafe — ${v.reason}` };
	if (v.verdict === "supported") return { apply: true, reason: v.reason };
	if (v.verdict === "partial" && (v.fix?.title || v.fix?.body || v.fix?.scope)) return { apply: true, fix: v.fix, reason: v.reason };
	return { apply: false, reason: `${v.verdict} — ${v.reason}` };
}

// ── report items ─────────────────────────────────────────────────────────

/** A change this dream applied, with what the report says about it. */
interface ReportChange extends Change {
	rationale: string;
	evidence: Evidence[];
	source: "curator" | "reviewer";
	verdict?: { verdict: string; reason: string; corrected: boolean };
	newerEvidence?: Evidence[];
}

function itemFromChange(c: ReportChange, find: (id: string) => Note | undefined, titleBefore: (id: string) => string | undefined): ReportItem {
	const n = find(c.newId ?? c.noteId ?? "");
	const replaced = c.kind === "superseded" && c.noteId ? find(c.noteId) : undefined;
	return {
		kind: c.kind,
		scope: n?.scope ?? c.scope,
		id: c.newId ?? c.noteId,
		title: n?.title ?? c.title,
		body: n?.body,
		index: n?.index,
		when: n?.when,
		old: replaced ? { id: replaced.id, title: titleBefore(replaced.id) ?? replaced.title } : c.oldTitle ? { title: c.oldTitle } : undefined,
		from: c.from,
		evidence: c.evidence,
		why: c.rationale ? [c.rationale] : [],
		check: c.verdict,
		reviewer: c.source === "reviewer" || undefined,
		risky: n && c.kind !== "removed" && c.kind !== "deprecated" ? findRisky(`${n.title}\n${n.body}`) : [],
		newerEvidence: c.newerEvidence,
		note: c.note,
	};
}

// ── the dream ────────────────────────────────────────────────────────────

export interface DreamDeps {
	api: DreamApi;
	llm: DreamLlm;
	log: (m: string) => void;
	signal: AbortSignal;
}

export interface DreamOutcome {
	status: "ok" | "noop";
	result?: DreamSubmitResult;
	sessions: number;
	cost: number;
}

function emptyReport(runId: string, cfg: WmemConfig): ReportData {
	return {
		runId,
		date: today(),
		language: cfg.language,
		models: { cards: cfg.models.cards.model, analyze: cfg.models.analyze.model, verify: cfg.models.verify.model },
		usage: {},
		sessions: [],
		sessionTitles: {},
		inbox: 0,
		feedback: 0,
		unhandled: [],
		items: [],
		rejected: [],
		agents: [],
		indexes: [],
		votes: 0,
		problems: [],
		scopeTitles: { [GLOBAL_SCOPE]: "global" },
	};
}

export async function dream(runId: string, deps: DreamDeps): Promise<DreamOutcome> {
	const { api, llm, log, signal } = deps;
	const w = await api.workspace(runId);
	const cfg = w.config;
	const P = homePaths(w.home, cfg.memory.dir);
	const kind = w.kind;
	const date = today();
	const runDir = join(P.runs, runId);
	mkdirSync(runDir, { recursive: true });
	const save = (name: string, v: unknown) => saveJson(join(runDir, name), v);
	const problems: string[] = [];
	const maxNewNotes = cfg.dream.maxNewNotesPerPass;
	const prompt = (name: "cards" | "curator" | "review" | "verify", vars: { charter?: string } = {}) =>
		systemPrompt(name, { language: cfg.language, charter: vars.charter, globalBudget: cfg.budgets.globalTokens, projectBudget: cfg.budgets.projectTokens, maxNewNotes }, w.prompts[name]);
	const blank = (): DreamSubmit => ({ runId, status: "noop", changes: { notes: [], removed: [], scopes: [], skills: [] }, votes: {}, report: emptyReport(runId, cfg), marks: {}, inboxDone: [], commentsDone: [], agents: [], sessions: 0, cost: 0 });
	log(`dream ${runId} (${kind}) — ${w.notes.length} notes, ${w.inbox.length} inbox item(s)${w.pending.length ? `, ${w.pending.length} proposed note(s) not decided yet` : ""}`);

	// 2. digests
	const files = listSessionFiles();
	const digests = await updateDigests(files, P, log, signal);
	const feedback: ReviewComment[] = w.comments ?? [];
	if (feedback.length) log(`${feedback.length} review comment(s) to apply`);
	if (kind === "reindex") return { status: "noop", result: await api.submit(blank()), sessions: 0, cost: 0 };
	if (kind === "review" && !feedback.length) {
		log("review only: no new review comments");
		return { status: "noop", result: await api.submit(blank()), sessions: 0, cost: 0 };
	}
	const fileBySession = new Map<string, string>();
	for (const [file, rec] of Object.entries(digests)) if (rec.sessionId) fileBySession.set(rec.sessionId, file);
	const startOf: StartOf = (id) => {
		const file = fileBySession.get(id);
		return (file && digests[file]?.started) || undefined;
	};
	const projects = knownProjects(digests);
	const primaryOf = (rec: DigestRecord | undefined) => (rec ? projects.primary(rec.projectKey, rec.paths ?? []) : undefined);

	// 3. cards
	const now = Date.now();
	const pending = kind === "review" ? [] : pendingSessions(files, { cutoffMs: w.state.cutoffMs, sessions: w.state.sessions }, cfg, now).slice(0, w.opts.maxSessions ?? cfg.dream.maxSessionsPerRun);
	const inbox = kind === "review" ? [] : w.inbox;
	log(`${pending.length} session(s) to summarize, ${inbox.length} inbox item(s)`);
	const sessions = new SessionCache(cfg.dream.concurrency * 2);
	const marks: Record<string, SessionMark> = {};
	const cardsSystem = prompt("cards");
	mkdirSync(P.cards, { recursive: true });
	const cards = (
		await pool(pending, cfg.dream.concurrency, async (f): Promise<Card | undefined> => {
			const rec = digests[f.path];
			const mark = (ok: boolean) => {
				const prev = w.state.sessions[f.path];
				marks[f.path] = { size: f.size, mtimeMs: f.mtimeMs, at: new Date().toISOString(), ok, failures: ok ? 0 : (prev?.size === f.size ? (prev.failures ?? 0) : 0) + 1 };
			};
			if (!rec || rec.error || rec.userMessages === 0) {
				mark(true);
				return undefined;
			}
			const cachePath = join(P.cards, `${rec.sessionId}.json`);
			try {
				if (existsSync(cachePath)) {
					const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as Card;
					if (cached.size === f.size) {
						mark(true);
						// The session's project is what its digest says now (the folder may have got a git remote since).
						return { ...cached, projectKey: rec.projectKey };
					}
				}
				if (signal.aborted) throw new Error("dream aborted (time limit)");
				const sess = await sessions.get(f.path);
				if (!sess) throw new Error("unreadable session");
				const d = buildDigest(sess);
				const ids = new Set(d.lines.map((l) => l.id));
				const user = `${digestHeader(d.meta, rec.projectKey)}\n\n${renderDigest(d, 160_000)}`;
				const base = { sessionId: rec.sessionId, file: f.path, size: f.size, projectKey: rec.projectKey, date: (rec.started || "").slice(0, 10) };
				const card = await llm.json("cards", cfg.models.cards, cardsSystem, user, (raw) => validateCard(raw, ids, base, rec.name ?? ""), { maxTokens: 16_000, timeoutMs: 6 * MINUTE });
				saveJson(cachePath, card);
				mark(true);
				log(`  card ${rec.sessionId.slice(0, 8)} ${shortKey(rec.projectKey)}: ${card.title} — ${card.learnings.length} learning(s)`);
				return card;
			} catch (err) {
				mark(false);
				log(`  ! card ${rec.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
				return undefined;
			}
		})
	).filter((c): c is Card => !!c);
	save("cards.json", cards);

	// The notes this dream works on: approved memory plus what is still proposed.
	const ws = new Workspace(w.notes, date, { pending: w.pending, scopes: w.scopes });
	// What the curator may withdraw without evidence: proposals nothing has approved yet.
	const pendingMark = (id: string) => (ws.pending.has(id) ? { pending: true } : {});
	const titleAtStart = new Map(w.notes.map((n) => [n.id, n.title]));
	const changes: ReportChange[] = [];
	const rejected: ReportRejected[] = [];
	const unhandled: Array<{ comment: string; reason: string }> = [];
	const agentsOps: Array<{ key: string; repoRoot: string; rel: string; op: AgentsMdOp }> = [];
	const scopeTitles: Record<string, string> = { [GLOBAL_SCOPE]: "global" };
	for (const sc of w.scopes) if (sc.key) scopeTitles[sc.id] = sc.key;
	const charterOf = new Map(w.scopes.map((sc) => [sc.id, sc.charter?.trim() || ""]));
	const globalCharter = charterOf.get(GLOBAL_SCOPE) || DEFAULT_GLOBAL_CHARTER;
	const defaultProjectCharter = w.prompts.project_charter?.trim() || DEFAULT_PROJECT_CHARTER;
	const edeps: EvidenceDeps = { sessions, fileBySession, inboxById: new Map(inbox.map((i) => [i.id, i])), comments: new Map(feedback.map((c) => [c.id, c])) };

	// 4. review pass
	if (feedback.length) {
		const input = {
			comments: feedback.map((c) => ({ id: c.id, author: c.author, at: c.at, ...(c.noteId ? { note: c.noteId } : {}), body: c.body })),
			scopes: Object.fromEntries(
				[...ws.notes].map(([sc, ns]) => [
					sc,
					{ title: scopeTitles[sc] ?? sc, notes: ns.filter((n) => n.status === "active").map((n) => ({ ...noteForPrompt(n, startOf), ...pendingMark(n.id) })) },
				]),
			),
		};
		const parsed = await llm.json<ParsedOps>("analyze", cfg.models.analyze, prompt("review"), JSON.stringify(input, null, 1), parseOps, { maxTokens: 48_000, timeoutMs: 15 * MINUTE });
		save("review.json", { input, parsed });
		problems.push(...parsed.problems.map((p) => `review: ${p}`));
		unhandled.push(...parsed.unhandled);
		// The comments an operation cites (`comment:<id>`).
		const commentsCited = (op: Op) => [...new Set(op.evidence.flatMap((r) => (r.s.startsWith("comment:") ? [r.s.slice(8)] : [])).filter((id) => edeps.comments.has(id)))];
		for (const op of parsed.ops) {
			if (op.op === "agents_md") {
				unhandled.push({ comment: commentsCited(op)[0] ?? "?", reason: "AGENTS.md changes from review comments are not supported" });
				continue;
			}
			// One piece of evidence per comment the operation is made on; one that cites none is made on them all.
			const cited = commentsCited(op);
			const evidence: Evidence[] = (cited.length ? cited : feedback.map((c) => c.id)).map((id) => ({ s: `comment:${id}`, e: [], date, at: isoMinute(Date.now()), kind: "reviewer" }));
			const res = applyOp(ws, op, { evidence });
			if (!res.ok) rejected.push({ ref: op.ref, op: op.op, title: opTitle(op), reason: res.reason });
			else changes.push({ ...res.change, rationale: op.rationale, evidence, source: "reviewer" });
		}
	}

	// 5. project passes
	// Sessions are grouped by the project they were about (not where pi was started).
	const primaryKey = (file: string, fallback: string) => primaryOf(digests[file])?.key ?? fallback;
	const groups = new Map<string, { cards: Card[]; inbox: InboxItem[] }>();
	const group = (key: string) => {
		let g = groups.get(key);
		if (!g) groups.set(key, (g = { cards: [], inbox: [] }));
		return g;
	};
	for (const c of cards) if (c.learnings.length || c.feedback.length || c.memoryFeedback.length) group(primaryKey(c.file, c.projectKey)).cards.push(c);
	for (const i of inbox) group(i.sessionFile ? primaryKey(i.sessionFile, i.projectKey) : i.projectKey).inbox.push(i);
	type HitMeta = { sessionId: string; projectKey: string; entryId?: string; date: string };
	let corpus: Bm25<HitMeta> | undefined;
	const history = (c: Card, l: Learning, passKey: string) => {
		if (!corpus) {
			const docs: Doc<HitMeta>[] = [];
			for (const [file, rec] of Object.entries(digests)) {
				if (!rec.dir || rec.userMessages === 0) continue;
				let text: string;
				try {
					text = readFileSync(digestFile(P, rec), "utf-8");
				} catch {
					continue;
				}
				const projectKey = primaryKey(file, rec.projectKey);
				for (const [k, ch] of chunkDigest(text).entries()) docs.push({ id: `${rec.sessionId}#${k}`, text: ch.text, meta: { sessionId: rec.sessionId, projectKey, entryId: ch.entryId, date: rec.started.slice(0, 10) } });
			}
			corpus = new Bm25(docs);
			log(`history corpus: ${docs.length} chunks`);
		}
		const query = `${l.statement} ${l.details ?? ""}`;
		return corpus
			.search(query, 3, (d) => d.meta.sessionId !== c.sessionId && (l.scope === "global" || d.meta.projectKey === passKey))
			.filter((h) => h.score > 2)
			.map((h) => ({ s: h.doc.meta.sessionId, e: h.doc.meta.entryId ? [h.doc.meta.entryId] : [], date: h.doc.meta.date, project: h.doc.meta.projectKey, snippet: snippet(h.doc.text, query, 360) }));
	};
	/** Projects of the sessions an op cites, and whether the user (or a deliberate inbox item) stands behind it. */
	const evidenceProjects = (ev: Evidence[]) => {
		const keys = new Set<string>();
		let explicit = false;
		for (const e of ev) {
			if (e.kind === "user" || e.kind === "inbox" || e.kind === "reviewer") explicit = true;
			const file = fileBySession.get(e.s);
			const key = file ? primaryKey(file, digests[file]?.projectKey ?? "") : "";
			if (key && projects.isProject(key)) keys.add(key);
		}
		return { keys, explicit };
	};
	const verifySystem = prompt("verify");
	const ordered = [...groups.entries()].sort((a, b) => b[1].cards.length + b[1].inbox.length - (a[1].cards.length + a[1].inbox.length));
	const votes: Array<{ id: string; effect: string }> = [];
	for (const [key, g] of ordered) {
		if (signal.aborted) throw new Error("dream aborted (time limit)");
		const scope = projectScope(key);
		const knownRoot = projects.rootOf(key)?.root;
		const proj = await resolveProject(knownRoot ?? (key.startsWith("local:") ? key.slice(6) : g.cards[0] ? (digests[g.cards[0].file]?.cwd ?? "") : (g.inbox[0]?.cwd ?? "")));
		ws.ensureScope(scope, { key, root: proj.root });
		scopeTitles[scope] = key;
		// Other projects these sessions worked in or that history ties the topic to.
		const candidates = new Map<string, Set<string>>();
		const addCandidate = (k: string, why: string) => {
			if (!k || k === key || !projects.isProject(k)) return;
			if (!candidates.has(k)) candidates.set(k, new Set());
			candidates.get(k)?.add(why);
		};
		const sessionInfo = new Map<string, { cwd: string; workspace: boolean; touched: Array<{ project: string; n: number }> }>();
		for (const c of g.cards) {
			const rec = digests[c.file];
			const p = primaryOf(rec);
			for (const t of p?.touched ?? []) addCandidate(t.key, "touched by these sessions");
			if (rec && !projects.isBroad(rec.projectKey)) addCandidate(rec.projectKey, "cwd of a session");
			sessionInfo.set(c.sessionId, { cwd: rec?.cwd ?? "", workspace: p?.workspace ?? false, touched: (p?.touched ?? []).slice(0, 5).map((t) => ({ project: t.key, n: t.n })) });
		}
		const sessionsInput = g.cards.map((c) => ({
			session: c.sessionId,
			date: c.date,
			started: isoMinute(digests[c.file]?.started) ?? c.date,
			...sessionInfo.get(c.sessionId),
			title: c.title,
			summary: c.summary,
			outcome: c.outcome,
			feedback: c.feedback,
			learnings: c.learnings.map((l) => {
				const hist = history(c, l, key);
				for (const h of hist) addCandidate(h.project, "history hits");
				return { ...l, history: hist };
			}),
			memory_feedback: c.memoryFeedback,
		}));
		const otherProjects = [...candidates.entries()].slice(0, 8).map(([k, why]) => {
			const sc = projectScope(k);
			ws.ensureScope(sc, { key: k, root: projects.rootOf(k)?.root });
			scopeTitles[sc] = k;
			const active = ws.scope(sc).filter((n) => n.status === "active" && n.enabled);
			// Titles are cheap and they are how the curator sees a duplicate in another project.
			return { scope: `project:${k}`, why: [...why], notes: active.slice(0, OTHER_PROJECT_TITLES).map((n) => ({ id: n.id, title: n.title, ...pendingMark(n.id) })) };
		});
		for (const c of g.cards) for (const f of c.memoryFeedback) votes.push({ id: f.id, effect: f.effect });
		const projectCharter = charterOf.get(scope) || defaultProjectCharter;
		const ctxFile = cfg.agentsMd && proj.exists ? findContextFile(proj.checkout ?? proj.root) : undefined;
		// One AGENTS.md proposal at a time: while one awaits review, do not stack another.
		const agentsWaiting = ctxFile ? w.agentsPending.some((a) => a.repoRoot === proj.root) || agentsOps.some((a) => a.repoRoot === proj.root) : false;
		const used = (sc: string, budget: number) => buildIndex(ws.scope(sc), sc, budget).tokens;
		// What the repository already documents (paths and headings): the curator only gets the context file whole.
		const docsRoot = proj.exists ? (proj.checkout ?? proj.root) : undefined;
		const repoDocs = docsRoot && existsSync(docsRoot) ? listRepoDocs(docsRoot, { maxChars: REPO_DOCS_CHARS, exclude: ctxFile ? [ctxFile.rel] : [] }) : [];
		const input = {
			project: { key, scope: "project", root: proj.root, ...(projects.isBroad(key) ? { workspace: true } : {}) },
			other_projects: otherProjects,
			budgets: {
				global: { budget: cfg.budgets.globalTokens, used: used(GLOBAL_SCOPE, cfg.budgets.globalTokens) },
				project: { budget: cfg.budgets.projectTokens, used: used(scope, cfg.budgets.projectTokens) },
			},
			notes: {
				global: ws.scope(GLOBAL_SCOPE).filter((n) => n.status === "active").map((n) => ({ ...noteForPrompt(n, startOf), ...pendingMark(n.id) })),
				project: ws.scope(scope).filter((n) => n.status === "active").map((n) => ({ ...noteForPrompt(n, startOf), ...pendingMark(n.id) })),
			},
			limits: { max_new_notes: maxNewNotes },
			sessions: sessionsInput,
			inbox: g.inbox.map((i) => ({ s: `inbox:${i.id}`, at: i.ts, source: i.source, kind: i.kind, scope: i.scope, text: i.text })),
			repo_docs: repoDocs.length ? repoDocs : null,
			context_file: ctxFile ? { path: ctxFile.rel, content: clipHead(readFileSync(ctxFile.path, "utf-8"), 40_000), ...(agentsWaiting ? { pending: true } : {}) } : null,
			rejected_before: w.state.rejected.slice(-40),
		};
		const charter = `Global: ${globalCharter}\n\nThis project (${key}): ${projectCharter}`;
		const tag = keyToDir(key).slice(0, 60);
		const parsed = await llm.json<ParsedOps>("analyze", cfg.models.analyze, prompt("curator", { charter }), JSON.stringify(input, null, 1), parseOps, { maxTokens: 64_000, timeoutMs: 20 * MINUTE });
		save(`curator-${tag}.json`, { input, parsed });
		problems.push(...parsed.problems.map((p) => `${shortKey(key)}: ${p}`));
		log(`curator ${shortKey(key)}: ${parsed.ops.length} op(s)`);
		if (!parsed.ops.length) continue;
		// Withdrawing an earlier dream's proposal removes only what nothing approved: the rationale is enough, no evidence or
		// fact check (which would drop it for want of evidence and leave the stale proposal to the user). Applied first, so
		// an add that replaces a withdrawn proposal is not merged into it as a duplicate.
		const toCheck: Op[] = [];
		for (const op of parsed.ops) {
			if (op.op !== "deprecate" || !ws.pending.has(op.id)) {
				toCheck.push(op);
				continue;
			}
			if (!op.rationale) {
				rejected.push({ ref: op.ref, op: op.op, title: opTitle(op), reason: "withdrawing a proposal needs a rationale" });
				continue;
			}
			// Evidence it cites is shown in the report when it resolves; it is not required.
			const cited = op.evidence.length ? await resolveRefs(op.evidence, edeps) : undefined;
			const evidence = cited && !cited.error ? cited.evidence : [];
			const res = applyOp(ws, op, { projectScope: scope, evidence });
			if (!res.ok) rejected.push({ ref: op.ref, op: op.op, title: opTitle(op), reason: res.reason });
			else changes.push({ ...res.change, note: "withdrawn: an earlier dream's proposal, never approved", rationale: op.rationale, evidence, source: "curator" });
		}
		// Fewer, stronger notes: the curator orders its ops by importance, adds past the limit are dropped before the check.
		let adds = 0;
		const capped = toCheck.filter((op) => {
			if (op.op !== "add" || ++adds <= maxNewNotes) return true;
			rejected.push({ ref: op.ref, op: op.op, title: opTitle(op), reason: `over the limit of ${maxNewNotes} new note(s) per curator pass (dream.maxNewNotesPerPass); the curator ranked it lower` });
			return false;
		});
		if (adds > maxNewNotes) log(`  ${adds - maxNewNotes} add(s) over the limit of ${maxNewNotes} dropped`);
		const resolved = await Promise.all(capped.map((op) => resolveOp(op, edeps)));
		for (const r of resolved.filter((x) => x.error)) rejected.push({ ref: r.op.ref, op: r.op.op, title: opTitle(r.op), reason: r.error ?? "" });
		const valid = resolved.filter((x) => !x.error);
		for (const r of valid) {
			if (r.op.op !== "supersede" && r.op.op !== "deprecate") continue;
			const old = ws.find(r.op.id);
			if (old) r.newer = await newerNoteEvidence(old, r.evidence, edeps, startOf);
			if (r.newer) log(`  ${r.op.ref} ${r.op.op} ${r.op.id}: the note has ${r.newer.evidence.length} newer evidence item(s)`);
		}
		const scopeChoices = { project: key, other_projects: otherProjects.map((o) => o.scope.slice(8)) };
		const verdicts = valid.length ? await verifyOps(valid, ws, llm, cfg, verifySystem, save, tag, scopeChoices, startOf) : new Map<string, Verdict>();
		for (const r of valid) {
			const v = verdicts.get(r.op.ref);
			const d = decide(v);
			if (!d.apply) {
				rejected.push({ ref: r.op.ref, op: r.op.op, title: opTitle(r.op), reason: d.reason });
				continue;
			}
			// Global only with the user behind it or evidence from more than one project.
			let guardNote: string | undefined;
			if ((r.op.op === "add" || r.op.op === "update") && (d.fix?.scope ?? r.op.scope) === "global") {
				const ep = evidenceProjects(r.evidence);
				if (!ep.explicit && ep.keys.size === 1) {
					const only = [...ep.keys][0];
					d.fix = { ...d.fix, scope: `project:${only}` };
					ws.ensureScope(projectScope(only), { key: only, root: projects.rootOf(only)?.root });
					scopeTitles[projectScope(only)] = only;
					guardNote = `global → ${shortKey(only)}: all evidence comes from this one project`;
				}
			}
			if (r.op.op === "agents_md") {
				if (!ctxFile) rejected.push({ ref: r.op.ref, op: r.op.op, title: opTitle(r.op), reason: "project has no context file" });
				else if (agentsWaiting) rejected.push({ ref: r.op.ref, op: r.op.op, title: opTitle(r.op), reason: "an AGENTS.md proposal for this project still waits for review" });
				else agentsOps.push({ key, repoRoot: proj.root, rel: ctxFile.rel, op: r.op });
				continue;
			}
			const res = applyOp(ws, r.op, { projectScope: scope, evidence: r.evidence, fix: d.fix });
			if (!res.ok) {
				rejected.push({ ref: r.op.ref, op: r.op.op, title: opTitle(r.op), reason: res.reason });
				continue;
			}
			changes.push({
				...res.change,
				note: [res.change.note, guardNote].filter(Boolean).join(" · ") || undefined,
				rationale: r.op.rationale,
				evidence: r.evidence,
				source: "curator",
				verdict: v ? { verdict: v.verdict, reason: v.reason, corrected: !!(d.fix?.title || d.fix?.body || (d.fix?.scope && !guardNote)) } : undefined,
				newerEvidence: r.newer?.evidence,
			});
		}
	}
	const voteDeltas = applyVotes(ws, votes);

	// AGENTS.md proposals: one per file, reviewed like the notes.
	const byRepo = new Map<string, { key: string; repoRoot: string; rel: string; edits: AgentsEdit[]; rationale: string[]; summaries: string[] }>();
	for (const a of agentsOps) {
		const k = `${a.repoRoot}::${a.rel}`;
		let entry = byRepo.get(k);
		if (!entry) byRepo.set(k, (entry = { key: a.key, repoRoot: a.repoRoot, rel: a.rel, edits: [], rationale: [], summaries: [] }));
		entry.edits.push(...a.op.edits);
		if (a.op.rationale) entry.rationale.push(a.op.rationale);
		if (a.op.summary) entry.summaries.push(a.op.summary);
	}
	const agentsReport: ReportAgents[] = [];
	const agents: DreamSubmit["agents"] = [];
	for (const e of byRepo.values()) {
		const summary = e.summaries.join("; ") || undefined;
		agentsReport.push({ project: e.key, rel: e.rel, title: summary, patch: renderEditsDiff(e.rel, e.edits), rationale: e.rationale });
		agents.push({ projectKey: e.key, repoRoot: e.repoRoot, rel: e.rel, summary, edits: e.edits, rationale: e.rationale });
	}

	// 6. the report
	const sessionTitles: Record<string, string> = {};
	for (const c of cards) sessionTitles[c.sessionId] = c.title;
	for (const rec of Object.values(digests)) if (rec.name && !sessionTitles[rec.sessionId]) sessionTitles[rec.sessionId] = rec.name;
	const reportSessions: ReportSession[] = cards.map((c) => {
		const primary = primaryKey(c.file, c.projectKey);
		return { sessionId: c.sessionId, date: c.date, project: primary === c.projectKey ? shortKey(primary) : `${shortKey(primary)} ← ${shortKey(c.projectKey)}`, title: c.title, outcome: c.outcome.status, learnings: c.learnings.length };
	});
	const items = changes.map((c) => itemFromChange(c, (id) => ws.find(id), (id) => titleAtStart.get(id)));
	// Only titles of sessions the report mentions (the map would otherwise hold every session ever).
	const mentioned = new Set<string>(reportSessions.map((x) => x.sessionId));
	for (const it of items) for (const e of [...it.evidence, ...(it.newerEvidence ?? [])]) mentioned.add(e.s);
	const wsChanges = ws.changes();
	for (const c of wsChanges.notes) for (const e of c.after.evidence) mentioned.add(e.s);
	const report: ReportData = {
		runId,
		date,
		language: cfg.language,
		models: { cards: cfg.models.cards.model, analyze: cfg.models.analyze.model, verify: cfg.models.verify.model },
		usage: llm.usage,
		sessions: reportSessions,
		sessionTitles: Object.fromEntries(Object.entries(sessionTitles).filter(([id]) => mentioned.has(id))),
		inbox: inbox.length,
		feedback: feedback.length,
		unhandled,
		items,
		rejected,
		agents: agentsReport,
		indexes: indexStats(ws.notes, cfg.budgets),
		votes: Object.keys(voteDeltas).length,
		problems,
		scopeTitles,
	};
	writeFileSync(join(runDir, "report.md"), renderReport(report), "utf-8");
	save("report.json", report);

	// 7. hand it in
	const unhandledBy = new Map(unhandled.map((u) => [u.comment, u.reason]));
	const changed = wsChanges.notes.length + wsChanges.removed.length + wsChanges.skills.length + agents.length > 0;
	const sub: DreamSubmit = {
		runId,
		status: changed ? "ok" : "noop",
		changes: wsChanges,
		votes: voteDeltas,
		report,
		marks,
		inboxDone: inbox.map((i) => i.id),
		commentsDone: feedback.map((c) => ({ id: c.id, ...(unhandledBy.has(c.id) ? { unhandled: unhandledBy.get(c.id) } : {}) })),
		agents,
		sessions: pending.length,
		cost: llm.totalCost(),
	};
	save("submit.json", { ...sub, report: undefined });
	const result = await api.submit(sub);
	log(`${changes.length} change(s) proposed, ${rejected.length} rejected by the checks${agents.length ? `, ${agents.length} AGENTS.md proposal(s)` : ""}`);
	return { status: sub.status, result, sessions: pending.length, cost: llm.totalCost() };
}

/** Append to the run's own log file as well as to stdout (which the server keeps). */
export function runLogger(runsDir: string, runId: string): (m: string) => void {
	const dir = join(runsDir, runId);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "log.txt");
	return (m: string) => {
		const line = `[${new Date().toISOString()}] ${m}`;
		console.log(line);
		try {
			appendFileSync(file, `${line}\n`);
		} catch {
			// the log on stdout is enough
		}
	};
}
