/**
 * When a dream is due: enough new sessions or inbox items, enough time since
 * the last one, none running.
 */

import type { DueCheck, RunInfo, SessionMark } from "./api.ts";
import type { WmemConfig } from "./config.ts";
import type { SessionFile } from "./sessions.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface DreamMarks {
	cutoffMs?: number;
	sessions: Record<string, SessionMark>;
}

/** Sessions the next dream should summarize, oldest first. */
export function pendingSessions(files: readonly SessionFile[], state: DreamMarks | undefined, cfg: WmemConfig, now = Date.now()): SessionFile[] {
	const cutoff = state?.cutoffMs ?? now - cfg.dream.firstRunLookbackDays * DAY;
	return files
		.filter((f) => {
			const mark = state?.sessions[f.path];
			if (mark && mark.size === f.size && (mark.ok || mark.failures >= 3)) return false;
			if (!mark && f.mtimeMs < cutoff) return false;
			if (now - f.mtimeMs < cfg.dream.minIdleMinutes * MINUTE) return false;
			return true;
		})
		.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export function checkDue(cfg: WmemConfig, last: Pick<RunInfo, "status" | "startedAt" | "finishedAt"> | undefined, sessions: number, inbox: number, dreaming: boolean, now = Date.now()): DueCheck {
	const base = { sessions, inbox };
	if (!cfg.schedule.enabled) return { ...base, due: false, reason: "schedule disabled" };
	if (dreaming) return { ...base, due: false, reason: "a dream is running" };
	const at = last?.finishedAt ?? last?.startedAt;
	const minHours = last?.status === "error" ? Math.min(cfg.schedule.minHoursBetween, 2) : cfg.schedule.minHoursBetween;
	if (at) {
		const hours = (now - Date.parse(at)) / HOUR;
		if (hours < minHours) return { ...base, due: false, reason: `last dream ${hours.toFixed(1)} h ago (< ${minHours} h)` };
	}
	if (sessions + inbox < cfg.schedule.minNewSessions) return { ...base, due: false, reason: `${sessions} new sessions + ${inbox} inbox (< ${cfg.schedule.minNewSessions})` };
	return { ...base, due: true, reason: `${sessions} new sessions, ${inbox} inbox items` };
}
