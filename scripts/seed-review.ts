/**
 * Fill a server with a made-up dream so the review can be tried by hand:
 *
 *   WMEM_URL=http://127.0.0.1:17433 bun scripts/seed-review.ts
 *
 * It proposes one change of every kind against the notes the server has
 * (new notes, an edit, a move, a replacement, a closed note, confirmations,
 * a risky note, a skill, an AGENTS.md edit) and leaves a review comment.
 * Run it again to add a second dream's proposals to the same dreams branch.
 * Never point it at the real server unless you want those proposals there.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOp, type DreamSubmit, type DreamSubmitResult, type DreamWorkspace, type Evidence, isSessionEvidence, type Op, type ReportItem, today, Workspace } from "../packages/core/src/index.ts";

const base = (process.env.WMEM_URL || "http://127.0.0.1:17433").replace(/\/+$/, "");

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${base}${path}`, { method, headers: { "x-wmem-client": "seed", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
	const data = (await res.json()) as T & { error?: string };
	if (!res.ok) throw new Error(`${method} ${path}: ${data.error}`);
	return data;
}

const run = await api<{ id: string }>("POST", "/api/dream/begin", { mode: "run", pid: process.pid });
const wsData = await api<DreamWorkspace>("GET", `/api/dream/workspace?run=${run.id}`);
const ws = new Workspace(wsData.notes, today(), { pending: wsData.pending, scopes: wsData.scopes });
const active = wsData.notes.filter((n) => n.status === "active" && n.enabled && !wsData.pending.includes(n.id));
const withSession = active.filter((n) => n.evidence.some((e) => isSessionEvidence(e) && e.e.length));
if (withSession.length < 6) throw new Error("the server needs some notes with session evidence first (let it dream once, or give it a copy of a memory repository)");
const projects = [...new Set(active.map((n) => n.scope).filter((s) => s !== "global"))];
const pick = (i: number) => withSession[(i * 7) % withSession.length];
const evOf = (i: number): Evidence[] => pick(i).evidence.filter((e) => isSessionEvidence(e)).slice(0, 2);
const used = new Set<string>();
const fresh = (i: number) => {
	let n = pick(i);
	for (let k = 0; used.has(n.id); k++) n = withSession[(i * 7 + k) % withSession.length];
	used.add(n.id);
	return n;
};
const [upd, sup, dep, mov, conf1, conf2] = [fresh(1), fresh(2), fresh(3), fresh(4), fresh(5), fresh(6)];
const proj = projects[0] ?? "global";
const other = projects.find((p) => p !== mov.scope) ?? "global";

const repo = join(tmpdir(), "wmem-seed-repo");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "AGENTS.md"), "# Demo repo\n\n## Workflow\n\n- Run `make test` before committing.\n- Deploy with `make deploy`.\n");

const ops: Array<{ op: Op; ev: Evidence[]; why: string; check?: ReportItem["check"]; newer?: Evidence[]; remark?: string }> = [
	{
		op: { op: "add", ref: "a1", scope: "global", type: "preference", title: "Перед коммитом показывать diff и ждать подтверждения", body: "Не коммитить молча: сначала `git diff --stat`, затем короткое описание изменений. Коммит — только после явного «да».", when: "любой коммит", index: "always", rationale: "", evidence: [] },
		ev: evOf(10),
		why: "Пользователь дважды поправил агента, который закоммитил без спроса; это постоянное правило работы.",
		check: { verdict: "supported", reason: "", corrected: false },
	},
	{
		op: { op: "add", ref: "a2", scope: proj, type: "pitfall", title: "Сборка падает без `bun install --frozen-lockfile` после переключения ветки", body: "После `git switch` зависимости расходятся с lockfile.\n\n```sh\nbun install --frozen-lockfile\n```\n\nПроверено на двух ветках.", when: "ошибки сборки после смены ветки", index: "pointer", rationale: "", evidence: [] },
		ev: evOf(11),
		why: "Ошибка повторилась в двух сессиях, причина каждый раз искалась заново.",
		check: { verdict: "partial", reason: "В сессиях это видно только для одного пакета — формулировка сужена.", corrected: true },
	},
	{
		op: { op: "add", ref: "a3", scope: proj, type: "procedure", title: "Установка тулчейна: curl -fsSL https://example.com/install.sh | sh", body: "Скрипт ставит всё нужное:\n\n```sh\ncurl -fsSL https://example.com/install.sh | sh\n```", index: "none", rationale: "", evidence: [] },
		ev: evOf(12),
		why: "Процедура установки, которая сработала.",
		check: { verdict: "supported", reason: "", corrected: false },
	},
	{
		op: { op: "update", ref: "u1", id: upd.id, title: `${upd.title.replace(/\.$/, "")} (уточнено)`, body: `${upd.body}\n\nДополнение: это проверено ещё в одной сессии; порядок шагов важен.`, rationale: "", evidence: [] },
		ev: evOf(13),
		why: "Новая сессия добавила деталь, которой не было в заметке.",
		check: { verdict: "supported", reason: "", corrected: false },
	},
	{
		op: { op: "supersede", ref: "s1", id: sup.id, replacement: { title: `${sup.title.slice(0, 120)} — теперь иначе`, body: "Старый способ больше не работает: инструмент заменён. Актуальный порядок действий описан здесь.", when: sup.when, index: sup.index }, rationale: "", evidence: [] },
		ev: evOf(14),
		why: "В свежей сессии пользователь явно сказал, что прежний способ устарел.",
		check: { verdict: "supported", reason: "", corrected: false },
		newer: sup.evidence.slice(0, 1),
	},
	{ op: { op: "deprecate", ref: "d1", id: dep.id, rationale: "", evidence: [] }, ev: evOf(15), why: "Артефакт, о котором заметка, удалён; она больше не нужна.", check: { verdict: "supported", reason: "", corrected: false } },
	{ op: { op: "update", ref: "m1", id: mov.id, scope: other, rationale: "", evidence: [] }, ev: evOf(16), why: "Заметка относится к другому проекту: все её сессии шли там.", remark: "перенос: все доказательства из одного проекта" },
	{ op: { op: "confirm", ref: "c1", id: conf1.id, rationale: "", evidence: [] }, ev: [{ s: evOf(17)[0]?.s ?? "01a1b2c3-0000-7000-8000-00000000c001", e: ["seedc001"], date: today(), kind: "observed" }], why: "Заметка снова пригодилась." },
	{ op: { op: "confirm", ref: "c2", id: conf2.id, rationale: "", evidence: [] }, ev: [{ s: evOf(18)[0]?.s ?? "01a1b2c3-0000-7000-8000-00000000c002", e: ["seedc002"], date: today(), kind: "user" }], why: "Пользователь повторил это правило." },
	{ op: { op: "skill", ref: "k1", scope: "global", name: "release-checklist", description: "Чеклист релиза пакета: версия, changelog, тег, публикация", body: "1. Поднять версию в `package.json`.\n2. Добавить запись в `CHANGELOG.md`.\n3. `git tag vX.Y.Z && git push --tags`.\n4. Дождаться публикации в CI.", rationale: "", evidence: [] }, ev: evOf(19), why: "Процедура успешно прошла в двух сессиях и повторится." },
];

const items: ReportItem[] = [];
for (const o of ops) {
	const res = applyOp(ws, o.op, { evidence: o.ev, projectScope: proj });
	if (!res.ok) {
		console.log(`skipped ${o.op.ref}: ${res.reason}`);
		continue;
	}
	const c = res.change;
	const n = ws.find(c.newId ?? c.noteId ?? "");
	items.push({ kind: c.kind, scope: n?.scope ?? c.scope, id: c.newId ?? c.noteId, title: n?.title ?? c.title, body: n?.body, index: n?.index, when: n?.when, old: c.kind === "superseded" ? { id: c.noteId, title: sup.title } : c.oldTitle ? { title: c.oldTitle } : undefined, from: c.from, evidence: o.ev, why: [o.why], check: o.check, risky: [], newerEvidence: o.newer, note: o.remark });
}

const sessionTitles: Record<string, string> = {};
for (const it of items) for (const e of it.evidence) sessionTitles[e.s] ??= `Сессия ${e.s.slice(0, 8)}`;
const sub: DreamSubmit = {
	runId: run.id,
	status: "ok",
	changes: ws.changes(),
	votes: { [conf1.id]: { helpful: 1, harmful: 0 } },
	report: {
		runId: run.id,
		date: today(),
		language: "Russian",
		models: { cards: wsData.config.models.cards.model, analyze: wsData.config.models.analyze.model, verify: wsData.config.models.verify.model },
		usage: { cards: { calls: 12, input: 240_000, output: 9000, cacheRead: 0, cost: 0.41, failures: 0 }, analyze: { calls: 3, input: 90_000, output: 14_000, cacheRead: 0, cost: 1.12, failures: 0 }, verify: { calls: 3, input: 60_000, output: 5000, cacheRead: 0, cost: 0.2, failures: 0 } },
		sessions: Object.keys(sessionTitles).map((s) => ({ sessionId: s, date: today(), project: "demo", title: sessionTitles[s], outcome: "success", learnings: 2 })),
		sessionTitles,
		inbox: 0,
		feedback: 0,
		unhandled: [],
		items,
		rejected: [
			{ ref: "x1", op: "add", title: "Пользователь предпочитает табы пробелам", reason: "unsupported — в сессиях этого нет" },
			{ ref: "x2", op: "deprecate", title: "Старая заметка о деплое", reason: "contradicted — более новая сессия всё ещё пользуется ею" },
		],
		agents: [],
		indexes: [],
		votes: 1,
		problems: [],
		scopeTitles: {},
	},
	marks: {},
	inboxDone: [],
	commentsDone: [],
	agents: [{ projectKey: "local:/tmp/wmem-seed-repo", repoRoot: repo, rel: "AGENTS.md", summary: "tests run with bun, not make", edits: [{ old: "- Run `make test` before committing.", new: "- Run `bun test` before committing." }, { old: "", new: "## Releases\n\n- Bump the version and add a CHANGELOG entry in the same commit." }], rationale: ["В двух сессиях агент запускал `make test`, которого больше нет.", "Пользователь дважды просил держать версию и changelog в одном коммите."] }],
	sessions: Object.keys(sessionTitles).length,
	cost: 1.73,
};
const result = await api<DreamSubmitResult>("POST", "/api/dream/submit", sub);
if (result.url) await api("POST", "/api/review/comments", { body: "Раздели эту заметку на две: про порядок шагов и про причины.", noteId: upd.id });
console.log(`${base}: ${result.items} item(s) to decide on the dreams branch (run ${run.id}) — ${result.url ?? "nothing proposed"}`);
