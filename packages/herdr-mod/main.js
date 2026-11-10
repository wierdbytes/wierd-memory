// Memory: what wierd-memory remembers for pi, beside Files and Changes, drawn
// like the sidebar (the wierd-agents mod): a list of cards on the chrome.
//
// Top to bottom: Review (what dreams propose, to accept, edit or reject), Inbox
// (what waits for the next dream), the focused pane's project and Global (what
// pi loads into a session there), then every other project, folded. A mark says
// how a note reaches pi: always in its context, read when relevant, or found by
// search only. Actions come in three steps, so nothing is crowded: a row's
// frequent ones show under the pointer (✓ ✕ on a proposal), a card (Enter) has
// its main ones as buttons, and everything else is in a menu (⋯, a right click,
// `.`): close, move, delete, history, a reason, a comment for the dream, a new
// dream... The dream's state is at the bottom, its menu behind it.
//
// Memory lives in the wierd-memory server (a local HTTP API, see api.js); this
// file asks it, keeps what the panel shows and does what it's asked. list.js
// draws the list, cards.js a note (and the forms), review.js a proposal, menu.js
// the menus: a copy of this mod opened as a popup or a dialog (see init).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState } from "gpui-base";
import { spaces, panes, focused, layout, exec, hc, theme, settings, run, terminals, openOverlay, notify, appHome, home, nextCommand, readTextFile, props } from "herdr";
import { Api, DEFAULT_SERVER } from "./api.js";
import { icon, mono, hint, iconButton, backButton, scopeAvatar, leadIcon, spaceColors } from "./ui.js";
import { ago, stamp, running, plural, projectScope } from "./text.js";
import { scrollList } from "./scroll.js";
import { buildList } from "./list.js";
import { noteCard, inboxCard, skillCard, scopeCard, noteForm, textForm } from "./cards.js";
import { reviewCard, agentsCard, commentsView, decidedView, aboutView, summary, countsLine } from "./review.js";
import { MenuPopup, Dialog, menuItems, menuHeight, menuWidth } from "./menu.js";

// The server answers a waiting request (GET /api/wait) as soon as anything
// changes, or after this many seconds.
const WAIT_S = 25;
// When the server can't be reached: look again this often, then (after a few
// tries) this often.
const RETRY_MS = 5_000;
const RETRY_SLOW_MS = 30_000;
// "Open the file" runs $VISUAL, else $EDITOR, else this, in a split beside the focused pane.
const EDITOR = "nvim";
// The keys on a Russian layout (the same physical keys).
const LATIN = { "ф": "a", "у": "e", "ч": "x", "shift-ч": "shift-x", "Ч": "shift-x", "с": "c", "щ": "o", "з": "p", "о": "j", "л": "k", "ю": "." };
// The dialog is this wide (a menu: as its widest item).
const DIALOG_W = 420;

// Where the focused pane works (as Files reads it). Memory lives on this
// computer, so a pane on another machine has no project here.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const remote = f?.pane === null ? Boolean(f.terminal?.includes("/")) : Boolean(space?.machine);
  return { cwd: remote ? null : pane?.cwd || f?.cwd || space?.folder || null, space: space?.id ?? null };
}

// The path from the layout's root to this mod's block, or null if it isn't there.
function pathTo(node, path = []) {
  if (!node) return null;
  const here = [...path, node];
  if (node.content?.mod === "wierd-memory") return here;
  for (const child of node.children ?? []) {
    const found = pathTo(child, here);
    if (found) return found;
  }
  return null;
}

// Whether the panel is on screen: no hidden node on the way, and every stack
// on the way shows the child that leads here. Elsewhere (a pane, a window) it is.
function onScreen() {
  const path = pathTo(layout());
  if (!path) return true;
  return path.every((node, i) => {
    if (node.hidden) return false;
    const next = path[i + 1];
    if (node.type !== "stack" || !next) return true;
    return (node.active ?? node.children?.[0]?.id) === next.id;
  });
}

const message = (e) => String(e?.message ?? e).slice(0, 300);
// A menu's or a question's name in the command that answers it: random, so
// another copy of the panel never takes it for its own.
const token = () => Math.random().toString(36).slice(2, 10);
// What the cursor is on, as a name that outlives a reload of the list.
const targetKey = (x) => !x ? null
  : x.kind === "review" ? `r:${x.item.key}`
  : x.kind === "agents" ? `a:${x.proposal.id}`
  : x.kind === "inbox" ? `i:${x.item.id}`
  : x.kind === "note" ? `n:${x.note.id}`
  : x.kind === "skill" ? `s:${x.skill.scope}/${x.skill.name}`
  : x.kind === "fold" ? `f:${x.key}`
  : `v:${x.view.kind}`;

export default class WierdMemory extends View {
  init(_props, cx) {
    // A copy opened as the panel's menu or question draws only that.
    const p = props();
    if (p?.menu || p?.dialog) {
      this.overlay = p.menu ? new MenuPopup() : new Dialog();
      this.overlay.init(cx);
      return;
    }
    // Set once server.json is read (`wmem herdr install` writes it).
    this.server = DEFAULT_SERVER;
    this.api = null;
    // null: not asked yet; true: the server can't be reached.
    this.down = null;
    this.rev = null;
    // cwd → the project pi loads memory for there (the server resolves it).
    this.contexts = new Map();
    this.asked = new Set();
    // Which cards and folds are open, as the person left them (the defaults aren't kept).
    this.open = JSON.parse(localStorage.getItem("open") ?? "{}");
    // The open page: { kind: "note" | "inbox" | "review" | "agents" | "skill" | "scope", id }
    // or { kind: "comments" | "decided" | "about" }; null: the list.
    this.view = null;
    // A form over the page (or the list): { kind: "edit" | "review" | "new" |
    // "remember" | "comment" | "reason" | "charter", ... }.
    this.form = null;
    // Folded parts of the open page.
    this.fold = {};
    // A request that changes memory is running ("accept", "save"…): buttons wait.
    this.busy = null;
    // Evidence read so far: session id → { name, started, cwd, file, entries }.
    this.ev = {};
    // Read when a page asks: a note's history, a scope's session text, the
    // default purposes, older decisions.
    this.history = {};
    this.sessionText = {};
    this.prompts = null;
    this.decisions = null;
    // A proposal's reach, type or scope chosen on its card, until it's accepted:
    // key → { version, edit } (a proposal a dream rewrote since drops it).
    this.drafts = {};
    // The menu and the question waiting for their answer: { token, items } / { token, then }.
    this.pending = null;
    this.asking = null;
    this.query = "";
    this.cursor = -1;
    this.cursorKey = null;
    this.flat = [];
    this.hovered = null;
    this.width = 368;
    // The list's scroll position; `follow`: bring the cursor's row into view.
    this.scroll = {};
    this.follow = false;
    this.handle = cx.focus_handle();
    // The text fields that have the keyboard now.
    this.fields = new Set();
    const track = (name, state) => {
      state.on("focus", (_e, cx) => {
        this.fields.add(name);
        cx.notify();
      });
      state.on("blur", (_e, cx) => {
        this.fields.delete(name);
        cx.notify();
      });
      return state;
    };
    this.input = track("search", InputState.new({ placeholder: "Search memory" }));
    this.input.on("change", (_e, cx) => {
      const q = this.input.value();
      if (q === this.query) return;
      this.query = q;
      this.cursor = q.trim() ? 0 : -1;
      this.cursorKey = null;
      this.scroll.offset = 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.openAt(this.cursor, cx));
    const area = (name, placeholder, rows = 5) => {
      const s = TextareaState.new({ placeholder, rows });
      s.set_auto_grow(rows, 30);
      s.set_soft_wrap(true);
      return track(name, s);
    };
    this.fTitle = track("title", InputState.new({ placeholder: "One line: what pi should know" }));
    this.fWhen = track("when", InputState.new({ placeholder: "When it applies (empty: always)" }));
    this.fBody = area("body", "The specifics, in Markdown", 8);
    this.fRemember = area("remember", "What the next dream should know");
    this.fComment = area("comment", "“Split it”, “move it to Global”, “shorter”…", 3);
    this.fReason = track("reason", InputState.new({ placeholder: "Why not (for the next dream)" }));
    this.fCharter = area("charter", "What belongs in this scope", 4);
    // In a form ⌘Enter saves; Enter in a one-line field goes to the next one.
    const submit = (state, next) => state.on("submit", (e, cx) => {
      if (!this.form) return;
      if (e?.secondary || next === "save") this.save(cx);
      else next?.focus();
    });
    submit(this.fTitle, this.fWhen);
    submit(this.fWhen, this.fBody);
    for (const s of [this.fBody, this.fRemember, this.fComment, this.fCharter]) submit(s, null);
    submit(this.fReason, "save");
    cx.spawn((cx) => this.live(cx));
    // keys.json: "wierd-memory.search" puts the keyboard in the search field;
    // "wierd-memory.open-<note id>" opens that note's card; "wierd-memory.review"
    // goes to what dreams propose. A menu's or a question's answer comes this way too.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        // One command failing (a menu item on something that went meanwhile)
        // must not end the loop: every later menu and question answers through it.
        try {
          this.command(c, cx);
        } catch (e) {
          notify({ title: "Memory: that didn't work", body: message(e), level: "error" });
        }
        cx.notify();
      }
    });
  }

  command(c, cx) {
    if (c === "search") {
      this.leave();
      this.input.focus();
    } else if (c === "review") {
      this.goReview();
      this.handle.focus();
    } else if (c === "focus") {
      if (!this.typing) this.handle.focus();
    } else if (c.startsWith("open-")) {
      const found = this.noteById(c.slice(5));
      if (found) this.show(found, cx);
    } else if (c.startsWith("menu-")) {
      const [, tok, i] = /^menu-([a-z0-9]+)-(\d+)$/.exec(c) ?? [];
      if (tok && this.pending?.token === tok) {
        const it = this.pending.items[Number(i)];
        this.pending = null;
        if (!this.form) this.handle.focus();
        it?.run?.(cx);
      }
    } else if (c.startsWith("dialog-")) {
      const tok = c.slice(7);
      if (this.asking?.token === tok) {
        const then = this.asking.then;
        this.asking = null;
        this.handle.focus();
        then(cx);
      }
    }
  }

  get typing() {
    return this.fields.size > 0;
  }

  // ── data ────────────────────────────────────────────────────────────────

  // The server's address, then one waiting request after another: each answers
  // when memory changed. A server that is away is asked again, less and less often.
  async live(cx) {
    try {
      const url = JSON.parse((await readTextFile(`${appHome()}/mods/wierd-memory/server.json`)) ?? "{}").url;
      if (typeof url === "string" && /^https?:\/\/[^/]/.test(url)) this.server = url.replace(/\/+$/, "");
    } catch {
      // No file, or not JSON: the default address.
    }
    this.api = new Api(this.server);
    let fails = 0;
    for (;;) {
      try {
        const status = await this.api.get("/api/status");
        const back = this.down !== false;
        this.status = status;
        this.down = false;
        fails = 0;
        if (back) this.asked.clear();
        if (back || status.rev !== this.rev) {
          this.rev = status.rev;
          this.changed(cx);
        }
        cx.notify();
      } catch (e) {
        fails += 1;
        this.down = true;
        this.error = message(e);
        cx.notify();
        await cx.sleep(fails <= 3 ? RETRY_MS : RETRY_SLOW_MS);
        continue;
      }
      try {
        await this.api.get(`/api/wait?rev=${this.rev}&timeout=${WAIT_S}`);
      } catch {
        // Cut short (the server went away, the request timed out): the status
        // request above says which.
        await cx.sleep(1_000);
      }
    }
  }

  // Memory changed: read it again now if the panel shows, else when it shows.
  changed(cx) {
    if (onScreen()) this.refresh(cx);
    else this.stale = true;
  }

  refresh(cx) {
    if (!this.api) return;
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    const { cwd } = location();
    cx.spawn(async (cx) => {
      const api = this.api;
      try {
        const [status, scopes, notes, inbox, review, skills, context] = await Promise.all([
          api.get("/api/status"),
          api.get("/api/scopes"),
          api.get("/api/notes"),
          api.get("/api/inbox"),
          api.get("/api/review"),
          api.get("/api/skills").catch(() => []),
          cwd ? api.get(`/api/context?cwd=${encodeURIComponent(cwd)}`).catch(() => null) : null,
        ]);
        this.status = status;
        this.setData({ scopes, notes: notes?.notes ?? [], inbox: inbox ?? [], review, skills: skills ?? [] });
        if (cwd && context) this.setContext(cwd, context);
        this.error = null;
        // What a page read may have changed with memory: read again what shows.
        this.history = {};
        this.sessionText = {};
        this.loadPage(cx);
        this.loadEvidence(cx);
      } catch (e) {
        // The waiting loop notices a server that went away and says so.
        this.error = message(e);
      } finally {
        this.loading = false;
        if (this.again) {
          this.again = false;
          this.refresh(cx);
        }
        cx.notify();
      }
    });
  }

  setData({ scopes, notes, inbox, review, skills }) {
    const byScope = new Map();
    const byId = new Map();
    for (const n of notes) {
      byId.set(n.id, n);
      if (!byScope.has(n.scope)) byScope.set(n.scope, []);
      byScope.get(n.scope).push(n);
    }
    this.data = { scopes, byScope, byId, inbox, review: review ?? null, skills };
  }

  setContext(cwd, c) {
    const key = c.project?.key ?? "";
    this.contexts.set(cwd, { scope: c.scope ?? null, name: c.project?.name ?? "", key, root: c.project?.root ?? null, newScope: !c.scope && key ? projectScope(key) : null });
  }

  // The project of a folder the focused pane moved to.
  askContext(cwd, cx) {
    cx.spawn(async (cx) => {
      try {
        this.setContext(cwd, await this.api.get(`/api/context?cwd=${encodeURIComponent(cwd)}`));
        cx.notify();
      } catch {
        // Asked again once the server answers (see live()).
      }
    });
  }

  // A small read for the open page, once: the note's history (its fold open),
  // the scope's purpose and session text.
  loadPage(cx) {
    const v = this.view;
    if (v?.kind === "note" && this.fold.history) this.loadHistory(v.id, cx);
    if (v?.kind === "scope") {
      if (!this.prompts) this.read("prompts", "/api/prompts", (out) => (this.prompts = out), cx);
      if (this.fold.session) this.loadSessionText(v.id, cx);
    }
  }

  // GET `path` in the background, once at a time per `name`; `set` takes the answer.
  read(name, path, set, cx, fail) {
    this.reading ??= new Set();
    if (this.reading.has(name) || !this.api) return;
    this.reading.add(name);
    cx.spawn(async (cx) => {
      try {
        set(await this.api.get(path));
      } catch (e) {
        fail?.(message(e));
      } finally {
        this.reading.delete(name);
        cx.notify();
      }
    });
  }

  loadHistory(id, cx) {
    if (this.history[id]?.entries) return;
    this.history[id] ??= { loading: true };
    this.read(`history:${id}`, `/api/notes/${encodeURIComponent(id)}/history`, (entries) => (this.history[id] = { entries: entries ?? [] }), cx, (error) => (this.history[id] = { error }));
  }

  loadSessionText(scopeId, cx) {
    if (this.sessionText[scopeId]?.text !== undefined) return;
    const scope = this.data?.scopes.find((s) => s.id === scopeId);
    const cwd = scopeId === "global" ? home() || "/" : scope?.root;
    if (!cwd) {
      this.sessionText[scopeId] = { error: "the project's folder isn't known" };
      return;
    }
    this.sessionText[scopeId] ??= { loading: true };
    this.read(`session:${scopeId}`, `/api/context?cwd=${encodeURIComponent(cwd)}`, (c) => (this.sessionText[scopeId] = { text: c?.injection?.text ?? null, tokens: c?.injection?.tokens ?? 0 }), cx, (error) => (this.sessionText[scopeId] = { error }));
  }

  loadDecisions(cx) {
    if (this.busy) return;
    this.busy = "more";
    this.read("decisions", "/api/review/decisions?limit=200", (list) => {
      this.decisions = list ?? [];
      this.busy = null;
    }, cx, () => (this.busy = null));
  }

  // What the open card cites: each session's name and the cited lines of its digest.
  loadEvidence(cx) {
    const card = this.current();
    const list = card?.kind === "note" ? card.note.evidence : card?.kind === "review" ? card.item.evidence : null;
    if (!list?.length || this.evBusy || !this.api) return;
    const refs = list.filter((ev) => {
      if (ev.s === "review" || ev.s === "manual") return false;
      if (ev.s.startsWith("inbox:") || ev.s.startsWith("comment:")) return !(ev.s in this.ev);
      const have = this.ev[ev.s];
      return !have || (ev.e ?? []).some((id) => !(id in have.entries));
    });
    if (!refs.length) return;
    this.evBusy = true;
    cx.spawn(async (cx) => {
      let ok = false;
      try {
        const out = await this.api.post("/api/evidence", { refs: refs.map(({ s, e }) => ({ s, e: e ?? [] })) });
        for (const ref of refs) {
          if (ref.s.startsWith("inbox:")) {
            this.ev[ref.s] = out.inbox?.[ref.s.slice(6)] ?? null;
            continue;
          }
          if (ref.s.startsWith("comment:")) {
            this.ev[ref.s] = out.comments?.[ref.s.slice(8)] ?? null;
            continue;
          }
          const got = out.sessions?.[ref.s] ?? { missing: true };
          const entries = { ...(this.ev[ref.s]?.entries ?? {}) };
          for (const id of ref.e ?? []) entries[id] = got.entries?.[id] ?? null;
          this.ev[ref.s] = { ...got, entries };
        }
        this.evError = null;
        ok = true;
      } catch (e) {
        this.evError = message(e);
      } finally {
        this.evBusy = false;
        // Another card may have opened meanwhile.
        if (ok) this.loadEvidence(cx);
        cx.notify();
      }
    });
  }

  // ── what is where ───────────────────────────────────────────────────────

  isOpen(key, fallback) {
    return key in this.open ? this.open[key] : fallback;
  }

  toggle(key, fallback, cx) {
    this.open[key] = !this.isOpen(key, fallback);
    localStorage.setItem("open", JSON.stringify(this.open));
    cx.notify();
  }

  noteById(id) {
    const note = this.data?.byId.get(id);
    return note ? { kind: "note", note, scope: this.data.scopes.find((s) => s.id === note.scope) ?? null } : null;
  }

  // The proposal about a note, if one waits.
  proposalOf(noteId) {
    const item = this.data?.review?.items.find((x) => (x.ids ?? []).includes(noteId));
    return item ? { kind: "review", item } : null;
  }

  // What still waits for a decision: notes and skills, then AGENTS.md proposals.
  proposals() {
    const r = this.data?.review;
    if (!r) return [];
    return [...r.items.map((item) => ({ kind: "review", item })), ...(r.agents ?? []).filter((p) => p.status === "pending" || p.status === "failed").map((proposal) => ({ kind: "agents", proposal }))];
  }

  // Every scope a note can go to: the approved ones, and the focused project's
  // when it has no memory yet.
  scopeChoices() {
    const list = [...(this.data?.scopes ?? [])];
    const ctx = this.ctx;
    if (ctx?.newScope && !list.some((s) => s.id === ctx.newScope)) list.push({ id: ctx.newScope, key: ctx.key, name: ctx.name, root: ctx.root });
    return list;
  }

  // The open page's note, inbox item, proposal…, from the latest read; gone if it went.
  current() {
    const v = this.view, d = this.data;
    if (!v || !d) return null;
    switch (v.kind) {
      case "note":
        return this.noteById(v.id) ?? { kind: "gone" };
      case "inbox": {
        const item = d.inbox.find((x) => x.id === v.id);
        return item ? { kind: "inbox", item } : { kind: "gone" };
      }
      case "review": {
        const item = d.review?.items.find((x) => x.key === v.id);
        return item ? { kind: "review", item, review: d.review } : { kind: "gone" };
      }
      case "agents": {
        const proposal = d.review?.agents?.find((x) => x.id === v.id && (x.status === "pending" || x.status === "failed"));
        return proposal ? { kind: "agents", proposal, review: d.review } : { kind: "gone" };
      }
      case "skill": {
        const skill = (d.skills ?? []).find((s) => s.scope === v.scope && s.name === v.name);
        return skill ? { kind: "skill", skill } : { kind: "gone" };
      }
      case "scope": {
        const scope = d.scopes.find((s) => s.id === v.id);
        return scope ? { kind: "scope", scope } : { kind: "gone" };
      }
      default:
        return { kind: v.kind };
    }
  }

  // ── going places ────────────────────────────────────────────────────────

  // A page by itself (comments, decisions, a scope).
  go(view, cx) {
    this.view = view;
    this.form = null;
    this.fold = {};
    this.decisions = null;
    this.fields.clear();
    this.handle.focus();
    this.loadPage(cx);
    cx.notify();
  }

  // A row's page: a note, a proposal, an inbox item, a skill.
  show(item, cx) {
    const view =
      item.kind === "note" ? { kind: "note", id: item.note.id }
      : item.kind === "inbox" ? { kind: "inbox", id: item.item.id }
      : item.kind === "review" ? { kind: "review", id: item.item.key }
      : item.kind === "agents" ? { kind: "agents", id: item.proposal.id }
      : item.kind === "skill" ? { kind: "skill", scope: item.skill.scope, name: item.skill.name }
      : null;
    if (!view) return;
    this.go(view, cx);
    this.loadEvidence(cx);
  }

  openAt(i, cx) {
    const item = this.flat[i];
    if (!item) return;
    this.cursor = i;
    this.cursorKey = targetKey(item);
    if (item.kind === "fold") this.toggle(item.key, item.fallback, cx);
    else if (item.kind === "view") this.go(item.view, cx);
    else this.show(item, cx);
  }

  // Back to the list, without a redraw of its own.
  leave() {
    this.view = null;
    this.form = null;
    this.fields.clear();
    // The row it came from stays in view.
    this.follow = true;
  }

  back(cx) {
    this.leave();
    this.handle.focus();
    cx.notify();
  }

  // The list with Review open, from its top, the cursor on its first proposal.
  goReview() {
    this.leave();
    if (this.query) {
      this.input.set_value("");
      this.query = "";
    }
    this.open.review = true;
    localStorage.setItem("open", JSON.stringify(this.open));
    this.scroll.offset = 0;
    this.cursorKey = targetKey(this.proposals()[0]);
    this.follow = true;
  }

  // The next or previous proposal's card, from a proposal's card.
  step(dir, cx) {
    const all = this.proposals();
    const v = this.view;
    const at = all.findIndex((p) => (p.kind === "review" ? v?.kind === "review" && p.item.key === v.id : v?.kind === "agents" && p.proposal.id === v.id));
    const next = all[at + dir];
    if (next) this.show(next, cx);
  }

  // After deciding the proposal at `at` from its card: the card of the one now in its place.
  advance(at, cx) {
    const all = this.proposals();
    this.form = null;
    this.fields.clear();
    if (all.length) {
      const next = all[Math.min(at, all.length - 1)];
      this.cursorKey = targetKey(next);
      this.show(next, cx);
    } else this.leave();
  }

  hover(id, over, cx) {
    if (over && Date.now() - (this.scrolledAt ?? 0) < 300) return;
    const next = over ? id : this.hovered === id ? null : this.hovered;
    if (next === this.hovered) return;
    this.hovered = next;
    cx.notify();
  }

  // ── a choice on a card ──────────────────────────────────────────────────

  // What the person chose for a proposal and hasn't accepted yet: { index?, type?, scope? }.
  draftOf(item) {
    const d = this.drafts[item.key];
    return d && d.version === item.version ? d.edit : {};
  }

  clearDraft(item, cx) {
    delete this.drafts[item.key];
    cx.notify();
  }

  // A note's or a proposal's index, type or scope as its chip shows it.
  chosen(subject, field) {
    if (subject.kind === "note") return subject.note[field];
    return this.draftOf(subject.item)[field] ?? (field === "scope" ? subject.item.scope : subject.item.note[field]);
  }

  // A chip's choice: a note's is saved at once; a proposal's waits for Accept
  // (choosing what it was takes the change back).
  choose(subject, field, value, cx) {
    if (subject.kind === "note") {
      if (subject.note[field] !== value) this.patchNote(subject.note, { [field]: value }, cx);
      return;
    }
    const item = subject.item;
    const edit = { ...this.draftOf(item) };
    if (value === (field === "scope" ? item.scope : item.note[field])) delete edit[field];
    else edit[field] = value;
    if (Object.keys(edit).length) this.drafts[item.key] = { version: item.version, edit };
    else delete this.drafts[item.key];
    cx.notify();
  }

  // ── menus and questions ─────────────────────────────────────────────────

  // The menu of what the panel shows: a popup at the pointer (menu.js).
  menu(target, cx) {
    const items = menuItems(this, target).filter(Boolean);
    if (!items.length) return;
    const tok = token();
    this.pending = { token: tok, items };
    // What the popup draws: everything but what an item does.
    const shown = items.map(({ run: _run, ...it }) => ({ ...it, hint: it.hint ?? "", danger: Boolean(it.danger), sep: Boolean(it.sep), off: Boolean(it.off), check: Boolean(it.check) }));
    openOverlay({ mod: "wierd-memory", kind: "popup", width: menuWidth(shown), height: menuHeight(shown), props: { menu: { token: tok, items: shown } } });
    cx.notify();
  }

  // Asks before something that can't be taken back in one click; `then(cx)` on yes.
  ask({ title, detail, confirm, danger = false }, then) {
    const tok = token();
    this.asking = { token: tok, then };
    const lines = Math.ceil(String(detail).length / 55);
    openOverlay({ mod: "wierd-memory", kind: "dialog", width: DIALOG_W, height: 128 + lines * 19, props: { dialog: { token: tok, title, detail, confirm, danger } } });
  }

  // The menu of the cursor's row (`.`), or of the open page.
  menuHere(cx) {
    const card = this.current();
    if (card && card.kind !== "gone") {
      const page = card.kind === "note" ? { kind: "note", note: card.note } : card.kind === "review" ? { kind: "review", item: card.item } : card.kind === "agents" ? { kind: "agents", proposal: card.proposal } : card.kind === "inbox" ? { kind: "inbox", item: card.item } : card.kind === "skill" ? { kind: "skill", skill: card.skill } : card.kind === "scope" ? { kind: "scope", scope: card.scope } : null;
      if (page) this.menu(page, cx);
      return;
    }
    const x = this.flat[this.cursor];
    if (x && ["note", "review", "agents", "inbox", "skill"].includes(x.kind)) this.menu(x, cx);
  }

  // ── actions ─────────────────────────────────────────────────────────────

  // One request that changes memory at a time. `then` gets the answer; a
  // failure is told in a notification and the page stays as it was.
  act(name, failed, request, then, cx) {
    if (this.busy || !this.api) return;
    this.busy = name;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await request(this.api);
        then?.(out, cx);
      } catch (e) {
        // 409: what the panel showed changed or was decided meanwhile; the read below shows it as it is now.
        notify({ title: e?.status === 409 ? `${failed}: it changed meanwhile` : failed, body: message(e), level: "error" });
      } finally {
        this.busy = null;
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  // What waits for a decision, as the server answered one.
  setReview(review) {
    if (this.data && review?.items) this.data.review = review;
  }

  // `keys` and the `versions` the panel shows: the server refuses (409) an item that changed since.
  pick(items) {
    return { keys: items.map((x) => x.key), versions: Object.fromEntries(items.map((x) => [x.key, x.version])) };
  }

  // Accept or reject a proposal; `edit`: the text as the person changed it
  // first (else what was chosen on its card); `reason`: why not. From its card,
  // the next proposal's card follows.
  decide(what, item, { edit = null, reason = "" } = {}, cx) {
    if (!this.data?.review) return;
    if (what === "accept" && !edit && Object.keys(this.draftOf(item)).length) edit = this.draftOf(item);
    const at = this.proposals().findIndex((p) => p.kind === "review" && p.item.key === item.key);
    const inCard = this.view?.kind === "review" && this.view.id === item.key;
    const body = { ...this.pick([item]), ...(edit ? { edit } : {}), ...(reason ? { reason } : {}) };
    this.act(what, what === "accept" ? "Couldn't accept it" : "Couldn't reject it", (api) => api.post(`/api/review/${what}`, body), (out, cx) => {
      delete this.drafts[item.key];
      this.setReview(out);
      if (inCard) this.advance(at, cx);
      else if (this.form?.kind === "reason") this.closeForm(cx);
    }, cx);
  }

  // Many proposals at once (those shown: never `all`, which would take in what a dream proposed since).
  // An edit goes with one proposal only: those with choices made on their cards
  // are accepted one by one with them first, the rest together.
  decideMany(what, items, reason, cx) {
    const drafted = what === "accept" ? items.filter((i) => Object.keys(this.draftOf(i)).length) : [];
    const rest = items.filter((i) => !drafted.includes(i));
    this.act(what, what === "accept" ? "Couldn't accept them" : "Couldn't reject them", async (api) => {
      let out = null;
      for (const i of drafted) out = await api.post("/api/review/accept", { ...this.pick([i]), edit: this.draftOf(i) });
      if (rest.length) out = await api.post(`/api/review/${what}`, { ...this.pick(rest), ...(reason ? { reason } : {}) });
      return out;
    }, (out, cx) => {
      for (const i of items) delete this.drafts[i.key];
      this.setReview(out);
      if (this.form) this.closeForm(cx);
      if (this.view?.kind === "review" && items.some((i) => i.key === this.view.id)) this.leave();
      this.cursorKey = targetKey(this.proposals()[0]);
      notify({ title: `${what === "accept" ? "Accepted" : "Rejected"} ${plural(items.length, "proposal")}`, level: "success" });
    }, cx);
  }

  // "Accept all" (or a scope's, the confirmations): asks first.
  acceptMany(items, what, cx) {
    if (!items.length || this.busy) return;
    const always = items.filter((i) => i.reach === "always" && i.kind !== "confirmed").length;
    const risky = items.filter((i) => i.risky?.length).length;
    this.ask({
      title: `Accept ${plural(items.length, "proposal")}?`,
      detail: `${what} become memory in one commit: ${summary(items)}.${always ? ` ${plural(always, "note")} will be in the context of every session of its scope.` : ""}${risky ? ` ${plural(risky, "proposal")} carry a risky-content warning.` : ""}`,
      confirm: `Accept ${items.length}`,
    }, (cx) => this.decideMany("accept", items, null, cx));
  }

  // Apply or reject an AGENTS.md proposal.
  agents(what, proposal, cx) {
    const at = this.proposals().findIndex((p) => p.kind === "agents" && p.proposal.id === proposal.id);
    const inCard = this.view?.kind === "agents" && this.view.id === proposal.id;
    this.act(what, what === "apply" ? `Couldn't apply it to ${proposal.rel}` : "Couldn't reject it", (api) => api.post(`/api/agents/${encodeURIComponent(proposal.id)}/${what}`, {}), (out, cx) => {
      // The answer is what waits for a decision now.
      if (out?.items) this.setReview(out);
      else if (this.data?.review) this.data.review.agents = this.data.review.agents.filter((p) => p.id !== proposal.id);
      if (inCard) this.advance(at, cx);
      if (what === "apply") notify({ title: `${proposal.rel} edited`, body: `${proposal.projectName}: the change is in the working copy, not committed.`, level: "success" });
    }, cx);
  }

  // A hand change of an approved note: turn off / on, pin, close, move, new text.
  patchNote(note, patch, cx, then) {
    this.act("save", "Couldn't change the note", (api) => api.patch(`/api/notes/${encodeURIComponent(note.id)}`, patch), (out) => {
      // Shown at once; the read that follows brings its place in the index.
      if (out?.id && this.data?.byId.has(out.id)) {
        const old = this.data.byId.get(out.id);
        Object.assign(old, out);
        old._hay = undefined;
      }
      if (patch.scope) notify({ title: "Moved", body: `${note.title.slice(0, 80)} → ${out?.scopeName ?? patch.scope}`, level: "success" });
      then?.();
    }, cx);
  }

  confirmDelete(n, cx) {
    this.ask({
      title: "Delete this note?",
      detail: `“${n.title.slice(0, 140)}” leaves memory for good, and dreams may propose it again. Its history keeps every version (restore one in the browser). To only stop pi from getting it, turn it off instead.`,
      confirm: "Delete",
      danger: true,
    }, (cx) => this.act("delete", "Couldn't delete the note", (api) => api.del(`/api/notes/${encodeURIComponent(n.id)}`), (_out, cx) => {
      if (this.view?.kind === "note" && this.view.id === n.id) this.leave();
      notify({ title: "Deleted", body: n.title.slice(0, 120), level: "success" });
      cx.notify();
    }, cx));
  }

  restore(n, entry, cx) {
    this.ask({
      title: "Restore this version?",
      detail: `The note becomes what it was after “${String(entry.message).split("\n")[0].slice(0, 90)}” (${stamp(entry.date)}). It is a new commit: the version now stays in the history.`,
      confirm: "Restore",
    }, (cx) => this.act(`restore:${entry.commit}`, "Couldn't restore it", (api) => api.post(`/api/notes/${encodeURIComponent(n.id)}/restore`, { commit: entry.commit }), () => {
      delete this.history[n.id];
    }, cx));
  }

  deleteSkill(s, cx) {
    this.ask({ title: `Delete the skill ${s.name}?`, detail: "pi stops loading it in this scope's sessions. The repository's history keeps it.", confirm: "Delete", danger: true }, (cx) => this.act("delete", "Couldn't delete the skill", (api) => api.del(`/api/skills?scope=${encodeURIComponent(s.scope)}&name=${encodeURIComponent(s.name)}`), () => {
      if (this.view?.kind === "skill" && this.view.name === s.name && this.view.scope === s.scope) this.leave();
    }, cx));
  }

  dismiss(item, cx) {
    this.act("dismiss", "Couldn't dismiss it", (api) => api.del(`/api/inbox/${encodeURIComponent(item.id)}`), () => {
      if (this.data) this.data.inbox = this.data.inbox.filter((x) => x.id !== item.id);
      if (this.view?.kind === "inbox" && this.view.id === item.id) this.leave();
    }, cx);
  }

  removeComment(c, cx) {
    this.act(`uncomment:${c.id}`, "Couldn't delete the comment", (api) => api.del(`/api/review/comments/${encodeURIComponent(c.id)}`), (out) => this.setReview(out), cx);
  }

  setCharter(scope, charter, cx) {
    this.act("charter", "Couldn't save the purpose", (api) => api.call("PUT", `/api/scopes/${encodeURIComponent(scope.id)}/charter`, { charter }), () => {
      if (this.form?.kind === "charter") {
        this.form = null;
        this.fields.clear();
      }
    }, cx);
  }

  startDream(mode, cx) {
    this.act("dream", mode === "review" ? "Couldn't start applying the comments" : "Couldn't start a dream", (api) => api.post("/api/dreams", { mode }), () => {
      notify({ title: mode === "review" ? "A dream is applying the comments" : "A dream has started", body: "What it proposes shows in Review when it ends.", level: "success" });
    }, cx);
  }

  cancelDream(r, cx) {
    this.act("dream", "Couldn't stop the dream", (api) => api.post(`/api/dreams/${encodeURIComponent(r.id)}/cancel`, {}), null, cx);
  }

  setSchedule(on, cx) {
    this.act("config", "Couldn't change the schedule", async (api) => {
      const cfg = await api.get("/api/config");
      return api.call("PUT", "/api/config", { schedule: { ...cfg.schedule, enabled: on } });
    }, () => notify({ title: on ? "Scheduled dreams are on" : "Scheduled dreams are off", body: on ? "The server dreams by itself once enough new sessions wait." : "Dreams run only when you start one.", level: "success" }), cx);
  }

  sync(cx) {
    this.act("sync", "Couldn't sync", (api) => api.post("/api/sync", {}), (out) => notify({ title: "Synced", body: out?.message ?? "", level: "success" }), cx);
  }

  // ── forms ───────────────────────────────────────────────────────────────

  openForm(form, focus) {
    this.form = form;
    this.fields.clear();
    focus?.focus();
  }

  closeForm(cx) {
    this.form = null;
    this.fields.clear();
    this.handle.focus();
    cx.notify();
  }

  setNoteFields(n) {
    this.fTitle.set_value(n.title ?? "");
    this.fWhen.set_value(n.when ?? "");
    this.fBody.set_value(n.body ?? "");
  }

  // The note's card becomes a form with its text.
  editNote(n, cx) {
    if (this.busy) return;
    if (this.view?.kind !== "note" || this.view.id !== n.id) this.show({ kind: "note", note: n }, cx);
    const was = { title: n.title ?? "", body: n.body ?? "", when: n.when ?? "", index: n.index, type: n.type, scope: n.scope };
    this.setNoteFields(n);
    this.openForm({ kind: "edit", id: n.id, index: n.index, type: n.type, scope: n.scope, was }, this.fTitle);
    cx.notify();
  }

  // A proposal's card becomes a form with its text as proposed; saving accepts it.
  editProposal(item, cx) {
    if (this.busy || !item.editable) return;
    if (this.view?.kind !== "review" || this.view.id !== item.key) this.show({ kind: "review", item }, cx);
    const n = item.note;
    const draft = this.draftOf(item);
    this.setNoteFields(n);
    this.openForm({ kind: "review", key: item.key, index: draft.index ?? n.index, type: draft.type ?? n.type, scope: draft.scope ?? item.scope, was: { scope: item.scope } }, this.fTitle);
    cx.notify();
  }

  newNote(scope, cx) {
    if (this.busy || !scope) return;
    this.setNoteFields({});
    this.openForm({ kind: "new", index: "pointer", type: "fact", scope, was: {} }, this.fTitle);
    cx.notify();
  }

  rememberForm(cx) {
    const ctx = this.ctx;
    this.fRemember.set_value("");
    this.openForm({ kind: "remember", where: ctx?.key ? "project" : "global", projectName: ctx?.key ? ctx.name : null, cwd: location().cwd }, this.fRemember);
    cx.notify();
  }

  // A comment for the dream: on a proposal's note (`item`), or on the proposals as a whole.
  commentForm(item, cx) {
    this.fComment.set_value("");
    this.openForm({ kind: "comment", noteId: item?.note?.id || null, title: item?.note?.title ?? null }, this.fComment);
    cx.notify();
  }

  reasonForm(items, cx) {
    if (!items.length) return;
    this.fReason.set_value("");
    this.openForm({ kind: "reason", items }, this.fReason);
    cx.notify();
  }

  charterForm(scope, text, cx) {
    this.fCharter.set_value(text ?? "");
    this.openForm({ kind: "charter", scope }, this.fCharter);
    cx.notify();
  }

  save(cx) {
    const f = this.form;
    if (!f || this.busy) return;
    // ⌘Enter may arrive twice (the field's own submit, then the panel's key).
    if (Date.now() - (this.savedAt ?? 0) < 150) return;
    this.savedAt = Date.now();
    const one = (s) => s.value().replace(/\s*\n\s*/g, " ").trim();
    if (f.kind === "edit" || f.kind === "review" || f.kind === "new") {
      const now = { title: one(this.fTitle), body: this.fBody.value().replace(/\s+$/, ""), when: one(this.fWhen), index: f.index, type: f.type };
      if (!now.title) {
        notify({ title: "A note needs a title", body: "The title is the line pi sees in its context.", level: "error" });
        return;
      }
      if (f.kind === "review") {
        const card = this.current();
        if (card?.kind !== "review") return;
        this.decide("accept", card.item, { edit: { ...now, when: now.when || null, ...(f.scope !== f.was.scope ? { scope: f.scope } : {}) } }, cx);
        return;
      }
      if (f.kind === "new") {
        this.act("save", "Couldn't add the note", (api) => api.post("/api/notes", { scope: f.scope, title: now.title, body: now.body.trim(), when: now.when || undefined, index: now.index, type: now.type }), (out, cx) => {
          if (out?.id && this.data) {
            this.data.byId.set(out.id, out);
            if (!this.data.byScope.has(out.scope)) this.data.byScope.set(out.scope, []);
            this.data.byScope.get(out.scope).push(out);
          }
          this.form = null;
          this.fields.clear();
          if (out?.id) this.go({ kind: "note", id: out.id }, cx);
        }, cx);
        return;
      }
      const card = this.current();
      if (card?.kind !== "note") return;
      const patch = {};
      for (const k of ["title", "body", "when", "index", "type"]) if (now[k] !== f.was[k]) patch[k] = k === "when" ? now.when || null : now[k];
      if (f.scope !== f.was.scope) patch.scope = f.scope;
      if (!Object.keys(patch).length) {
        this.closeForm(cx);
        return;
      }
      this.patchNote(card.note, patch, cx, () => {
        this.form = null;
        this.fields.clear();
        this.handle.focus();
      });
      return;
    }
    if (f.kind === "remember") {
      const text = this.fRemember.value().trim();
      if (!text) return;
      this.act("save", "Couldn't keep it", (api) => api.post("/api/inbox", { text, source: "user", scope: f.where, ...(f.cwd ? { cwd: f.cwd } : {}) }), (_out, cx) => this.closeForm(cx), cx);
      return;
    }
    if (f.kind === "comment") {
      const body = this.fComment.value().trim();
      if (!body) return;
      this.act("save", "Couldn't save the comment", (api) => api.post("/api/review/comments", f.noteId ? { body, noteId: f.noteId } : { body }), (out, cx) => {
        this.setReview(out);
        this.closeForm(cx);
        notify({ title: "Comment saved for the dream", body: "The next dream applies it, or apply it now from Review's ⋯.", level: "success" });
      }, cx);
      return;
    }
    if (f.kind === "reason") {
      const reason = one(this.fReason);
      if (f.items.length === 1) this.decide("reject", f.items[0], { reason }, cx);
      else this.decideMany("reject", f.items, reason, cx);
      return;
    }
    if (f.kind === "charter") {
      const text = this.fCharter.value().trim();
      if (!text) return;
      this.setCharter(f.scope, text, cx);
    }
  }

  // ── a note's history, a scope's session text ────────────────────────────

  toggleHistory(n, cx) {
    this.fold.history = !this.fold.history;
    if (this.fold.history) this.loadHistory(n.id, cx);
    cx.notify();
  }

  showHistory(n, cx) {
    this.show({ kind: "note", note: n }, cx);
    this.fold.history = true;
    this.loadHistory(n.id, cx);
  }

  toggleSessionText(scope, cx) {
    this.fold.session = !this.fold.session;
    if (this.fold.session) this.loadSessionText(scope.id, cx);
    cx.notify();
  }

  // ── outside the panel ───────────────────────────────────────────────────

  async shell() {
    if (!this.shellPath) this.shellPath = (await exec("/bin/sh", ["-c", 'printf %s "$SHELL"'])).stdout.trim() || "/bin/zsh";
    return this.shellPath;
  }

  // A path with the home folder as ~.
  tilde(path) {
    const h = home();
    return path && h && path.startsWith(h) ? `~${path.slice(h.length)}` : path;
  }

  // The note's file in an editor, in a split beside the focused pane, started
  // in the memory repository. Notes are plain files there: the server commits
  // a saved edit by itself and the panel shows it a moment later.
  openFile(file, cx) {
    cx.spawn(async () => {
      const shell = await this.shell();
      run("terminal.open", { argv: [shell, "-lic", `exec \${VISUAL:-\${EDITOR:-${EDITOR}}} "$1"`, shell, file], folder: this.status?.git?.dir ?? undefined, place: "right" });
    });
  }

  // A new pi on the session, in the peek panel with Keep and Close
  // (wierd-agents' peek bar, as its sessions list opens one). A session some
  // pi has open (pi-herdr's agent.session label) goes to that pi instead.
  openSession(target, cx) {
    const live = terminals().find((k) => k.state === "live" && k.labels?.["agent.session"] === target.id);
    if (live) {
      run("agent.focus", { terminal: live.address });
      return;
    }
    cx.spawn(async () => {
      try {
        const shell = await this.shell();
        const there = target.cwd && (await exec("test", ["-d", target.cwd])).code === 0 ? target.cwd : home();
        const r = await hc(["run", "--bg", "--json", "--no-parent", "--rm", "--cwd", there, "--", shell, "-lic", 'exec "$@"', shell, "pi", "--session", target.file || target.id]);
        const terminal = JSON.parse(r.stdout || "{}").address;
        if (!terminal) throw new Error(r.stderr || r.stdout || "hc run failed");
        const space = spaces().find((s) => s.active)?.id;
        openOverlay({
          kind: "dialog",
          width: 0.82,
          height: 0.82,
          layout: {
            type: "column",
            children: [
              { id: "peek-bar", type: "block", size: { px: 38 }, content: { mod: "wierd-agents", props: { peekBar: true, terminal, space, title: target.name || target.id } } },
              { id: "peek-term", type: "block", content: { terminal } },
            ],
          },
        });
      } catch (e) {
        notify({ title: "Couldn't open the session", body: message(e), level: "error" });
      }
    });
  }

  copy(text, cx) {
    cx.write_to_clipboard(text);
    this.copied = text;
    cx.timer.after(1400, (cx) => {
      if (this.copied === text) this.copied = null;
      cx.notify();
    });
    cx.notify();
  }

  // ── keys ────────────────────────────────────────────────────────────────

  key(e, cx) {
    const k = LATIN[e.keystroke] ?? e.keystroke;
    const done = () => {
      cx.stop_propagation();
      cx.notify();
    };
    if (k === "escape") {
      if (this.form) this.closeForm(cx);
      else if (this.view) this.back(cx);
      else if (this.query) {
        this.input.set_value("");
        this.query = "";
        this.cursor = -1;
      } else return;
      return done();
    }
    if (this.form) {
      if (k === "cmd-enter" || k === "ctrl-enter") {
        this.save(cx);
        cx.stop_propagation();
      }
      return;
    }
    if (this.view) {
      // Never while a text field has the keyboard.
      if (this.typing) return;
      const card = this.current();
      if (k === "backspace") this.back(cx);
      else if (k === ".") this.menuHere(cx);
      else if (card?.kind === "review") {
        if (k === "a") this.decide("accept", card.item, {}, cx);
        else if (k === "e" && card.item.editable) this.editProposal(card.item, cx);
        else if (k === "x") this.decide("reject", card.item, {}, cx);
        else if (k === "shift-x") this.reasonForm([card.item], cx);
        else if (k === "c" && card.item.note?.id) this.commentForm(card.item, cx);
        else if (k === "down" || k === "j") this.step(1, cx);
        else if (k === "up" || k === "k") this.step(-1, cx);
        else return;
      } else if (card?.kind === "agents") {
        if (k === "a") this.agents("apply", card.proposal, cx);
        else if (k === "x") this.agents("reject", card.proposal, cx);
        else if (k === "down" || k === "j") this.step(1, cx);
        else if (k === "up" || k === "k") this.step(-1, cx);
        else return;
      } else if (card?.kind === "note") {
        const n = card.note;
        if (k === "e") this.editNote(n, cx);
        else if (k === "o" && n.status === "active") this.patchNote(n, { enabled: n.enabled === false }, cx);
        else if (k === "p" && n.status === "active") this.patchNote(n, { pinned: !n.pinned }, cx);
        else return;
      } else if (card?.kind === "inbox") {
        if (k === "x") this.dismiss(card.item, cx);
        else return;
      } else return;
      return done();
    }
    // The list. ↑ ↓ work from the search field too.
    if (k === "down" || k === "up" || (!this.typing && (k === "j" || k === "k"))) {
      if (!this.flat.length) return;
      const dir = k === "down" || k === "j" ? 1 : -1;
      this.cursor = this.cursor < 0 ? (dir > 0 ? 0 : this.flat.length - 1) : Math.max(0, Math.min(this.flat.length - 1, this.cursor + dir));
      this.cursorKey = targetKey(this.flat[this.cursor]);
      this.follow = true;
      return done();
    }
    if (this.typing) return;
    if (k === "enter" && this.cursor >= 0) this.openAt(this.cursor, cx);
    else if (k === "/") this.input.focus();
    else if (k === ".") this.menuHere(cx);
    else {
      // A row's own keys, as in its card.
      const x = this.flat[this.cursor];
      if (x?.kind === "review") {
        if (k === "a") this.decide("accept", x.item, {}, cx);
        else if (k === "x") this.decide("reject", x.item, {}, cx);
        else if (k === "e" && x.item.editable) this.editProposal(x.item, cx);
        else if (k === "shift-x") this.reasonForm([x.item], cx);
        else if (k === "c" && x.item.note?.id) this.commentForm(x.item, cx);
        else return;
      } else if (x?.kind === "agents") {
        if (k === "a") this.agents("apply", x.proposal, cx);
        else if (k === "x") this.agents("reject", x.proposal, cx);
        else return;
      } else if (x?.kind === "note" && x.note.status === "active") {
        if (k === "o") this.patchNote(x.note, { enabled: x.note.enabled === false }, cx);
        else if (k === "p") this.patchNote(x.note, { pinned: !x.note.pinned }, cx);
        else if (k === "e") this.editNote(x.note, cx);
        else return;
      } else if (x?.kind === "inbox") {
        if (k === "x") this.dismiss(x.item, cx);
        else return;
      } else return;
    }
    done();
  }

  // ── drawing ─────────────────────────────────────────────────────────────

  render(cx) {
    if (this.overlay) return this.overlay.render(cx);
    const t = theme();
    const where = location();
    if (this.api && this.down === false && where.cwd && !this.contexts.has(where.cwd) && !this.asked.has(where.cwd)) {
      this.asked.add(where.cwd);
      this.askContext(where.cwd, cx);
    }
    // Until a new folder resolves, the last project stays (no flicker on focus).
    let ctx = null;
    if (where.cwd) {
      ctx = this.contexts.get(where.cwd) ?? this.lastCtx ?? null;
      if (this.contexts.has(where.cwd)) this.lastCtx = ctx;
    }
    this.ctx = ctx;
    if (this.stale && this.down === false && onScreen()) {
      this.stale = false;
      this.refresh(cx);
    }
    // A server that is away shows one line; the open page comes back with it.
    const card = this.down ? null : this.current();
    // A form about a note or a proposal goes with it.
    if (this.form && (this.form.kind === "edit" || this.form.kind === "review") && card?.kind !== (this.form.kind === "edit" ? "note" : "review")) this.form = null;
    const zoom = settings().zoom || 1;
    const page = this.form || card;
    if (this.data) spaceColors(this.data.scopes);
    return v_flex()
      .id("wierd-memory")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.chrome)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      // A press anywhere but a text field gives the panel the keyboard (fields stop their own).
      .on_mouse_down("left", () => {
        if (!this.form) this.handle.focus();
      })
      .on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => {
        const w = size.width / zoom;
        if (Math.abs(w - this.width) < 6) return;
        this.width = w;
        cx.notify();
      })
      .child(page ? this.pageHeader(t, card) : this.listHeader(t, ctx))
      .children(page ? this.page(t, card) : [this.list(t, ctx)])
      .child(this.footer(t));
  }

  // ── the list ────────────────────────────────────────────────────────────

  listHeader(t, ctx) {
    return h_flex()
      .h(42)
      .flex_none()
      .pl(10)
      .pr(8)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(h_flex()
        .id("mem-search")
        .flex_1()
        .min_w(0)
        .h(28)
        .px(8)
        .gap(6)
        .items_center()
        .rounded(8)
        .bg(t.surface)
        .border_1()
        .border_color(this.fields.has("search") ? t.accent : t.border)
        .cursor_text()
        .on_mouse_down("left", (_e, cx) => {
          cx.stop_propagation();
          this.input.focus();
        })
        .child(svg(icon("search")).size(13).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).child(Input.new(this.input).h_full().text_size(12.5).text_color(t.foreground)))
        .when(Boolean(this.query), (el) => el.child(div()
          .id("mem-clear")
          .flex_none()
          .size(16)
          .flex()
          .items_center()
          .justify_center()
          .rounded(4)
          .cursor_pointer()
          .text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            this.input.set_value("");
            this.query = "";
            this.cursor = -1;
            cx.notify();
          })
          .child(svg(icon("x")).size(11)))))
      .child(iconButton(t, "mem-add", "plus", "New note, or something to remember for the next dream", (_e, cx) => this.menu({ kind: "add", ctx }, cx), 28));
  }

  list(t, ctx) {
    const box = (children) => v_flex().flex_1().min_h(0).children(children);
    if (this.down) {
      this.flat = [];
      return box([
        hint(t, "wierd-memory server is not running (wmem serve)"),
        div().px(10).text_size(11).text_color(t.dim).font_family(mono()).child(this.server),
      ]).pt(8);
    }
    if (!this.data) return box([hint(t, this.error ? `Can't read memory: ${this.error}` : "Loading memory…")]).pt(8);
    let built = buildList(this, t, ctx);
    // The cursor stays on what it was on (a row decided away: on the one now in its place).
    const at = this.cursorKey ? built.flat.findIndex((x) => targetKey(x) === this.cursorKey) : -1;
    const want = at >= 0 ? at : Math.min(this.cursor, built.flat.length - 1);
    if (want !== this.cursor) {
      this.cursor = want;
      built = buildList(this, t, ctx);
    }
    this.flat = built.flat;
    this.cursorKey = targetKey(this.flat[this.cursor]);
    let followAt = null;
    if (this.follow && this.cursor >= 0) {
      followAt = built.items.findIndex((it) => it.at === this.cursor);
      if (followAt < 0) followAt = null;
    }
    if (this.viewH > 0) this.follow = false;
    // Rows passing under a still pointer aren't hovered: no ✓ ✕ flickering by, no draw for each.
    return scrollList(this, t, built.items, this.scroll, { followAt, onScroll: () => {
      this.scrolledAt = Date.now();
      this.hovered = null;
    } });
  }

  // ── a page ──────────────────────────────────────────────────────────────

  pageTitle(t, card) {
    const f = this.form;
    const text = (s, color) => div().min_w(0).truncate().text_size(12.5).font_semibold().text_color(color ?? t.foreground).child(s);
    if (f) {
      const name = { edit: "Edit the note", review: "Edit, then accept", new: "New note", remember: "Remember", comment: "Comment for the dream", reason: f.items?.length > 1 ? `Reject ${f.items.length}` : "Reject", charter: "What it's for" }[f.kind];
      return [text(name)];
    }
    switch (card?.kind) {
      case "note":
        return [scopeAvatar(t, card.scope, 16), text(card.scope?.name ?? card.note.scopeName ?? "", t.muted)];
      case "review":
      case "agents": {
        const all = this.proposals();
        const at = all.findIndex((p) => (p.kind === "review" ? card.kind === "review" && p.item.key === card.item.key : card.kind === "agents" && p.proposal.id === card.proposal.id));
        return [leadIcon(t, "review", t.accent), text("Review", t.accent), div().flex_none().font_family(mono()).text_size(10.5).text_color(t.dim).child(at >= 0 ? `${at + 1} of ${all.length}` : "")];
      }
      case "inbox":
        return [leadIcon(t, "inbox", t.working), text("Inbox")];
      case "skill":
        return [div().flex_none().text_color(t.ansi6).font_semibold().child("§"), text("Skill")];
      case "scope":
        return [scopeAvatar(t, card.scope, 16), text(card.scope.name)];
      case "comments":
        return [leadIcon(t, "comment"), text("Comments for the dream")];
      case "decided":
        return [leadIcon(t, "history"), text("Decided lately")];
      case "about":
        return [leadIcon(t, "moon"), text("The dreams behind them")];
      default:
        return [];
    }
  }

  pageHeader(t, card) {
    const proposal = !this.form && (card?.kind === "review" || card?.kind === "agents");
    const id = !this.form && card?.kind === "note" ? card.note.id : null;
    return h_flex()
      .h(42)
      .flex_none()
      .pl(8)
      .pr(8)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(backButton(t, this.form ? "Cancel (Esc)" : "Back (Esc)", (_e, cx) => (this.form ? this.closeForm(cx) : this.back(cx))))
      .child(h_flex().flex_1().min_w(0).gap(7).items_center().children(this.pageTitle(t, card)))
      .when(proposal, (el) => el
        .child(iconButton(t, "mem-prev", "chevron-up", "The previous proposal (↑)", (_e, cx) => this.step(-1, cx), 24))
        .child(iconButton(t, "mem-next", "chevron-down", "The next proposal (↓)", (_e, cx) => this.step(1, cx), 24)))
      .when(Boolean(id), (el) => el.child(div()
        .id("mem-id")
        .flex_none()
        .px(4)
        .rounded(4)
        .cursor_pointer()
        .font_family(mono())
        .text_size(10.5)
        .text_color(this.copied === id ? t.ansi2 : t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(`Copy ${id}: pi opens it with memory_read`)
        .on_click((_e, cx) => this.copy(id, cx))
        .child(this.copied === id ? "copied" : id)));
  }

  // The page's two parts: what scrolls, and its actions at the bottom edge.
  page(t, card) {
    const key = this.form ? `form-${this.form.kind}` : `page-${this.view?.kind ?? ""}-${this.view?.id ?? this.view?.name ?? ""}`;
    const scroll = (children) => v_flex().id(`${key}-box`).flex_1().min_h(0).child(v_flex().id(key).size_full().overflow_y_scrollbar().px(14).pt(12).pb(18).gap(12).children(children));
    let out;
    if (this.form) out = ["remember", "comment", "reason", "charter"].includes(this.form.kind) ? textForm(this, t) : noteForm(this, t);
    else if (card.kind === "gone") return [scroll([div().text_color(t.dim).child(this.view?.kind === "review" || this.view?.kind === "agents" ? "This proposal no longer waits for a decision." : "This is no longer in memory.")])];
    else {
      const r = this.data?.review;
      out =
        card.kind === "note" ? noteCard(this, t, card)
        : card.kind === "inbox" ? inboxCard(this, t, card.item)
        : card.kind === "review" ? reviewCard(this, t, card)
        : card.kind === "agents" ? agentsCard(this, t, card)
        : card.kind === "skill" ? skillCard(this, t, card.skill)
        : card.kind === "scope" ? scopeCard(this, t, card.scope)
        : card.kind === "comments" ? commentsView(this, t, r)
        : card.kind === "decided" ? decidedView(this, t, r)
        : aboutView(this, t, r);
    }
    const parts = [scroll(out.body)];
    const actions = [...(out.actions ?? [])];
    if (out.menu) actions.push(div().flex_1(), iconButton(t, "mem-page-more", "more", "More (.)", (_e, cx) => this.menu(out.menu, cx), 28));
    if (actions.length) parts.push(h_flex().id(`${key}-actions`).flex_none().flex_wrap().px(10).py(8).gap(6).items_center().border_t(1).border_color(t.border).children(actions));
    return parts;
  }

  // ── the dream, at the bottom ────────────────────────────────────────────

  footer(t) {
    const d = this.data, s = this.status;
    const bar = h_flex().h(34).flex_none().px(6).gap(2).items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim);
    const web = iconButton(t, "f-web", "external", `Open wierd-memory in the browser (${this.server})`, (_e, cx) => cx.open_url(`${this.server}/`), 24);
    if (this.down) return bar.child(div().px(6).child("Looking for the server…")).child(div().flex_1());
    if (!d || !s) return bar.child(div().px(6).child(this.loading || this.down === null ? "Reading memory…" : "")).child(div().flex_1()).child(web);
    const dream = s.dream ?? {};
    const last = dream.last;
    // A footer item: a row like the sidebar's footer has (Settings), lit under the pointer.
    const item = (id, name, text, tip, color, onClick) => h_flex()
      .id(id)
      .h(26)
      .px(7)
      .gap(6)
      .items_center()
      .flex_none()
      .rounded(7)
      .when(Boolean(color), (el) => el.text_color(color))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((st) => st.bg(t.hover).text_color(color ?? t.foreground)).on_click((_e, cx) => onClick(cx)))
      .child(name === "spinner" ? svg(icon("spinner")).size(12).text_color(t.working).spin(900) : svg(icon(name)).size(12))
      .child(div().child(text));

    const due = dream.due ?? {};
    const waiting = [due.sessions ? plural(due.sessions, "new session") : "", due.inbox ? `${due.inbox} in the inbox` : ""].filter(Boolean).join(", ");
    const next = `\n${dream.scheduled ? (due.due ? "The next dream is due" : `The next dream: not yet${due.reason ? ` (${due.reason})` : ""}`) : "Scheduled dreams are off"}${waiting ? `\nWaiting for it: ${waiting}` : ""}\nClick: dream now, the schedule, sync`;
    const menu = (cx) => this.menu({ kind: "dream" }, cx);
    let status;
    if (dream.running) {
      const r = dream.running;
      status = item("f-dream", "spinner", `Dreaming${running(r.startedAt)}`, `A dream is running (${r.id}), started ${stamp(r.startedAt)}\nClick: stop it`, t.working, menu);
    } else if (!last) {
      status = item("f-dream", "moon", "No dreams yet", next.trim(), null, menu);
    } else {
      const at = Date.parse(last.finishedAt ?? last.startedAt);
      const facts = [`Last dream ${stamp(last.finishedAt ?? last.startedAt)}`, last.sessions ? plural(last.sessions, "session") : "", last.cost ? `$${last.cost.toFixed(2)}` : "", last.status === "noop" ? "nothing new" : last.status === "cancelled" ? "cancelled" : "", last.id].filter(Boolean).join(" · ");
      status = last.status === "error"
        ? item("f-dream", "alert", `Dream failed ${ago(at)}`, `${facts}\n${last.error ?? ""}${next}`, t.blocked, menu)
        : item("f-dream", "moon", `Dreamt ${ago(at)}`, `${facts}${next}`, null, menu);
    }
    const todo = this.proposals().length;
    const counts = d.review ? countsLine(d.review) : "";
    return bar
      .child(status)
      .when(todo > 0 && !(this.view === null && !this.form && this.isOpen("review", true) && (this.scroll.offset ?? 0) < 40), (el) => el.child(item("f-review", "review", `${todo} to decide`, `What dreams propose${counts ? `: ${counts}` : ""}\nClick to go through them`, t.accent, (cx) => {
        this.goReview();
        this.handle.focus();
        cx.notify();
      })))
      .child(div().flex_1())
      .child(web);
  }
}
