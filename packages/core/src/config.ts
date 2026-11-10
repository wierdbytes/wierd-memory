/**
 * Settings of wierd-mem (`~/.wierd-mem/config.json`).
 *
 * Missing, unknown or malformed fields fall back to defaults, so a hand-edited
 * file can never break the server. `WMEM_PORT` overrides the port.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homePaths } from "./layout.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type Stage = "cards" | "analyze" | "verify";
export const STAGES: readonly Stage[] = ["cards", "analyze", "verify"];

export interface StageModel {
	/** `<provider>/<model-id>` */
	model: string;
	thinking: ThinkingLevel;
}

export interface WmemConfig {
	/** HTTP port of the server (API and web UI), on 127.0.0.1. */
	port: number;
	/** The git repository memory is kept in. */
	memory: {
		/** Its folder; empty: `memory` under the wierd-mem home (`~/.wierd-mem/memory`). */
		dir: string;
		/** The branch that is approved memory: what sessions get. */
		branch: string;
		/** The remote to push to and pull from (`origin`); empty: none. */
		remote: string;
		/** Push approved memory and review branches after every change, pull on a schedule. */
		sync: boolean;
	};
	/** Language dreams write notes in. */
	language: string;
	/** Inject the approved memory index into sessions. */
	inject: boolean;
	models: Record<Stage, StageModel>;
	schedule: {
		/** Let the server start dreams on its own when one is due. */
		enabled: boolean;
		minHoursBetween: number;
		/** New or grown sessions (or inbox items) needed before a dream is due. */
		minNewSessions: number;
	};
	dream: {
		/** How far back the very first dream looks. */
		firstRunLookbackDays: number;
		/** Sessions summarized per dream; the rest wait for the next one. */
		maxSessionsPerRun: number;
		/** Sessions written to more recently than this are treated as still in use. */
		minIdleMinutes: number;
		/** Parallel session-card calls. */
		concurrency: number;
		maxRuntimeMinutes: number;
		/**
		 * Extensions loaded into the headless pi that dreams (it runs with
		 * `--no-extensions`). Use it for provider/auth extensions. `npm:<name>`
		 * resolves to pi's installed copy; missing entries are skipped.
		 */
		childExtensions: string[];
		/** The pi executable (default: `pi` from PATH). */
		piCommand: string;
	};
	budgets: {
		/** Token budget of the global index injected into every session. */
		globalTokens: number;
		/** Token budget of a project's index injected into its sessions. */
		projectTokens: number;
	};
	/** Let dreams propose AGENTS.md / CLAUDE.md edits (reviewed like notes, applied to the working copy). */
	agentsMd: boolean;
}

export function defaults(): WmemConfig {
	return {
		port: 7433,
		memory: { dir: "", branch: "main", remote: "origin", sync: true },
		language: "Russian",
		inject: true,
		models: {
			cards: { model: "anthropic/claude-sonnet-5-5", thinking: "low" },
			analyze: { model: "anthropic/claude-opus-5-5", thinking: "high" },
			verify: { model: "openai-codex/gpt-6.1-sol", thinking: "medium" },
		},
		schedule: { enabled: false, minHoursBetween: 20, minNewSessions: 3 },
		dream: {
			firstRunLookbackDays: 14,
			maxSessionsPerRun: 60,
			minIdleMinutes: 30,
			concurrency: 4,
			maxRuntimeMinutes: 180,
			childExtensions: ["npm:@wierdbytes/pi-anthropic"],
			piCommand: "pi",
		},
		budgets: { globalTokens: 1000, projectTokens: 1500 },
		agentsMd: true,
	};
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const num = (v: unknown, min: number, max: number, fallback: number): number =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);

function stageModel(raw: unknown, fallback: StageModel): StageModel {
	if (!isObj(raw)) return { ...fallback };
	const model = typeof raw.model === "string" && raw.model.includes("/") ? raw.model.trim() : fallback.model;
	const thinking = oneOf(THINKING_LEVELS, raw.thinking) ? raw.thinking : fallback.thinking;
	return { model, thinking };
}

export function sanitize(raw: unknown): WmemConfig {
	const d = defaults();
	if (!isObj(raw)) return d;
	const cfg = d;
	cfg.port = Math.round(num(raw.port, 1, 65535, d.port));
	if (isObj(raw.memory)) {
		const m = raw.memory;
		const branch = typeof m.branch === "string" && /^[A-Za-z0-9._/-]{1,100}$/.test(m.branch.trim()) && !m.branch.includes("..") ? m.branch.trim() : d.memory.branch;
		cfg.memory = {
			dir: typeof m.dir === "string" ? m.dir.trim() : d.memory.dir,
			branch,
			remote: typeof m.remote === "string" && /^[A-Za-z0-9._-]*$/.test(m.remote.trim()) ? m.remote.trim() : d.memory.remote,
			sync: bool(m.sync, d.memory.sync),
		};
	}
	cfg.language = str(raw.language, d.language);
	cfg.inject = bool(raw.inject, d.inject);
	if (isObj(raw.models)) for (const stage of STAGES) cfg.models[stage] = stageModel(raw.models[stage], d.models[stage]);
	if (isObj(raw.schedule)) {
		const s = raw.schedule;
		cfg.schedule = {
			enabled: bool(s.enabled, d.schedule.enabled),
			minHoursBetween: num(s.minHoursBetween, 0, 24 * 30, d.schedule.minHoursBetween),
			minNewSessions: Math.round(num(s.minNewSessions, 1, 1000, d.schedule.minNewSessions)),
		};
	}
	if (isObj(raw.dream)) {
		const s = raw.dream;
		cfg.dream = {
			firstRunLookbackDays: num(s.firstRunLookbackDays, 0, 3650, d.dream.firstRunLookbackDays),
			maxSessionsPerRun: Math.round(num(s.maxSessionsPerRun, 1, 1000, d.dream.maxSessionsPerRun)),
			minIdleMinutes: num(s.minIdleMinutes, 0, 24 * 60, d.dream.minIdleMinutes),
			concurrency: Math.round(num(s.concurrency, 1, 16, d.dream.concurrency)),
			maxRuntimeMinutes: num(s.maxRuntimeMinutes, 5, 24 * 60, d.dream.maxRuntimeMinutes),
			childExtensions: Array.isArray(s.childExtensions) ? s.childExtensions.filter((x): x is string => typeof x === "string" && !!x.trim()) : d.dream.childExtensions,
			piCommand: str(s.piCommand, d.dream.piCommand),
		};
	}
	if (isObj(raw.budgets)) {
		cfg.budgets = {
			globalTokens: Math.round(num(raw.budgets.globalTokens, 0, 20000, d.budgets.globalTokens)),
			projectTokens: Math.round(num(raw.budgets.projectTokens, 0, 20000, d.budgets.projectTokens)),
		};
	}
	cfg.agentsMd = bool(raw.agentsMd, d.agentsMd);
	return cfg;
}

export function loadConfig(path: string = homePaths().config): WmemConfig {
	let cfg: WmemConfig;
	try {
		cfg = existsSync(path) ? sanitize(JSON.parse(readFileSync(path, "utf-8"))) : defaults();
	} catch {
		cfg = defaults();
	}
	const port = Number(process.env.WMEM_PORT);
	if (Number.isInteger(port) && port > 0) cfg.port = port;
	return cfg;
}

export function saveConfig(cfg: WmemConfig, path: string = homePaths().config): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
}

/** Where clients find the server: `WMEM_URL`, else the configured port on this machine. */
export function serverUrl(cfg: WmemConfig = loadConfig()): string {
	return (process.env.WMEM_URL || `http://127.0.0.1:${cfg.port}`).replace(/\/+$/, "");
}
