/**
 * The client of the wierd-memory HTTP API (`docs/api.md`). Every call goes to the
 * server the page was loaded from and names itself with `x-wmem-client: web`.
 */

import type {
	AgentsProposal,
	CommitInfo,
	DreamStatus,
	Evidence,
	EvidenceInfo,
	InboxItem,
	InboxKind,
	Note,
	NoteCreate,
	NoteHistoryEntry,
	NotePatch,
	NoteView,
	ReportData,
	ReviewAccept,
	ReviewDecision,
	ReviewReject,
	ReviewView,
	RunInfo,
	ScopeInfo,
	StatusInfo,
	WmemConfig,
} from "@wierd-memory/core";

export class ApiError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

/** Told whether the last request reached the server at all (the shell shows "unreachable" from it). */
export const network: { onReach: (reached: boolean) => void } = { onReach: () => {} };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = { "x-wmem-client": "web" };
	if (body !== undefined) headers["content-type"] = "application/json";
	let res: Response;
	try {
		res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	} catch {
		network.onReach(false);
		throw new ApiError("The server is unreachable.", 0);
	}
	network.onReach(true);
	const text = await res.text();
	const isJson = (res.headers.get("content-type") ?? "").includes("json");
	let data: unknown = text;
	if (isJson) {
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			data = null;
		}
	}
	if (!res.ok) {
		const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `${res.status} ${res.statusText || "request failed"}`;
		throw new ApiError(msg, res.status);
	}
	return data as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body: unknown = {}) => request<T>("POST", path, body);
const put = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
const enc = encodeURIComponent;

export interface PromptInfo {
	name: string;
	default: string;
	override: string | null;
}

export interface PromptsInfo {
	prompts: PromptInfo[];
	charters: { global: string; project: string; projectOverride: string | null };
}

export interface CommitChange {
	type: string;
	before?: Note;
	after?: Note;
}

export interface SkillInfo {
	scope: string;
	name: string;
	description: string;
	body: string;
}

export type RunDetail = RunInfo & { opts?: { sinceDays?: number; maxSessions?: number }; report?: ReportData };

export type DreamMode = "run" | "review" | "dry" | "reindex";

export const api = {
	status: () => get<StatusInfo>("/api/status"),

	// memory
	scopes: () => get<ScopeInfo[]>("/api/scopes"),
	setCharter: (scope: string, charter: string | null) => put<{ ok: boolean }>(`/api/scopes/${enc(scope)}/charter`, { charter }),
	notes: () => get<{ notes: NoteView[] }>("/api/notes").then((r) => r.notes),
	note: (id: string) => get<NoteView>(`/api/notes/${enc(id)}`),
	createNote: (note: NoteCreate) => post<NoteView>("/api/notes", note),
	patchNote: (id: string, patch: NotePatch) => request<NoteView>("PATCH", `/api/notes/${enc(id)}`, patch),
	deleteNote: (id: string) => request<{ ok: boolean }>("DELETE", `/api/notes/${enc(id)}`),
	noteHistory: (id: string) => get<NoteHistoryEntry[]>(`/api/notes/${enc(id)}/history`),
	restoreNote: (id: string, commit: string) => post<NoteView>(`/api/notes/${enc(id)}/restore`, { commit }),
	history: (limit = 200) => get<CommitInfo[]>(`/api/history?limit=${limit}`),
	commit: (hash: string) => get<{ changes: CommitChange[] }>(`/api/history/${enc(hash)}`).then((r) => r.changes),
	skills: () => get<SkillInfo[]>("/api/skills"),
	deleteSkill: (scope: string, name: string) => request<{ ok: boolean }>("DELETE", `/api/skills?scope=${enc(scope)}&name=${enc(name)}`),
	context: (cwd: string) => get<{ injection: { text: string | null; ids: string[]; tokens: number; memver: string } }>(`/api/context?cwd=${enc(cwd)}`),
	evidence: (refs: Array<Pick<Evidence, "s" | "e">>) => post<EvidenceInfo>("/api/evidence", { refs: refs.map((r) => ({ s: r.s, e: r.e })) }),

	// inbox
	inbox: () => get<InboxItem[]>("/api/inbox"),
	addInbox: (input: { text: string; scope: "global" | "project"; cwd?: string; kind?: InboxKind }) => post<InboxItem>("/api/inbox", { ...input, source: "user" }),
	dismissInbox: (id: string) => request<{ ok: boolean }>("DELETE", `/api/inbox/${enc(id)}`),

	// review
	review: () => get<ReviewView>("/api/review"),
	/** Decisions, newest first. */
	decisions: (limit = 200) => get<ReviewDecision[]>(`/api/review/decisions?limit=${limit}`),
	/** With `versions` the server answers 409 when an item changed since it was shown; nothing is decided then. */
	accept: (pick: ReviewAccept) => post<ReviewView>("/api/review/accept", pick),
	reject: (pick: ReviewReject) => post<ReviewView>("/api/review/reject", pick),
	comment: (body: string, noteId?: string) => post<ReviewView>("/api/review/comments", noteId ? { body, noteId } : { body }),
	removeComment: (cid: string) => request<ReviewView>("DELETE", `/api/review/comments/${enc(cid)}`),
	applyAgents: (id: string, edits?: AgentsProposal["edits"]) => post<ReviewView>(`/api/agents/${enc(id)}/apply`, edits === undefined ? {} : { edits }),
	rejectAgents: (id: string) => post<ReviewView>(`/api/agents/${enc(id)}/reject`),

	// dreams
	dreams: (limit = 50) => get<DreamStatus>(`/api/dreams?limit=${limit}`),
	startDream: (mode: DreamMode, opts: { sinceDays?: number; maxSessions?: number } = {}) => post<RunInfo & { log?: string }>("/api/dreams", { mode, ...opts }),
	dream: (id: string) => get<RunDetail>(`/api/dreams/${enc(id)}`),
	dreamLog: (id: string, tail = 200) => get<string>(`/api/dreams/${enc(id)}/log?tail=${tail}`),
	cancelDream: (id: string) => post<{ ok: boolean }>(`/api/dreams/${enc(id)}/cancel`),

	// settings
	config: () => get<WmemConfig>("/api/config"),
	saveConfig: (patch: Partial<WmemConfig>) => put<WmemConfig>("/api/config", patch),
	prompts: () => get<PromptsInfo>("/api/prompts"),
	setPrompt: (name: string, body: string | null) => put<{ ok: boolean }>(`/api/prompts/${enc(name)}`, { body }),
	sync: () => post<{ message: string }>("/api/sync"),
};
