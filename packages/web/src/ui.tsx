/**
 * Shared building blocks: buttons, toasts, the confirm dialog, folds, chips,
 * icons, the autosizing textarea.
 */

import { type ButtonHTMLAttributes, type ReactNode, type Ref, type RefObject, type TextareaHTMLAttributes, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { cls } from "./util.ts";

// ── icons ────────────────────────────────────────────────────────────────

const ICONS = {
	user: "M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5.5 6c0-2.8 2.5-4.5 5.5-4.5s5.5 1.7 5.5 4.5",
	check: "M3 8.5 6.5 12 13 4.5",
	x: "M4 4l8 8M12 4l-8 8",
	chevron: "M6 3.5 10.5 8 6 12.5",
	copy: "M5.5 5.5v-3h8v8h-3M2.5 5.5h8v8h-8z",
	pin: "M9.5 2 14 6.5l-2 .5-2.5 2.5.5 3L8 10.5 3 14l3.5-5L4.5 7l3-.5L10 4z",
	warn: "M8 2.5 14.5 13.5h-13zM8 6.5v3.5M8 12v.2",
	edit: "M2.5 13.5 3 11l7.5-7.5 2 2L5 13zM9.5 4.5l2 2",
	plus: "M8 3v10M3 8h10",
	moon: "M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5Z",
	inbox: "M2.5 9.5 4 3.5h8l1.5 6v3h-11zm0 0h3.2l.8 1.5h3l.8-1.5h3.2",
	review: "M3 3.5h10M3 8h10M3 12.5h6M11 12l1.5 1.5L15 11",
	memory: "M3 4c0-1 2.2-1.8 5-1.8s5 .8 5 1.8v8c0 1-2.2 1.8-5 1.8S3 13 3 12zm0 0c0 1 2.2 1.8 5 1.8s5-.8 5-1.8M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8",
	history: "M2.5 8a5.5 5.5 0 1 0 1.8-4M2.5 3v2.5H5M8 5v3.2l2 1.3",
	settings: "M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6M10 3.5v3M6 9.5v3",
	external: "M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5",
	trash: "M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 9h6l.5-9M6.8 7v4M9.2 7v4",
	power: "M8 2v5.5M4.6 4.2a5 5 0 1 0 6.8 0",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 14, title }: { name: IconName; size?: number; title?: string }) {
	return (
		<svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
			{title ? <title>{title}</title> : null}
			<path d={ICONS[name]} />
		</svg>
	);
}

export function Spinner({ size = 12 }: { size?: number }) {
	return <span className="spinner" style={{ width: size, height: size }} aria-label="working" />;
}

// ── buttons ──────────────────────────────────────────────────────────────

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: "default" | "primary" | "danger" | "ghost" | "link";
	small?: boolean;
	busy?: boolean;
	icon?: IconName;
	kbd?: string;
	ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "default", small, busy, icon, kbd, children, className, disabled, type, ref, ...rest }: ButtonProps) {
	return (
		<button ref={ref} type={type ?? "button"} className={cls("btn", `btn-${variant}`, small && "btn-small", busy && "is-busy", className)} disabled={disabled || busy} {...rest}>
			{busy ? <Spinner /> : icon ? <Icon name={icon} /> : null}
			{children}
			{kbd ? <kbd>{kbd}</kbd> : null}
		</button>
	);
}

export function CopyButton({ text, label, title }: { text: string; label?: ReactNode; title?: string }) {
	const [done, setDone] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			const ta = document.createElement("textarea");
			ta.value = text;
			document.body.appendChild(ta);
			ta.select();
			document.execCommand("copy");
			ta.remove();
		}
		setDone(true);
		setTimeout(() => setDone(false), 1200);
	};
	return (
		<button type="button" className={cls("copy", done && "is-done")} onClick={() => void copy()} title={title ?? `Copy ${text}`}>
			{label ?? null}
			<Icon name={done ? "check" : "copy"} size={12} />
		</button>
	);
}

// ── small pieces ─────────────────────────────────────────────────────────

export function Chip({ tone, children, title, className }: { tone?: string; children: ReactNode; title?: string; className?: string }) {
	return (
		<span className={cls("chip", tone && `tone-${tone}`, className)} title={title}>
			{children}
		</span>
	);
}

export function Callout({ tone = "yellow", title, children }: { tone?: "yellow" | "red" | "blue" | "green"; title?: ReactNode; children?: ReactNode }) {
	return (
		<div className={cls("callout", `callout-${tone}`)}>
			<Icon name={tone === "green" ? "check" : "warn"} />
			<div className="callout-body">
				{title ? <div className="callout-title">{title}</div> : null}
				{children}
			</div>
		</div>
	);
}

export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
	return (
		<div className="empty">
			<div className="empty-title">{title}</div>
			{children ? <div className="empty-body">{children}</div> : null}
		</div>
	);
}

/** What a screen shows while its data loads or when loading failed. */
export function LoadState({ error, loading, reload }: { error?: string; loading: boolean; reload?: () => void }) {
	if (error) {
		return (
			<Callout tone="red" title="Could not load">
				{error}{" "}
				{reload ? (
					<Button variant="link" onClick={reload}>
						Retry
					</Button>
				) : null}
			</Callout>
		);
	}
	if (loading) {
		return (
			<div className="loading">
				<Spinner /> loading…
			</div>
		);
	}
	return null;
}

export function Meter({ value, max, over }: { value: number; max: number; over?: boolean }) {
	const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
	return (
		<span className={cls("meter", (over || pct >= 100) && "is-over", pct >= 80 && "is-high")} title={`${value} of ${max} tokens`}>
			<span style={{ width: `${pct}%` }} />
		</span>
	);
}

/** A collapsible section; the content is rendered only while open. */
export function Fold({ title, count, defaultOpen = false, open: controlled, onToggle, right, children, className }: { title: ReactNode; count?: number; defaultOpen?: boolean; open?: boolean; onToggle?: (open: boolean) => void; right?: ReactNode; children: ReactNode; className?: string }) {
	const [own, setOwn] = useState(defaultOpen);
	const open = controlled ?? own;
	const toggle = () => {
		setOwn(!open);
		onToggle?.(!open);
	};
	return (
		<section className={cls("fold", open && "is-open", className)}>
			<div className="fold-head">
				<button type="button" className="fold-toggle" onClick={toggle} aria-expanded={open}>
					<Icon name="chevron" size={12} />
					<span className="fold-title">{title}</span>
					{count !== undefined ? <span className="fold-count">{count}</span> : null}
				</button>
				{right ? <div className="fold-right">{right}</div> : null}
			</div>
			{open ? <div className="fold-body">{children}</div> : null}
		</section>
	);
}

export function Field({ label, hint, children, wide }: { label: ReactNode; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
	return (
		<label className={cls("field", wide && "field-wide")}>
			<span className="field-label">{label}</span>
			{children}
			{hint ? <span className="field-hint">{hint}</span> : null}
		</label>
	);
}

/** A textarea as tall as its text. */
export function AutoTextarea({ value, minRows = 2, maxHeight = 560, className, ref: outer, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string; minRows?: number; maxHeight?: number; ref?: RefObject<HTMLTextAreaElement | null> }) {
	const own = useRef<HTMLTextAreaElement>(null);
	const ref = outer ?? own;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the height follows the text
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(maxHeight, el.scrollHeight + 2)}px`;
		el.style.overflowY = el.scrollHeight + 2 > maxHeight ? "auto" : "hidden";
	}, [value, maxHeight]);
	return <textarea ref={ref} rows={minRows} value={value} className={cls("autosize", className)} spellCheck={false} {...rest} />;
}

// ── toasts ───────────────────────────────────────────────────────────────

interface Toast {
	id: number;
	kind: "ok" | "error";
	text: string;
}

let toasts: Toast[] = [];
let toastId = 0;
const toastSubs = new Set<() => void>();
const emitToasts = () => {
	for (const fn of toastSubs) fn();
};

function pushToast(kind: Toast["kind"], text: string): void {
	const id = ++toastId;
	toasts = [...toasts.slice(-4), { id, kind, text }];
	emitToasts();
	setTimeout(() => dropToast(id), kind === "error" ? 9000 : 2800);
}

function dropToast(id: number): void {
	toasts = toasts.filter((t) => t.id !== id);
	emitToasts();
}

export const toast = {
	ok: (text: string) => pushToast("ok", text),
	error: (text: string) => pushToast("error", text),
};

export function Toasts() {
	const list = useSyncExternalStore(
		(fn) => {
			toastSubs.add(fn);
			return () => toastSubs.delete(fn);
		},
		() => toasts,
	);
	return (
		<div className="toasts" aria-live="polite">
			{list.map((t) => (
				<div key={t.id} className={cls("toast", `toast-${t.kind}`)} role={t.kind === "error" ? "alert" : "status"}>
					<Icon name={t.kind === "error" ? "warn" : "check"} />
					<span>{t.text}</span>
					<button type="button" className="toast-close" onClick={() => dropToast(t.id)} aria-label="Dismiss">
						<Icon name="x" size={12} />
					</button>
				</div>
			))}
		</div>
	);
}

// ── the confirm dialog ───────────────────────────────────────────────────

export interface ConfirmOptions {
	title: string;
	body?: ReactNode;
	confirm: string;
	danger?: boolean;
	/** Ask for an optional line of text too (a reason). */
	input?: { label: string; placeholder?: string };
}

interface PendingDialog extends ConfirmOptions {
	resolve: (result: { ok: boolean; text: string }) => void;
}

let dialog: PendingDialog | null = null;
const dialogSubs = new Set<() => void>();
const emitDialog = () => {
	for (const fn of dialogSubs) fn();
};

/** Ask before a destructive or bulk action. */
export function confirmDialog(opts: ConfirmOptions): Promise<{ ok: boolean; text: string }> {
	return new Promise((resolve) => {
		dialog?.resolve({ ok: false, text: "" });
		dialog = { ...opts, resolve };
		emitDialog();
	});
}

export function DialogHost() {
	const d = useSyncExternalStore(
		(fn) => {
			dialogSubs.add(fn);
			return () => dialogSubs.delete(fn);
		},
		() => dialog,
	);
	const [text, setText] = useState("");
	const okRef = useRef<HTMLButtonElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!d) return;
		setText("");
		(d.input ? inputRef.current : okRef.current)?.focus();
	}, [d]);
	if (!d) return null;
	const close = (ok: boolean) => {
		dialog = null;
		emitDialog();
		d.resolve({ ok, text: text.trim() });
	};
	return (
		<div
			className="dialog-backdrop"
			onMouseDown={(ev) => {
				if (ev.target === ev.currentTarget) close(false);
			}}
			onKeyDown={(ev) => {
				if (ev.key === "Escape") close(false);
				if (ev.key === "Enter" && ev.target instanceof HTMLInputElement) close(true);
			}}
		>
			<div className="dialog" role="alertdialog" aria-modal="true" aria-label={d.title}>
				<h3>{d.title}</h3>
				{d.body ? <div className="dialog-body">{d.body}</div> : null}
				{d.input ? (
					<Field label={d.input.label}>
						<input ref={inputRef} type="text" value={text} placeholder={d.input.placeholder} onChange={(ev) => setText(ev.target.value)} />
					</Field>
				) : null}
				<div className="dialog-actions">
					<Button onClick={() => close(false)}>Cancel</Button>
					<Button ref={okRef} variant={d.danger ? "danger" : "primary"} onClick={() => close(true)}>
						{d.confirm}
					</Button>
				</div>
			</div>
		</div>
	);
}
