/**
 * Dreams: when they run, and the process that runs them.
 *
 * A dream is a headless pi process — it needs pi's model registry and the
 * user's credentials — that loads only the dream runner (`packages/pi/runner.ts`)
 * and the provider extensions from `dream.childExtensions`:
 *
 *   pi -p --no-session --no-extensions -e <provider ext> -e runner.ts "/wmem-dream-run --run-id …"
 *
 * The runner asks this server what to work on (`GET /api/dream/workspace`),
 * reads the new sessions, and hands back what it proposes
 * (`POST /api/dream/submit`); the server writes that to the dreams branch.
 * The server only schedules, starts, watches and stops the process, and keeps
 * its log (`.local/logs/<run>.log` in the memory repository).
 *
 * One dream at a time. With `schedule.enabled`, the server checks every few
 * minutes whether one is due (enough new sessions, enough time since the last).
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkDue,
	type DreamStatus,
	type DreamWorkspace,
	type DueCheck,
	listSessionFiles,
	newRunId,
	pendingSessions,
	piAgentDir,
	type RunInfo,
} from "@wierd-memory/core";
import { type App, bad, HttpError, notFound } from "./app.ts";
import { MAIN } from "./git.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;
const CHECK_EVERY = 10 * MINUTE;

function alive(pid: number | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** `@scope/name@1.2.3` → `@scope/name`, `name@1` → `name`. */
export function npmPackageName(spec: string): string {
	const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
	return at > 0 ? spec.slice(0, at) : spec;
}

/** Resolve `childExtensions` entries to paths pi can load with `-e`. */
export function resolveChildExtensions(list: readonly string[]): string[] {
	const out: string[] = [];
	for (const entry of list) {
		if (entry.startsWith("npm:")) {
			const path = join(piAgentDir(), "npm", "node_modules", npmPackageName(entry.slice(4)));
			if (existsSync(path)) out.push(path);
		} else if (existsSync(entry)) {
			out.push(entry);
		}
	}
	return out;
}

export function runnerFile(): string {
	return process.env.WMEM_RUNNER || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "pi", "runner.ts");
}

export class Dreams {
	private timer: ReturnType<typeof setInterval> | undefined;
	private dueCache: { at: number; value: DueCheck } | undefined;
	private watchers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		private app: App,
		private scheduled: boolean,
	) {}

	schedule(): void {
		if (!this.scheduled || this.timer) return;
		this.timer = setInterval(() => void this.tick().catch((err) => this.app.log(`dreams: ${err instanceof Error ? err.message : err}`)), CHECK_EVERY);
		this.timer.unref?.();
		setTimeout(() => void this.tick().catch(() => undefined), 20_000).unref?.();
	}

	/** Settings changed: whether a dream is due may have changed with them. */
	configChanged(): void {
		this.dueCache = undefined;
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		for (const t of this.watchers.values()) clearTimeout(t);
	}

	/** Runs left "running" by a server that went away: still alive — keep watching; gone — failed. */
	async recover(): Promise<void> {
		for (const run of await this.app.state.runningRuns()) {
			if (alive(run.pid)) this.watch(run.id, run.pid as number);
			else await this.app.state.updateRun(run.id, { status: "error", finishedAt: new Date().toISOString(), error: "the dream process is gone (the server restarted?)" });
		}
	}

	async running(): Promise<RunInfo | null> {
		for (const run of await this.app.state.runningRuns()) if (alive(run.pid)) return run;
		return null;
	}

	async due(fresh = false): Promise<DueCheck> {
		if (!fresh && this.dueCache && Date.now() - this.dueCache.at < 60_000) return this.dueCache.value;
		const { state, cfg } = this.app;
		const [marks, cutoff, inbox, last, running] = await Promise.all([state.marks(), state.get<number>("cutoffMs"), state.inbox("pending"), state.lastDream(), this.running()]);
		const sessions = pendingSessions(listSessionFiles(), { cutoffMs: cutoff, sessions: marks }, cfg);
		const value = checkDue(cfg, last, sessions.length, inbox.length, !!running);
		this.dueCache = { at: Date.now(), value };
		return value;
	}

	async status(limit = 30): Promise<DreamStatus> {
		const [runs, running, due] = await Promise.all([this.app.state.runs(limit), this.running(), this.due()]);
		const last = (await this.app.state.lastDream()) ?? null;
		return { running, last, due, schedule: this.app.cfg.schedule, runs };
	}

	private async tick(): Promise<void> {
		if (!this.app.cfg.schedule.enabled) return;
		const due = await this.due(true);
		if (!due.due) return;
		this.app.log(`dreams: one is due — ${due.reason}`);
		await this.start("run", {}, "schedule");
	}

	/** Start a dream. Throws when one is already running. */
	async start(kind: RunInfo["kind"], opts: { sinceDays?: number; maxSessions?: number } = {}, trigger = "user"): Promise<RunInfo & { log: string }> {
		if (!["run", "review", "dry", "reindex"].includes(kind)) throw bad(`unknown dream mode "${kind}"`);
		return this.app.lock(async () => {
			const busy = await this.running();
			if (busy) throw new HttpError(409, `a dream is already running (${busy.id})`);
			const runner = runnerFile();
			if (!existsSync(runner)) throw new HttpError(500, `the dream runner is missing: ${runner}`);
			const { cfg, paths, state } = this.app;
			const id = newRunId();
			const log = join(paths.dreamLogs, `${id}.log`);
			const exts = resolveChildExtensions(cfg.dream.childExtensions).flatMap((p) => ["-e", p]);
			const args = ["-p", "--no-session", "--no-extensions", ...exts, "-e", runner, "--no-skills", "--no-context-files", "--no-prompt-templates", `/wmem-dream-run --run-id ${id}`];
			const run: RunInfo = { id, kind, status: "running", startedAt: new Date().toISOString(), trigger };
			await state.createRun({ ...run, opts });
			const fd = openSync(log, "a");
			let pid: number | undefined;
			try {
				const child = spawn(cfg.dream.piCommand, args, {
					cwd: paths.home,
					detached: true,
					stdio: ["ignore", fd, fd],
					env: { ...process.env, WMEM_CHILD: "1", WMEM_URL: this.app.url, WMEM_HOME: paths.home },
				});
				child.on("error", (err) => {
					void state.updateRun(id, { status: "error", finishedAt: new Date().toISOString(), error: `could not start ${cfg.dream.piCommand}: ${err.message}` }).then(() => this.app.bump("dream"));
				});
				child.on("exit", (code, signal) => void this.exited(id, code, signal));
				child.unref();
				pid = child.pid;
			} finally {
				closeSync(fd);
			}
			if (!pid) {
				// The process could not be started at all (the "error" event says why, a moment later).
				await new Promise((r) => setTimeout(r, 200));
				const failed = await state.run(id);
				if (failed?.status === "running") await state.updateRun(id, { status: "error", finishedAt: new Date().toISOString(), error: `could not start ${cfg.dream.piCommand}` });
				throw new HttpError(500, `could not start the dream: is "${cfg.dream.piCommand}" on the server's PATH? (dream.piCommand in the settings)`);
			}
			run.pid = pid;
			await state.updateRun(id, { pid });
			if (pid) this.watch(id, pid);
			this.dueCache = undefined;
			this.app.log(`dream ${id} (${kind}) started by ${trigger}: pid ${pid}, log ${log}`);
			this.app.bump("dream");
			return { ...run, log };
		});
	}

	/**
	 * Register a dream that someone else runs (the runner started by hand for
	 * debugging, a test): the same as `start`, without starting a process.
	 */
	async begin(kind: RunInfo["kind"], opts: { sinceDays?: number; maxSessions?: number } = {}, pid?: number, trigger = "manual"): Promise<RunInfo> {
		if (!["run", "review", "dry", "reindex"].includes(kind)) throw bad(`unknown dream mode "${kind}"`);
		return this.app.lock(async () => {
			const busy = await this.running();
			if (busy) throw new HttpError(409, `a dream is already running (${busy.id})`);
			const run: RunInfo = { id: newRunId(), kind, status: "running", startedAt: new Date().toISOString(), pid: pid ?? process.pid, trigger };
			await this.app.state.createRun({ ...run, opts });
			if (pid) this.watch(run.id, pid);
			this.dueCache = undefined;
			this.app.bump("dream");
			return run;
		});
	}

	/** Stop a dream that runs past its time limit, and notice one whose process vanished. */
	private watch(id: string, pid: number): void {
		const limit = this.app.cfg.dream.maxRuntimeMinutes * MINUTE * 1.25;
		const check = async () => {
			const run = await this.app.state.run(id);
			if (!run || run.status !== "running") return this.watchers.delete(id);
			if (!alive(pid)) return void this.exited(id, null, null);
			if (Date.now() - Date.parse(run.startedAt) > limit) return void this.cancel(id, "time limit");
			this.watchers.set(id, setTimeout(() => void check().catch(() => undefined), MINUTE));
		};
		this.watchers.set(id, setTimeout(() => void check().catch(() => undefined), MINUTE));
	}

	private async exited(id: string, code: number | null, signal: string | null): Promise<void> {
		// The runner reports its own result; this only catches a process that died without one.
		await new Promise((r) => setTimeout(r, 300));
		const run = await this.app.state.run(id);
		if (!run || run.status !== "running") return;
		const tail = this.logTail(id, 6).trim().split("\n").pop() ?? "";
		await this.app.state.updateRun(id, { status: "error", finishedAt: new Date().toISOString(), error: `the dream process exited (${signal ?? code ?? "?"}) without a result${tail ? `: ${tail.slice(0, 300)}` : ""}` });
		this.dueCache = undefined;
		this.app.bump("dream");
	}

	async cancel(id: string, why = "cancelled"): Promise<void> {
		const run = await this.app.state.run(id);
		if (!run) throw notFound(`run ${id}`);
		if (run.status !== "running") return;
		if (alive(run.pid)) {
			try {
				process.kill(-(run.pid as number), "SIGTERM");
			} catch {
				try {
					process.kill(run.pid as number, "SIGTERM");
				} catch {
					// gone
				}
			}
		}
		await this.app.state.updateRun(id, { status: "cancelled", finishedAt: new Date().toISOString(), error: why });
		this.dueCache = undefined;
		this.app.bump("dream");
	}

	/** The runner could not finish: record why. */
	async fail(id: string, error: string): Promise<void> {
		const run = await this.app.state.run(id);
		if (!run || run.status !== "running") return;
		await this.app.state.updateRun(id, { status: "error", finishedAt: new Date().toISOString(), error: error.slice(0, 2000) });
		this.dueCache = undefined;
		this.app.bump("dream");
	}

	logFile(id: string): string {
		return join(this.app.paths.dreamLogs, `${id.replace(/[^A-Za-z0-9-]/g, "")}.log`);
	}

	logTail(id: string, lines = 200): string {
		const file = this.logFile(id);
		if (!existsSync(file)) return "";
		const size = statSync(file).size;
		const text = readFileSync(file, "utf-8");
		const all = text.trimEnd().split("\n");
		return (all.length > lines ? all.slice(-lines) : all).join("\n") + (size ? "\n" : "");
	}

	/** Everything a dream starts from. */
	async workspace(runId: string): Promise<DreamWorkspace> {
		const { state, mem, cfg, paths } = this.app;
		const run = await state.run(runId);
		if (!run) throw notFound(`run ${runId}`);
		if (run.status !== "running") throw new HttpError(409, `run ${runId} is ${run.status}`);
		// The dream files sessions under their folders' current keys: a folder that got a git remote since has its
		// memory moved to the new key first, so the dream sees it there (and never writes to the old scope).
		await this.app.followRemotes().catch((err) => this.app.log(`could not move the scopes of folders that got a git remote: ${err instanceof Error ? err.message : err}`));
		// What the dream works on: approved memory plus what is still proposed, in step with the approved branch.
		await this.app.lock(() => this.app.reviews.sync());
		const ref = this.app.reviewBranch;
		const opts = run.opts as { sinceDays?: number; maxSessions?: number };
		let cutoff = await state.get<number>("cutoffMs");
		if (cutoff === undefined) {
			cutoff = Date.now() - (opts.sinceDays ?? cfg.dream.firstRunLookbackDays) * DAY;
			await state.set("cutoffMs", cutoff);
		} else if (opts.sinceDays !== undefined && Number.isFinite(opts.sinceDays)) {
			cutoff = Math.min(cutoff, Date.now() - opts.sinceDays * DAY);
			if (run.kind === "run") await state.set("cutoffMs", cutoff);
		}
		const [notes, mainIds, scopes, prompts, marks, rejected, inbox, comments, agents] = await Promise.all([
			this.app.notes(ref),
			mem.noteIds(MAIN),
			mem.scopes(ref),
			mem.prompts(MAIN),
			state.marks(),
			state.rejectedTitles(40),
			state.inbox("pending"),
			state.comments(),
			state.agentsProposals({ status: "pending" }),
		]);
		return {
			runId,
			kind: run.kind,
			opts,
			config: cfg,
			home: paths.home,
			state: { cutoffMs: cutoff, sessions: marks, rejected },
			// An item kept in a folder that got a git remote since belongs to the remote's key now.
			inbox: await Promise.all(inbox.map(async (i) => ({ ...i, projectKey: await this.app.currentKey(i.cwd, i.projectKey) }))),
			comments: comments.filter((c) => !c.processedRun).map(({ processedAt: _at, ...c }) => c),
			notes,
			pending: notes.filter((n) => !mainIds.has(n.id)).map((n) => n.id),
			scopes,
			prompts,
			agentsPending: agents.map((a) => ({ id: a.id, repoRoot: a.repoRoot, rel: a.rel })),
		};
	}
}
