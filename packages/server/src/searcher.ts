/**
 * Search and reading: what backs `memory_search` and `memory_read`, the
 * search box of the web UI, and the "where it came from" part of a note.
 *
 * Notes are searched in the database (BM25, Russian + English); past sessions
 * in their digests (`~/.wierd-memory/digests`, rebuilt by dreams). Agents never
 * get notes the user turned off.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	Bm25,
	chunkDigest,
	clipHead,
	type Doc,
	type EvidenceInfo,
	type EvidenceRef,
	GLOBAL_SCOPE,
	isNoteId,
	keyToDir,
	type Note,
	parseSession,
	projectScope,
	renderEntryFull,
	resolveProject,
	type SearchResult,
	sessionsRoot,
	shortKey,
	snippet,
} from "@wierd-memory/core";
import type { App } from "./app.ts";
import { MAIN } from "./git.ts";

type DigestMeta = { sessionId: string; entryId?: string; dir: string };

export interface SearchOptions {
	query: string;
	scope?: "all" | "notes" | "sessions";
	projects?: "current" | "all";
	cwd?: string;
	limit?: number;
	/** The asking session: its own digest is not a result. */
	excludeSession?: string;
	/** Include notes the user turned off (the UI does, agents do not). */
	includeOff?: boolean;
}

const CLIP = 700;

export class Searcher {
	private noteIndex: { rev: number; bm: Bm25<Note> } | undefined;
	private digestIndex = new Map<string, { key: string; bm: Bm25<DigestMeta> }>();

	constructor(private app: App) {}

	private async noteBm(): Promise<Bm25<Note>> {
		if (!this.noteIndex || this.noteIndex.rev !== this.app.rev) {
			const notes = await this.app.mem.notes(MAIN);
			this.noteIndex = { rev: this.app.rev, bm: new Bm25(notes.map((n) => ({ id: n.id, text: `${n.title}\n${n.when ?? ""}\n${n.body}`, meta: n }))) };
		}
		return this.noteIndex.bm;
	}

	private digestBm(dir: string): Bm25<DigestMeta> | undefined {
		const full = join(this.app.paths.digests, dir);
		// A dream rewrites the digest index whenever it changed a digest (a grown session keeps its file name).
		let key: string;
		try {
			key = `${statSync(full).mtimeMs}:${existsSync(this.app.paths.digestIndex) ? statSync(this.app.paths.digestIndex).mtimeMs : 0}`;
		} catch {
			return undefined;
		}
		let cached = this.digestIndex.get(full);
		if (!cached || cached.key !== key) {
			const docs: Doc<DigestMeta>[] = [];
			for (const name of readdirSync(full)) {
				if (!name.endsWith(".txt")) continue;
				const sessionId = name.slice(0, -4);
				let text: string;
				try {
					text = readFileSync(join(full, name), "utf-8");
				} catch {
					continue;
				}
				for (const [k, ch] of chunkDigest(text).entries()) docs.push({ id: `${sessionId}#${k}`, text: ch.text, meta: { sessionId, entryId: ch.entryId, dir } });
			}
			cached = { key, bm: new Bm25(docs) };
			this.digestIndex.set(full, cached);
		}
		return cached.bm;
	}

	async search(o: SearchOptions): Promise<SearchResult> {
		const limit = Math.max(1, Math.min(o.limit ?? 6, 30));
		const scope = o.scope ?? "all";
		const projects = o.projects ?? "current";
		const proj = o.cwd ? await resolveProject(o.cwd) : undefined;
		const out: string[] = [];
		const result: SearchResult = { notes: [], sessions: [], text: "" };
		if (scope !== "sessions") {
			const scopes = await this.app.mem.scopes(MAIN);
			const mine = proj ? ((await this.app.context(o.cwd as string)).scope ?? projectScope(proj.key)) : undefined;
			const allowed = projects === "all" || !mine ? undefined : new Set([GLOBAL_SCOPE, mine]);
			const hits = (await this.noteBm()).search(o.query, limit, (d) => (o.includeOff || d.meta.enabled) && (!allowed || allowed.has(d.meta.scope)));
			out.push(`notes (${hits.length}):`);
			for (const h of hits) {
				const n = h.doc.meta;
				const name = this.app.scopeName(n.scope, scopes);
				result.notes.push({ id: n.id, scope: n.scope, scopeName: name, type: n.type, status: n.status, title: n.title, when: n.when, score: h.score });
				const st = n.status === "active" ? "" : ` [${n.status}]`;
				out.push(`- [${n.id}] (${n.scope === GLOBAL_SCOPE ? "global" : shortKey(n.scope)}, ${n.type})${st} ${n.title}${n.when ? ` — when: ${n.when}` : ""}`);
			}
		}
		if (scope !== "notes") {
			const root = this.app.paths.digests;
			const here = proj ? keyToDir(proj.key) : undefined;
			const dirs = projects === "all" || !here ? (existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []) : [here];
			let bm: Bm25<DigestMeta> | undefined;
			if (dirs.length === 1) bm = this.digestBm(dirs[0]);
			else {
				const docs: Doc<DigestMeta>[] = [];
				for (const d of dirs) docs.push(...(this.digestBm(d)?.docs ?? []));
				bm = new Bm25(docs);
			}
			const hits = (bm?.search(o.query, limit * 2) ?? []).filter((h) => h.doc.meta.sessionId !== o.excludeSession).slice(0, limit);
			out.push(`past sessions (${hits.length}${existsSync(this.app.paths.digestIndex) ? "" : " — no digests yet: the next dream builds them"}):`);
			for (const h of hits) {
				const ref = `s:${h.doc.meta.sessionId}#${h.doc.meta.entryId ?? ""}`;
				const snip = snippet(h.doc.text, o.query, 400);
				const isHere = h.doc.meta.dir === here;
				result.sessions.push({ ref, sessionId: h.doc.meta.sessionId, entryId: h.doc.meta.entryId, project: h.doc.meta.dir, here: isHere, snippet: snip, score: h.score });
				out.push(`- ${ref} (${isHere ? "this project" : h.doc.meta.dir})\n  ${snip.replace(/\n/g, "\n  ")}`);
			}
		}
		out.push("Open a note or a session reference with memory_read.");
		result.text = clipHead(out.join("\n"), 9000);
		return result;
	}

	/** `m-xxxxxx` → the note with its evidence; `s:<session>#<entry>` → that entry with the ones around it. */
	async read(ref: string): Promise<string> {
		const r = ref.trim();
		if (isNoteId(r)) {
			const note = await this.app.mem.note(r, MAIN);
			if (!note) return `No note ${r}.`;
			if (!note.enabled) return `Note ${r} was turned off by the user: do not rely on it.`;
			const ev = note.evidence
				.slice(-6)
				.map((e) => `${e.s.slice(0, 13)}${e.e.length ? `#${e.e.join(",")}` : ""} ${e.date ?? ""} ${e.kind ?? ""}`.trim())
				.join("; ");
			return [
				`[${note.id}] ${note.title}`,
				`type: ${note.type} · status: ${note.status}${note.validUntil ? ` (until ${note.validUntil})` : ""} · scope: ${note.scope === GLOBAL_SCOPE ? "global" : note.scope} · updated: ${note.updated}`,
				note.when ? `when: ${note.when}` : "",
				note.supersededBy ? `superseded by: ${note.supersededBy}` : "",
				"",
				note.body,
				"",
				`evidence (${note.evidence.length}): ${ev}`,
				"Evidence references can be opened as s:<session>#<entry>.",
			]
				.filter((l) => l !== "")
				.join("\n");
		}
		const m = /^s:([0-9a-zA-Z-]+)(?:#([0-9a-f-]+))?$/.exec(r);
		if (!m) return `Unknown reference "${r}". Use a note id (m-xxxxxx) or s:<sessionId>#<entryId>.`;
		const file = this.sessionFile(m[1]);
		if (!file) return `No session ${m[1]}.`;
		const s = await parseSession(file);
		if (!s) return `Unreadable session ${m[1]}.`;
		let i = m[2] ? s.branch.findIndex((e) => e.id === m[2]) : 0;
		if (i < 0) i = 0;
		const parts = [`session ${s.header.id} · ${s.header.timestamp.slice(0, 16)} · cwd ${s.header.cwd}${s.name ? ` · "${s.name}"` : ""}`];
		for (let k = Math.max(0, i - 3); k <= Math.min(s.branch.length - 1, i + 4); k++) parts.push(renderEntryFull(s.branch[k], 1500));
		return clipHead(parts.join("\n"), 9000);
	}

	private digestRecords(): Record<string, { sessionId: string }> {
		try {
			return JSON.parse(readFileSync(this.app.paths.digestIndex, "utf-8")) as Record<string, { sessionId: string }>;
		} catch {
			return {};
		}
	}

	/** The session file of a session id (or of a prefix of one, 8+ characters). */
	sessionFile(id: string, cwd?: string): string | undefined {
		for (const [file, rec] of Object.entries(this.digestRecords())) if ((rec.sessionId === id || (id.length >= 8 && rec.sessionId?.startsWith(id))) && existsSync(file)) return file;
		const root = sessionsRoot();
		if (!existsSync(root)) return undefined;
		const look = (dir: string): string | undefined => {
			try {
				const hit = readdirSync(join(root, dir)).find((n) => n.endsWith(`_${id}.jsonl`));
				return hit ? join(root, dir, hit) : undefined;
			} catch {
				return undefined;
			}
		};
		if (cwd) {
			const found = look(`--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
			if (found) return found;
		}
		for (const dir of readdirSync(root)) {
			const found = look(dir);
			if (found) return found;
		}
		return undefined;
	}

	/** What notes cite: each session's name and the cited lines of its digest; inbox items and review comments by id. */
	async evidence(refs: readonly EvidenceRef[]): Promise<EvidenceInfo> {
		const root = this.app.paths.digests;
		const dirs = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
		const out: EvidenceInfo = { sessions: {}, inbox: {}, comments: {} };
		const wantInbox = new Set<string>();
		const wantComments = new Set<string>();
		for (const ref of refs) {
			const s = String(ref?.s ?? "");
			if (s.startsWith("inbox:")) {
				wantInbox.add(s.slice(6));
				continue;
			}
			if (s.startsWith("comment:")) {
				wantComments.add(s.slice(8));
				continue;
			}
			if (!/^[0-9a-zA-Z-]{8,}$/.test(s)) continue;
			const want = new Set(ref.e ?? []);
			const prev = out.sessions[s];
			if (prev && !prev.missing) {
				// The same session cited twice: add the other lines.
				for (const d of dirs) {
					const file = join(root, d, `${s}.txt`);
					if (!existsSync(file)) continue;
					Object.assign(prev.entries, readDigest(readFileSync(file, "utf-8"), want).entries);
					break;
				}
				continue;
			}
			let info: EvidenceInfo["sessions"][string] = { missing: true, entries: {} };
			for (const d of dirs) {
				const file = join(root, d, `${s}.txt`);
				if (!existsSync(file)) continue;
				info = readDigest(readFileSync(file, "utf-8"), want);
				break;
			}
			info.file = this.sessionFile(s, info.cwd) ?? null;
			out.sessions[s] = info;
		}
		for (const id of wantInbox) {
			const item = await this.app.state.inboxItem(id);
			if (item) out.inbox[id] = item;
		}
		for (const id of wantComments) {
			const c = await this.app.state.comment(id);
			if (c) out.comments[id] = c;
		}
		return out;
	}
}

/**
 * A digest: a header line, then `[entry] ROLE: text` lines, continued by lines
 * indented four spaces.
 */
export function readDigest(text: string, want: Set<string>): EvidenceInfo["sessions"][string] {
	const lines = text.split("\n");
	const head: Record<string, string> = {};
	for (const part of (lines[0] ?? "").split(" | ")) {
		const m = /^(\w+) (.*)$/.exec(part);
		if (m) head[m[1]] = m[2];
	}
	const entries: Record<string, { role: string; text: string } | null> = {};
	let cur: { role: string; text: string } | null = null;
	// An unnamed session goes by what the user asked first.
	let first: string | null = null;
	for (const line of lines.slice(1)) {
		const m = /^\[([0-9a-f-]{6,})\] ([A-Z]+):? ?(.*)$/.exec(line);
		if (m) {
			if (!first && m[2] === "USER" && /\p{L}/u.test(m[3])) first = m[3].trim();
			if (want.has(m[1])) {
				// An entry can have several lines (text, then tool calls): the first one speaks for it.
				if (entries[m[1]]) cur = null;
				else cur = entries[m[1]] = { role: m[2], text: m[3] };
			} else cur = null;
		} else if (cur && line.startsWith("    ") && cur.text.length < CLIP) cur.text += `\n${line.slice(4)}`;
	}
	for (const e of Object.values(entries)) if (e && e.text.length > CLIP) e.text = `${e.text.slice(0, CLIP)}…`;
	for (const id of want) if (!(id in entries)) entries[id] = null;
	const name = /^"(.*)"$/.exec(head.name ?? "")?.[1] ?? head.name;
	return { name, first: first ? first.slice(0, 120) : null, started: head.started, cwd: head.cwd, project: head.project, entries };
}
