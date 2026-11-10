/**
 * Hooks: the live connection to the server (`rev`), data that refetches when
 * the server changes, busy / error handling for actions, hash routing, hotkeys.
 */

import type { StatusInfo } from "@wierd-memory/core";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, ApiError, network } from "./api.ts";
import { toast } from "./ui.tsx";
import { errorText, isTyping, sameJson } from "./util.ts";

// ── the live store ───────────────────────────────────────────────────────

interface Live {
	/** Changes whenever shown data may be stale: the server's `rev` moved, or this page changed something. */
	version: number;
	online: boolean;
	status: StatusInfo | null;
}

let live: Live = { version: 0, online: true, status: null };
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
	listeners.add(fn);
	return () => listeners.delete(fn);
};
function setLive(patch: Partial<Live>): void {
	live = { ...live, ...patch };
	for (const fn of listeners) fn();
}

let lastRev = -1;
let bumpTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;

/** Ask everything on screen to refetch (debounced: a burst of events is one refetch). */
export function refresh(delay = 120): void {
	if (bumpTimer) clearTimeout(bumpTimer);
	bumpTimer = setTimeout(() => {
		bumpTimer = undefined;
		setLive({ version: live.version + 1 });
		void loadStatus();
	}, delay);
}

async function loadStatus(): Promise<void> {
	try {
		const status = await api.status();
		lastRev = Math.max(lastRev, status.rev);
		if (!sameJson(status, live.status) || !live.online) setLive({ status: sameJson(status, live.status) ? live.status : status, online: true });
	} catch (err) {
		// Unreachable is handled by `reached`; an error answer still means the server is there.
		if (err instanceof ApiError && err.status === 0 && live.online) setLive({ online: false });
	}
}

function connect(): void {
	const es = new EventSource("/api/events");
	es.onopen = () => {
		if (!live.online) setLive({ online: true });
	};
	es.onmessage = (ev) => {
		try {
			const data = JSON.parse(String(ev.data)) as { rev?: number };
			if (typeof data.rev !== "number" || data.rev === lastRev) return;
			lastRev = data.rev;
			refresh(200);
		} catch {
			// not ours
		}
	};
	es.onerror = () => {
		// EventSource reconnects by itself; meanwhile find out whether the server is there at all.
		void loadStatus();
	};
}

let retry: ReturnType<typeof setTimeout> | undefined;

/** A request did or did not reach the server: show it at once, and keep knocking while it is down. */
function reached(ok: boolean): void {
	if (ok) {
		if (!live.online) {
			setLive({ online: true });
			refresh(0);
		}
		return;
	}
	if (live.online) setLive({ online: false });
	if (retry) return;
	retry = setTimeout(() => {
		retry = undefined;
		void loadStatus();
	}, 3000);
}

export function startLive(): void {
	if (started) return;
	started = true;
	network.onReach = reached;
	void loadStatus();
	connect();
	// A fallback for a silently dead event stream, and it keeps "5h ago" fresh.
	setInterval(() => void loadStatus(), 30_000);
}

export function useLive(): Live {
	return useSyncExternalStore(subscribe, () => live);
}

export function useStatus(): StatusInfo | null {
	return useLive().status;
}

// ── data ─────────────────────────────────────────────────────────────────

export interface Loaded<T> {
	data: T | undefined;
	error: string | undefined;
	loading: boolean;
	reload: () => void;
	/** Put a fresher value in place (the answer of an action). */
	set: (value: T) => void;
}

/**
 * Load something and keep it fresh: it is fetched again when `deps` change
 * and whenever the server's `rev` moves. The previous value stays on screen
 * while the next one loads; an unchanged answer keeps the old object, so
 * nothing below re-renders.
 */
export function useData<T>(load: () => Promise<T>, deps: readonly unknown[], opts: { live?: boolean; skip?: boolean } = {}): Loaded<T> {
	const key = JSON.stringify(deps);
	const [state, setState] = useState<{ key: string; data?: T; error?: string; loading: boolean }>({ key, loading: true });
	const seq = useRef(0);
	const fn = useRef(load);
	fn.current = load;
	const version = useLive().version;
	const [manual, setManual] = useState(0);
	const skip = opts.skip === true;

	// biome-ignore lint/correctness/useExhaustiveDependencies: version / manual are refetch triggers
	useEffect(() => {
		if (skip) return;
		const my = ++seq.current;
		setState((s) => (s.key === key ? { ...s, loading: true } : { key, loading: true }));
		fn.current().then(
			(data) => {
				if (my !== seq.current) return;
				setState((s) => ({ key, data: s.key === key && sameJson(s.data, data) ? s.data : data, loading: false }));
			},
			(err: unknown) => {
				if (my !== seq.current) return;
				setState((s) => ({ key, data: s.key === key ? s.data : undefined, error: errorText(err), loading: false }));
			},
		);
	}, [key, skip, opts.live === false ? 0 : version, manual]);

	const reload = useCallback(() => setManual((n) => n + 1), []);
	const set = useCallback(
		(value: T) => {
			seq.current++;
			setState({ key, data: value, loading: false });
		},
		[key],
	);
	const fresh = state.key === key;
	return { data: fresh ? state.data : undefined, error: fresh ? state.error : undefined, loading: fresh ? state.loading : true, reload, set };
}

// ── actions ──────────────────────────────────────────────────────────────

export interface Busy {
	/** Name of the action in flight. */
	busy: string | null;
	/**
	 * Run an action: one at a time, with its name in `busy` while it runs.
	 * A failure is shown as a toast and gives `undefined`.
	 */
	run: <T>(name: string, fn: () => Promise<T>, done?: string | ((result: T) => string | undefined)) => Promise<T | undefined>;
}

export function useBusy(): Busy {
	const [busy, setBusy] = useState<string | null>(null);
	const lock = useRef(false);
	const run = useCallback(async <T>(name: string, fn: () => Promise<T>, done?: string | ((result: T) => string | undefined)): Promise<T | undefined> => {
		if (lock.current) return undefined;
		lock.current = true;
		setBusy(name);
		try {
			const result = await fn();
			const msg = typeof done === "function" ? done(result) : done;
			if (msg) toast.ok(msg);
			refresh(60);
			return result;
		} catch (err) {
			toast.error(errorText(err));
			return undefined;
		} finally {
			lock.current = false;
			setBusy(null);
		}
	}, []);
	return { busy, run };
}

// ── routing ──────────────────────────────────────────────────────────────

export interface Route {
	/** `review`, `memory`, `note`, `inbox`, `dreams`, `history`, `settings`; empty: the default screen. */
	name: string;
	/** The part after the section, URL-decoded. */
	arg: string | undefined;
}

function parseRoute(hash: string): Route {
	const path = hash.replace(/^#\/?/, "");
	const slash = path.indexOf("/");
	const name = slash < 0 ? path : path.slice(0, slash);
	const rest = slash < 0 ? "" : path.slice(slash + 1);
	let arg: string | undefined;
	if (rest) {
		try {
			arg = decodeURIComponent(rest);
		} catch {
			arg = rest;
		}
	}
	return { name, arg };
}

export function useRoute(): Route {
	const hash = useSyncExternalStore(
		(fn) => {
			window.addEventListener("hashchange", fn);
			return () => window.removeEventListener("hashchange", fn);
		},
		() => window.location.hash,
	);
	return useMemo(() => parseRoute(hash), [hash]);
}

export function href(name: string, arg?: string): string {
	return arg === undefined ? `#/${name}` : `#/${name}/${encodeURIComponent(arg)}`;
}

export function go(name: string, arg?: string, replace = false): void {
	const h = href(name, arg);
	if (replace) window.location.replace(h);
	else window.location.hash = h;
}

// ── keyboard ─────────────────────────────────────────────────────────────

/**
 * Page hotkeys by `event.key`. They are off while the user types in a field,
 * holds a modifier, or a dialog is open.
 */
export function useHotkeys(keys: Record<string, (ev: KeyboardEvent) => void>, enabled = true): void {
	const ref = useRef(keys);
	ref.current = keys;
	useEffect(() => {
		if (!enabled) return;
		const onKey = (ev: KeyboardEvent) => {
			if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
			if (isTyping(ev.target)) return;
			if (document.querySelector(".dialog-backdrop")) return;
			const handler = ref.current[ev.key];
			if (!handler) return;
			ev.preventDefault();
			handler(ev);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [enabled]);
}

/** A clock that ticks while `on`, for elapsed times. */
export function useNow(on: boolean, everyMs = 1000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!on) return;
		setNow(Date.now());
		const t = setInterval(() => setNow(Date.now()), everyMs);
		return () => clearInterval(t);
	}, [on, everyMs]);
	return now;
}
