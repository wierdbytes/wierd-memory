/**
 * The shell: sections on the left with what waits in each, a status line
 * (memory version, dream state, server), and the screen the hash names.
 */

import type { StatusInfo } from "@wierd-memory/core";
import { type ReactNode, useEffect } from "react";
import { go, href, type Route, useLive, useNow, useRoute } from "./hooks.ts";
import { DreamsScreen } from "./screens/Dreams.tsx";
import { HistoryScreen } from "./screens/History.tsx";
import { InboxScreen } from "./screens/Inbox.tsx";
import { MemoryScreen } from "./screens/Memory.tsx";
import { ReviewScreen } from "./screens/Review.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";
import { DialogHost, Icon, type IconName, Spinner, Toasts } from "./ui.tsx";
import { ago, cls, firstLine, runDuration } from "./util.ts";

const SECTIONS: Array<{ name: string; label: string; icon: IconName }> = [
	{ name: "review", label: "Review", icon: "review" },
	{ name: "memory", label: "Memory", icon: "memory" },
	{ name: "inbox", label: "Inbox", icon: "inbox" },
	{ name: "dreams", label: "Dreams", icon: "moon" },
	{ name: "history", label: "History", icon: "history" },
	{ name: "settings", label: "Settings", icon: "settings" },
];

const KNOWN = new Set([...SECTIONS.map((s) => s.name), "note"]);

function screen(route: Route): ReactNode {
	switch (route.name) {
		case "review":
			return <ReviewScreen />;
		case "memory":
		case "note":
			return <MemoryScreen route={route} />;
		case "inbox":
			return <InboxScreen />;
		case "dreams":
			return <DreamsScreen arg={route.arg} />;
		case "history":
			return <HistoryScreen />;
		case "settings":
			return <SettingsScreen />;
		default:
			return null;
	}
}

export function App() {
	const route = useRoute();
	const { status, online } = useLive();
	const known = KNOWN.has(route.name);

	// No (or an unknown) route: the review when something waits there, else memory.
	useEffect(() => {
		if (known || !status) return;
		go(status.review.pending ? "review" : "memory", undefined, true);
	}, [known, status]);

	const pending = status?.review.pending ?? 0;
	useEffect(() => {
		document.title = pending ? `(${pending}) wierd-memory` : "wierd-memory";
	}, [pending]);

	const section = route.name === "note" ? "memory" : route.name;
	const badge = (name: string): ReactNode => {
		if (!status) return null;
		if (name === "review" && pending) return <span className="badge badge-accent">{pending}</span>;
		if (name === "inbox" && status.inbox) return <span className="badge">{status.inbox}</span>;
		if (name === "dreams" && status.dream.running) return <Spinner size={10} />;
		if (name === "dreams" && status.dream.last?.status === "error") return <span className="badge badge-red">!</span>;
		return null;
	};

	return (
		<div className="app">
			<aside className="sidebar">
				<a className="brand" href={href(status?.review.pending ? "review" : "memory")}>
					wierd<span>·</span>mem
				</a>
				<nav>
					{SECTIONS.map((s) => (
						<a key={s.name} className={cls("nav-item", section === s.name && "is-on")} href={href(s.name)} aria-current={section === s.name ? "page" : undefined}>
							<Icon name={s.icon} size={15} />
							<span>{s.label}</span>
							{badge(s.name)}
						</a>
					))}
				</nav>
				<span className="spacer" />
				<StatusLine status={status} online={online} />
			</aside>
			<div className="content">
				{!online ? (
					<div className="offline" role="alert">
						<Icon name="warn" /> The wierd-memory server is unreachable. Retrying… what you see may be out of date, and actions will fail.
					</div>
				) : null}
				<main className={cls("main", `main-${section}`)}>{known ? screen(route) : null}</main>
			</div>
			<Toasts />
			<DialogHost />
		</div>
	);
}

function StatusLine({ status, online }: { status: StatusInfo | null; online: boolean }) {
	const running = status?.dream.running ?? null;
	const now = useNow(!!running, 1000);
	useNow(!running, 60_000); // keeps "5h ago" moving
	if (!status) {
		return (
			<div className="status">
				<div className={cls("status-row", !online && "text-red")}>
					<span className={cls("dot", online ? "dot-dim" : "dot-red")} /> {online ? "connecting…" : "server unreachable"}
				</div>
			</div>
		);
	}
	const last = status.dream.last;
	return (
		<div className="status">
			<a className="status-row" href={href("history")} title="The commit approved memory is at">
				<span className="status-key">memory</span> <span className="mono">{status.memver}</span>
			</a>
			<a className="status-row" href={href("dreams")} title={status.dream.due.reason}>
				{running ? (
					<>
						<Spinner size={10} /> dreaming {runDuration(running, now)}
					</>
				) : last?.status === "error" ? (
					<span className="text-red" title={last.error ? firstLine(last.error) : undefined}>
						dream failed {ago(last.finishedAt ?? last.startedAt)}
					</span>
				) : last ? (
					<>dreamt {ago(last.finishedAt ?? last.startedAt)}</>
				) : (
					<>no dream yet</>
				)}
				{!running && status.dream.due.due ? <span className="text-yellow"> · due</span> : null}
			</a>
			<div className={cls("status-row", !online && "text-red")} title={`${status.url} · wierd-memory ${status.version}`}>
				<span className={cls("dot", online ? "dot-green" : "dot-red")} /> {online ? "server ok" : "server unreachable"}
			</div>
		</div>
	);
}
