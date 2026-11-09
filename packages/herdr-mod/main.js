// Memory: what wierd-mem remembers for pi, beside Files and Changes.
//
// Like Files it follows the focused pane: that pane's project and the global
// notes open on top (what pi loads into a session there), every other project
// folds below them. A mark says how a note reaches pi: always in its context,
// read when relevant, or found by search only. A note opens as a card with
// where it came from: the sessions it cites, the lines it cites, and ↗ to open
// such a session in the peek panel. What dreams propose (the open review) sits
// on top, to accept, edit or reject; then the inbox (what waits for the next
// dream); the dream's state is at the bottom.
//
// Memory lives in the wierd-mem server (a local HTTP API, see api.js); this
// file asks it and draws the list. cards.js draws a note, review.js a proposal.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState } from "gpui-base";
import { spaces, panes, focused, layout, exec, hc, theme, settings, run, terminals, openOverlay, notify, appHome, home, nextCommand, readTextFile } from "herdr";
import { Api, DEFAULT_SERVER } from "./api.js";
import { icon, mono, mark, hint, button, iconButton } from "./ui.js";
import { norm, words, hay, snippet, twoLines, ago, stamp, running } from "./text.js";
import { noteCard, inboxCard } from "./cards.js";
import { reviewRow, agentsRow, reviewCard, agentsCard, reviewHay, agentsHay } from "./review.js";

// The server answers a waiting request (GET /api/wait) as soon as anything
// changes, or after this many seconds.
const WAIT_S = 25;
// When the server can't be reached: look again this often, then (after a few
// tries) this often.
const RETRY_MS = 5_000;
const RETRY_SLOW_MS = 30_000;
// "Accept all" asks again: the second click counts for this long.
const CONFIRM_MS = 4_000;
// A review card's keys on a Russian layout (the same physical keys).
const LATIN = { "ф": "a", "у": "e", "ч": "x" };

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
  if (node.content?.mod === "wierd-mem") return here;
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

export default class WierdMem extends View {
  init(_props, cx) {
    // Set once server.json is read (`wmem herdr install` writes it).
    this.server = DEFAULT_SERVER;
    this.api = null;
    // null: not asked yet; true: the server can't be reached.
    this.down = null;
    this.rev = null;
    // cwd → the project pi loads memory for there (the server resolves it).
    this.contexts = new Map();
    this.asked = new Set();
    // Which groups are open, as the person left them (the defaults aren't kept).
    this.open = JSON.parse(localStorage.getItem("open") ?? "{}");
    // The open card: { kind: "note" | "inbox" | "review" | "agents", id }; null: the list.
    this.view = null;
    // The edit form over a note's or a proposal's card: { target, id, index, type, was }.
    this.form = null;
    // Folded parts of the open card.
    this.fold = {};
    // A request that changes memory is running ("accept", "save"…): buttons wait.
    this.busy = null;
    // Evidence read so far: session id → { name, started, cwd, file, entries }.
    this.ev = {};
    this.query = "";
    this.cursor = -1;
    this.flat = [];
    this.width = 368;
    // Changing it starts the list at its top again.
    this.listAt = 0;
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
    };
    this.input = InputState.new({ placeholder: "Search memory" });
    this.input.on("change", (_e, cx) => {
      const q = this.input.value();
      if (q === this.query) return;
      this.query = q;
      this.cursor = q.trim() ? 0 : -1;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.openAt(this.cursor, cx));
    track("search", this.input);
    this.fTitle = InputState.new({ placeholder: "One line: what pi should know" });
    this.fWhen = InputState.new({ placeholder: "When it applies (empty: always)" });
    this.fBody = TextareaState.new({ placeholder: "The specifics, in Markdown", rows: 8 });
    this.fBody.set_auto_grow(6, 40);
    this.fBody.set_soft_wrap(true);
    track("title", this.fTitle);
    track("when", this.fWhen);
    track("body", this.fBody);
    // In the form ⌘Enter saves; Enter in a one-line field goes to the next one.
    const submit = (state, next) => state.on("submit", (e, cx) => {
      if (!this.form) return;
      if (e?.secondary) this.save(cx);
      else next?.focus();
    });
    submit(this.fTitle, this.fWhen);
    submit(this.fWhen, this.fBody);
    submit(this.fBody, null);
    cx.spawn((cx) => this.live(cx));
    // keys.json: "wierd-mem.search" puts the keyboard in the search field;
    // "wierd-mem.open-<note id>" opens that note's card; "wierd-mem.review"
    // goes to what dreams propose.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "search") {
          this.leave();
          this.input.focus();
        } else if (c === "review") {
          this.goReview();
          this.handle.focus();
        } else if (c === "focus") {
          this.handle.focus();
        } else if (c.startsWith("open-")) {
          const found = this.noteById(c.slice(5));
          if (found) this.show(found, cx);
        }
        cx.notify();
      }
    });
  }

  get typing() {
    return this.fields.size > 0;
  }

  // ── data ────────────────────────────────────────────────────────────────

  // The server's address, then one waiting request after another: each answers
  // when memory changed. A server that is away is asked again, less and less often.
  async live(cx) {
    try {
      const url = JSON.parse((await readTextFile(`${appHome()}/mods/wierd-mem/server.json`)) ?? "{}").url;
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
        const [status, scopes, notes, inbox, review, context] = await Promise.all([
          api.get("/api/status"),
          api.get("/api/scopes"),
          api.get("/api/notes"),
          api.get("/api/inbox"),
          api.get("/api/review"),
          cwd ? api.get(`/api/context?cwd=${encodeURIComponent(cwd)}`).catch(() => null) : null,
        ]);
        this.status = status;
        this.setData({ scopes, notes: notes?.notes ?? [], inbox: inbox ?? [], review });
        if (cwd && context) this.setContext(cwd, context);
        this.error = null;
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

  setData({ scopes, notes, inbox, review }) {
    const byScope = new Map();
    const byId = new Map();
    for (const n of notes) {
      byId.set(n.id, n);
      if (!byScope.has(n.scope)) byScope.set(n.scope, []);
      byScope.get(n.scope).push(n);
    }
    this.data = { scopes, byScope, byId, inbox, review: review?.status === "open" ? review : null };
  }

  setContext(cwd, c) {
    this.contexts.set(cwd, { scope: c.scope ?? null, name: c.project?.name ?? "", key: c.project?.key ?? "" });
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

  // What the open card cites: each session's name and the cited lines of its digest.
  loadEvidence(cx) {
    const card = this.current();
    const list = card?.kind === "note" ? card.note.evidence : card?.kind === "review" ? card.item.evidence : null;
    if (!list?.length || this.evBusy || !this.api) return;
    const refs = list.filter((ev) => {
      if (/^(pr#|review:|manual)/.test(ev.s)) return false;
      if (ev.s.startsWith("inbox:")) return !(ev.s in this.ev);
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

  // ── actions ─────────────────────────────────────────────────────────────

  isOpen(key, fallback) {
    return key in this.open ? this.open[key] : fallback;
  }

  toggle(key, fallback, cx) {
    this.open[key] = !this.isOpen(key, fallback);
    localStorage.setItem("open", JSON.stringify(this.open));
    cx.notify();
  }

  show(item, cx) {
    this.view =
      item.kind === "note" ? { kind: "note", id: item.note.id }
      : item.kind === "inbox" ? { kind: "inbox", id: item.item.id }
      : item.kind === "review" ? { kind: "review", id: item.item.key }
      : { kind: "agents", id: item.proposal.id };
    this.form = null;
    this.fold = {};
    this.fields.clear();
    this.loadEvidence(cx);
    this.handle.focus();
    cx.notify();
  }

  openAt(i, cx) {
    const item = this.flat[i];
    if (item) this.show(item, cx);
  }

  // Back to the list, without a redraw of its own.
  leave() {
    this.view = null;
    this.form = null;
    this.fields.clear();
  }

  back(cx) {
    this.leave();
    this.handle.focus();
    cx.notify();
  }

  // The list with the Review group open, from its top, the cursor on its first row.
  goReview() {
    this.leave();
    if (this.query) {
      this.input.set_value("");
      this.query = "";
    }
    this.open.review = true;
    localStorage.setItem("open", JSON.stringify(this.open));
    this.listAt += 1;
    this.want = { review: 0 };
  }

  // The open card's note, inbox item or proposal, from the latest read; gone if it went.
  current() {
    const v = this.view, d = this.data;
    if (!v || !d) return null;
    if (v.kind === "note") return this.noteById(v.id) ?? { kind: "gone" };
    if (v.kind === "inbox") {
      const item = d.inbox.find((x) => x.id === v.id);
      return item ? { kind: "inbox", item } : { kind: "gone" };
    }
    if (v.kind === "review") {
      const item = d.review?.items.find((x) => x.key === v.id);
      return item ? { kind: "review", item, review: d.review } : { kind: "gone" };
    }
    const proposal = d.review?.agents?.find((x) => x.id === v.id && x.status === "pending");
    return proposal ? { kind: "agents", proposal, review: d.review } : { kind: "gone" };
  }

  noteById(id) {
    const note = this.data?.byId.get(id);
    return note ? { kind: "note", note, scope: this.data.scopes.find((s) => s.id === note.scope) ?? null } : null;
  }

  // What the review still asks to decide: notes and skills, then AGENTS.md proposals.
  proposals() {
    const r = this.data?.review;
    if (!r) return [];
    return [...r.items.map((item) => ({ kind: "review", item })), ...(r.agents ?? []).filter((p) => p.status === "pending").map((proposal) => ({ kind: "agents", proposal }))];
  }

  // One request that changes memory at a time. `then` gets the answer; a
  // failure is told in a notification and the card stays as it was.
  act(name, failed, request, then, cx) {
    if (this.busy || !this.api) return;
    this.busy = name;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await request(this.api);
        then?.(out, cx);
      } catch (e) {
        notify({ title: failed, body: message(e), level: "error" });
      } finally {
        this.busy = null;
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  // The review as the server answered a decision (null once nothing is left).
  setReview(review) {
    if (this.data) this.data.review = review?.status === "open" ? review : null;
  }

  // After a decision: the list, the cursor on what took the decided row's place.
  next(at) {
    this.leave();
    this.handle.focus();
    this.want = { review: Math.max(0, at) };
  }

  // Accept or reject a proposal; `edit`: the text as the person changed it first.
  decide(what, item, edit, cx) {
    const review = this.data?.review;
    if (!review) return;
    const at = this.proposals().findIndex((p) => p.kind === "review" && p.item.key === item.key);
    const body = { keys: [item.key], ...(edit ? { edit } : {}) };
    this.act(what, what === "accept" ? "Couldn't accept it" : "Couldn't reject it", (api) => api.post(`/api/reviews/${encodeURIComponent(review.id)}/${what}`, body), (out) => {
      this.setReview(out);
      this.next(at);
    }, cx);
  }

  // "Accept all": the first click asks, the second (soon after) does it.
  acceptAll(cx) {
    const review = this.data?.review;
    if (!review || this.busy) return;
    if (!this.sure || Date.now() - this.sure > CONFIRM_MS) {
      const at = (this.sure = Date.now());
      cx.timer.after(CONFIRM_MS, (cx) => {
        if (this.sure === at) this.sure = 0;
        cx.notify();
      });
      cx.notify();
      return;
    }
    this.sure = 0;
    this.act("accept", "Couldn't accept the review", (api) => api.post(`/api/reviews/${encodeURIComponent(review.id)}/accept`, {}), (out) => {
      this.setReview(out);
      this.want = { review: 0 };
    }, cx);
  }

  // Apply or reject an AGENTS.md proposal.
  agents(what, proposal, cx) {
    const at = this.proposals().findIndex((p) => p.kind === "agents" && p.proposal.id === proposal.id);
    this.act(what, what === "apply" ? `Couldn't apply it to ${proposal.rel}` : "Couldn't reject it", (api) => api.post(`/api/agents/${encodeURIComponent(proposal.id)}/${what}`, {}), (out) => {
      // The answer is the review, or null once it closed.
      if (out === null || out?.items) this.setReview(out);
      else if (this.data?.review) this.data.review.agents = this.data.review.agents.filter((p) => p.id !== proposal.id);
      this.next(at);
      if (what === "apply") notify({ title: `${proposal.rel} edited`, body: `${proposal.projectName}: the change is in the working copy, not committed.`, level: "success" });
    }, cx);
  }

  // A hand change of an approved note: turn off / on, pin, new text.
  patchNote(note, patch, cx, then) {
    this.act("save", "Couldn't change the note", (api) => api.patch(`/api/notes/${encodeURIComponent(note.id)}`, patch), (out) => {
      // Shown at once; the read that follows brings its place in the index.
      if (out?.id && this.data?.byId.has(out.id)) {
        const old = this.data.byId.get(out.id);
        Object.assign(old, out);
        old._hay = undefined;
      }
      then?.();
    }, cx);
  }

  dismiss(item, cx) {
    this.act("dismiss", "Couldn't dismiss it", (api) => api.del(`/api/inbox/${encodeURIComponent(item.id)}`), () => {
      if (this.data) this.data.inbox = this.data.inbox.filter((x) => x.id !== item.id);
      this.back(cx);
    }, cx);
  }

  // The card becomes a form with the note's text (a proposal's: as proposed).
  edit(target, note, cx) {
    if (this.busy) return;
    const was = { title: note.title ?? "", body: note.body ?? "", when: note.when ?? "", index: note.index, type: note.type };
    this.form = { target, id: note.id, index: was.index, type: was.type, was };
    this.fTitle.set_value(was.title);
    this.fWhen.set_value(was.when);
    this.fBody.set_value(was.body);
    this.fTitle.focus();
    cx.notify();
  }

  closeForm(cx) {
    this.form = null;
    this.fields.clear();
    this.handle.focus();
    cx.notify();
  }

  save(cx) {
    const f = this.form, card = this.current();
    if (!f || this.busy || !card) return;
    // ⌘Enter may arrive twice (the field's own submit, then the panel's key).
    if (Date.now() - (this.savedAt ?? 0) < 150) return;
    this.savedAt = Date.now();
    const now = {
      title: this.fTitle.value().replace(/\s*\n\s*/g, " ").trim(),
      body: this.fBody.value().replace(/\s+$/, ""),
      when: this.fWhen.value().replace(/\s*\n\s*/g, " ").trim(),
      index: f.index,
      type: f.type,
    };
    if (!now.title) {
      notify({ title: "A note needs a title", body: "The title is the line pi sees in its context.", level: "error" });
      return;
    }
    if (f.target === "review" && card.kind === "review") {
      this.decide("accept", card.item, { ...now, when: now.when || null }, cx);
      return;
    }
    if (card.kind !== "note") return;
    const patch = {};
    for (const k of ["title", "body", "when", "index", "type"]) if (now[k] !== f.was[k]) patch[k] = k === "when" ? now.when || null : now[k];
    if (!Object.keys(patch).length) {
      this.closeForm(cx);
      return;
    }
    this.patchNote(card.note, patch, cx, () => {
      this.form = null;
      this.fields.clear();
      this.handle.focus();
    });
  }

  async shell() {
    if (!this.shellPath) this.shellPath = (await exec("/bin/sh", ["-c", 'printf %s "$SHELL"'])).stdout.trim() || "/bin/zsh";
    return this.shellPath;
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

  key(e, cx) {
    const k = e.keystroke;
    if (k === "escape") {
      if (this.form) this.closeForm(cx);
      else if (this.view) this.back(cx);
      else if (this.query) {
        this.input.set_value("");
        this.query = "";
        this.cursor = -1;
      } else return;
      cx.stop_propagation();
      cx.notify();
      return;
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
      if (k === "backspace") {
        this.back(cx);
        cx.stop_propagation();
        return;
      }
      const card = this.current();
      const letter = LATIN[k] ?? k;
      if (card?.kind === "review") {
        if (letter === "a") this.decide("accept", card.item, null, cx);
        else if (letter === "e" && card.item.editable) this.edit("review", card.item.note, cx);
        else if (letter === "x") this.decide("reject", card.item, null, cx);
        else return;
        cx.stop_propagation();
      } else if (card?.kind === "agents") {
        if (letter === "a") this.agents("apply", card.proposal, cx);
        else if (letter === "x") this.agents("reject", card.proposal, cx);
        else return;
        cx.stop_propagation();
      }
      return;
    }
    if (k === "down" || k === "up") {
      if (!this.flat.length) return;
      const step = k === "down" ? 1 : -1;
      this.cursor = this.cursor < 0 ? (step > 0 ? 0 : this.flat.length - 1) : Math.max(0, Math.min(this.flat.length - 1, this.cursor + step));
      cx.stop_propagation();
      cx.notify();
    } else if (k === "enter" && !this.typing && this.cursor >= 0) {
      this.openAt(this.cursor, cx);
      cx.stop_propagation();
    } else if (k === "/" && !this.typing) {
      this.input.focus();
      cx.stop_propagation();
    }
  }

  // ── drawing ─────────────────────────────────────────────────────────────

  render(cx) {
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
    if (this.stale && this.down === false && onScreen()) {
      this.stale = false;
      this.refresh(cx);
    }
    // A server that is away shows one line; the open card comes back with it.
    const card = this.down ? null : this.current();
    if (!card || card.kind === "gone" || (card.kind !== "note" && card.kind !== "review")) this.form = null;
    const zoom = settings().zoom || 1;
    return v_flex()
      .id("wierd-mem")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => {
        const w = size.width / zoom;
        if (Math.abs(w - this.width) < 6) return;
        this.width = w;
        cx.notify();
      })
      .child(this.header(t, card))
      .child(v_flex().flex_1().min_h(0)
        // The list stays while a card shows, so going back finds it where it was.
        // (Hidden from a box of its own: overflow_y_scrollbar() wraps the list,
        // and styles set after it reach the inner element only.)
        .child(v_flex().id("mem-list-box").flex_1().min_h(0).when(Boolean(card), (el) => el.hidden()).child(this.list(t, ctx)))
        .when(Boolean(card), (el) => el.children(this.card(t, card))))
      .child(this.footer(t));
  }

  header(t, card) {
    const bar = h_flex().h(42).flex_none().gap(8).items_center().border_b(1).border_color(t.border);
    if (card) {
      let title = "Memory";
      let id = "";
      if (card.kind === "note") id = card.note.id;
      else if (card.kind === "inbox") {
        title = "Inbox";
        id = card.item.id;
      } else if (card.kind === "review" || card.kind === "agents") {
        const all = this.proposals();
        const at = all.findIndex((p) => (p.kind === "review" ? p.item.key === this.view.id : p.proposal.id === this.view.id));
        title = at >= 0 ? `Review · ${at + 1} of ${all.length}` : "Review";
        id = card.kind === "review" ? card.item.note?.id || card.item.skill?.name || "" : card.proposal.id;
      }
      if (this.form) title = this.form.target === "review" ? "Edit, then accept" : "Edit the note";
      return bar
        .pl(8)
        .pr(14)
        .child(iconButton(t, "mem-back", "back", this.form ? "Cancel the edit (Esc)" : "Back (Esc)", (_e, cx) => (this.form ? this.closeForm(cx) : this.back(cx))))
        .child(div().flex_none().font_semibold().child(title))
        .child(div().flex_1())
        .when(Boolean(id), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).font_family(mono()).child(id)));
    }
    return bar
      .px(10)
      .pl(14)
      .child(div().font_semibold().flex_none().child("Memory"))
      .child(h_flex()
        .id("mem-search")
        .flex_1()
        .min_w(0)
        .h(28)
        .px(8)
        .gap(6)
        .items_center()
        .rounded(7)
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
          .child(svg(icon("x")).size(11)))));
  }

  // ── the list ────────────────────────────────────────────────────────────

  list(t, ctx) {
    const body = v_flex().id(`mem-list-${this.listAt}`).size_full().overflow_y_scrollbar().p(6);
    if (this.down) {
      this.flat = [];
      return body
        .child(hint(t, "wierd-mem server is not running (wmem serve)"))
        .child(div().pl(10).pr(10).text_size(11).text_color(t.dim).font_family(mono()).child(this.server));
    }
    const d = this.data;
    if (!d) return body.child(hint(t, this.error ? `Can't read memory: ${this.error}` : "Loading memory…"));
    const terms = words(this.query);
    const searching = terms.length > 0;
    const hit = (text) => terms.every((w) => text.includes(w));
    // Titles are sentences: two lines of them, at about 7.5 px a letter of
    // the room a row's text has (its width less the marks and paddings).
    const cpl = Math.max(16, Math.floor((this.width - 68) / 7.5));
    const rows = [];
    const flat = [];
    const add = (item, row) => {
      flat.push(item);
      rows.push(row(flat.length - 1));
    };
    let found = 0;

    // What dreams propose: to decide.
    const all = this.proposals();
    if (d.review) {
      const shown = searching ? all.filter((p) => hit(norm(p.kind === "review" ? reviewHay(p.item) : agentsHay(p.proposal)))) : all;
      found += shown.length;
      if (shown.length || !searching) {
        const open = searching || this.isOpen("review", true);
        rows.push(this.reviewHead(t, d.review, shown.length, all.length, open, searching));
        // A row's mark on the right takes room from its title.
        const narrow = Math.max(14, cpl - 3);
        if (open) for (const p of shown) add(p, (i) => (p.kind === "review" ? reviewRow(this, t, p.item, i, narrow) : agentsRow(this, t, p.proposal, i, cpl)));
      }
    }

    // What waits for the next dream.
    const inbox = d.inbox.filter((i) => !searching || hit(norm(i.text)));
    found += inbox.length;
    if (inbox.length) {
      const open = searching || this.isOpen("inbox", true);
      rows.push(this.groupRow(t, "inbox", {
        name: "Inbox",
        hint: "for the next dream",
        count: inbox.length,
        open,
        main: true,
        tip: "Kept with memory_inbox or /remember. The next dream reviews these; they become memory once you accept what it proposes.",
        onClick: searching ? null : (cx) => this.toggle("inbox", true, cx),
      }));
      if (open) for (const item of inbox) add({ kind: "inbox", item }, (i) => this.inboxRow(t, item, i, cpl));
    }

    // This project, Global, then the other projects by name.
    const byId = new Map(d.scopes.map((s) => [s.id, s]));
    const mine = ctx?.scope ? byId.get(ctx.scope) : null;
    const groups = [];
    if (mine) groups.push({ scope: mine, key: mine.id, name: ctx.name || mine.name, hint: "this project", main: true });
    const global = byId.get("global");
    if (global && global !== mine) groups.push({ scope: global, key: "global", name: "Global", hint: "all projects", main: true });
    for (const s of d.scopes.filter((s) => s.id !== "global" && s !== mine).sort((a, b) => a.name.localeCompare(b.name))) groups.push({ scope: s, key: s.id, name: s.name, main: false });

    if (ctx && !mine && !searching) rows.push(hint(t, `No notes for ${ctx.name} yet`));

    for (const g of groups) {
      const notes = d.byScope.get(g.scope.id) ?? [];
      const index = g.scope.index ?? { tokens: 0, over: 0 };
      const tip = `${g.scope.key === "global" ? "Global notes: every project on this computer" : g.scope.key}\nIndex: ~${index.tokens} of ${g.scope.budget} tokens${index.over ? ` · ${index.over} over budget` : ""}`;
      const scope = g.scope;
      if (searching) {
        const matches = notes.filter((n) => hit(hay(n)));
        if (!matches.length) continue;
        found += matches.length;
        rows.push(this.groupRow(t, g.key, { ...g, count: matches.length, open: true, tip, onClick: null }));
        for (const note of matches) add({ kind: "note", note, scope }, (i) => this.noteRow(t, note, i, cpl, snippet(note, terms)));
        continue;
      }
      // Active notes in index order, then the ones turned off, then the archive.
      const active = notes.filter((n) => n.reach !== "off" && n.reach !== "archived");
      const off = notes.filter((n) => n.reach === "off");
      const old = notes.filter((n) => n.reach === "archived");
      const open = this.isOpen(g.key, g.main);
      rows.push(this.groupRow(t, g.key, { ...g, count: active.length, open, tip, onClick: (cx) => this.toggle(g.key, g.main, cx) }));
      if (!open) continue;
      if (!notes.length) rows.push(hint(t, "No notes yet", 38));
      for (const note of [...active, ...off]) add({ kind: "note", note, scope }, (i) => this.noteRow(t, note, i, cpl));
      if (old.length) {
        const key = `archive:${g.key}`;
        const openOld = this.isOpen(key, false);
        rows.push(this.archiveRow(t, key, old.length, openOld));
        if (openOld) for (const note of old) add({ kind: "note", note, scope }, (i) => this.noteRow(t, note, i, cpl));
      }
    }
    this.flat = flat;
    // After a decision (or "review"): the cursor on the proposal now at that place.
    if (this.want) {
      const at = flat.map((x, i) => (x.kind === "review" || x.kind === "agents" ? i : -1)).filter((i) => i >= 0);
      this.cursor = at.length ? at[Math.min(this.want.review, at.length - 1)] : -1;
      this.want = null;
    }
    if (this.cursor >= flat.length) this.cursor = flat.length - 1;
    if (searching && !found) rows.push(hint(t, "Nothing found"));
    if (!searching && groups.length) rows.push(this.legend(t));
    return body.children(rows);
  }

  groupRow(t, key, { name, hint, count, open, tip, main, color, extra, onClick }) {
    return h_flex()
      .id(`g-${key}`)
      .h(28)
      .flex_none()
      .pl(8)
      .pr(10)
      .gap(6)
      .items_center()
      .rounded(7)
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim))
      .child(div().min_w(0).truncate().font_semibold().text_color(color ?? (main ? t.foreground : t.muted)).child(name))
      .when(Boolean(hint), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(hint)))
      .child(div().flex_1())
      .children(extra ?? [])
      .child(div().flex_none().text_size(11).text_color(t.dim).child(String(count)));
  }

  // The Review group's heading: what to decide, "Accept all", the web UI.
  reviewHead(t, review, shown, total, open, searching) {
    const sure = Boolean(this.sure) && Date.now() - this.sure <= CONFIRM_MS;
    const notes = review.items.length;
    const small = (id, label, tip, color, onClick) => div()
      .id(id)
      .h(20)
      .flex_none()
      .px(7)
      .flex()
      .items_center()
      .rounded(5)
      .border_1()
      .border_color(color ?? t.border)
      .text_size(11)
      .text_color(color ?? t.muted)
      .cursor_pointer()
      .when(Boolean(this.busy), (el) => el.opacity(0.45))
      .hover((s) => s.bg(t.raised).text_color(color ?? t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(label);
    const extra = [];
    if (!searching && notes > 0) {
      extra.push(sure
        ? small("rv-all", this.busy ? "Accepting…" : `Accept ${notes}?`, "Click again to accept every note and skill left in the review", t.accent, (cx) => this.acceptAll(cx))
        : small("rv-all", "Accept all", `Accept every note and skill left (${notes}): asks once more. AGENTS.md proposals are applied one by one.`, null, (cx) => this.acceptAll(cx)));
    }
    if (!searching) extra.push(iconButton(t, "rv-web", "external", "Open the review in the browser (comments, the dream's report)", (_e, cx) => cx.open_url(`${this.server}/#/review`), 22));
    return this.groupRow(t, "review", {
      name: "Review",
      hint: this.width > 330 && !sure ? "to decide" : "",
      count: searching ? shown : total,
      open,
      color: t.accent,
      extra,
      tip: `${review.title}\nWhat dreams propose: nothing is memory until you accept it.${review.accepted || review.rejected ? `\nSo far: ${review.accepted} accepted, ${review.rejected} rejected.` : ""}`,
      onClick: searching ? null : (cx) => this.toggle("review", true, cx),
    });
  }

  archiveRow(t, key, count, open) {
    return h_flex()
      .id(`g-${key}`)
      .h(26)
      .flex_none()
      .pl(26)
      .pr(10)
      .gap(6)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .text_size(12)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover))
      .tooltip("Replaced or deprecated notes: kept for history, pi no longer uses them")
      .on_click((_e, cx) => this.toggle(key, false, cx))
      .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(11).flex_none())
      .child(div().child("Archived"))
      .child(div().flex_1())
      .child(div().text_size(11).child(String(count)));
  }

  row(t, id, i, el) {
    const on = i === this.cursor;
    return h_flex()
      .id(id)
      .w_full()
      .flex_none()
      .py(5)
      .pl(26)
      .pr(10)
      .gap(6)
      .items_start()
      .rounded(7)
      .cursor_pointer()
      .when(on, (e) => e.bg(t.selected))
      .hover((s) => s.bg(on ? t.selected : t.hover))
      .on_click((_e, cx) => {
        this.cursor = i;
        this.openAt(i, cx);
      })
      .children(el);
  }

  noteRow(t, n, i, cpl, found = null) {
    const how = n.reach;
    const quiet = how === "archived" || how === "off";
    const title = div()
      .max_h(36)
      .overflow_hidden()
      .line_height("18px")
      .text_color(quiet ? t.dim : t.foreground)
      .when(how === "archived", (el) => el.line_through())
      .child(twoLines(n.title || n.id, how === "off" ? Math.max(14, cpl - 4) : cpl));
    return this.row(t, `n-${n.id}`, i, [
      mark(t, how, `m-${n.id}`),
      v_flex()
        .flex_1()
        .min_w(0)
        .child(title)
        .when(Boolean(found), (el) => el.child(div().truncate().text_size(11.5).line_height("17px").text_color(t.dim).child(found))),
      ...(how === "off" ? [div().id(`off-${n.id}`).h(18).flex_none().flex().items_center().text_size(10.5).text_color(t.dim).tooltip("Turned off: pi no longer gets it").child("off")] : []),
    ]);
  }

  inboxRow(t, item, i, cpl) {
    return this.row(t, `i-${item.id}`, i, [
      div()
        .id(`im-${item.id}`)
        .w(12)
        .h(18)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .text_size(13)
        .text_color(t.working)
        .tooltip(item.source === "user" ? "From you (/remember)" : "From an agent (memory_inbox)")
        .child("+"),
      div().flex_1().min_w(0).max_h(36).overflow_hidden().line_height("18px").child(twoLines(item.text, cpl)),
    ]);
  }

  legend(t) {
    const item = (how, text) => h_flex().gap(5).items_center().child(mark(t, how, `legend-${how}`)).child(div().child(text));
    return h_flex()
      .flex_wrap()
      .pl(14)
      .pr(10)
      .pt(10)
      .pb(4)
      .gap_x(12)
      .gap_y(2)
      .text_size(11)
      .text_color(t.dim)
      .child(item("always", "always in context"))
      .child(item("pointer", "when relevant"))
      .child(item("none", "search only"));
  }

  // ── a card ──────────────────────────────────────────────────────────────

  // The card's two parts: what scrolls, and its actions at the bottom edge.
  card(t, card) {
    const id = `card-${this.view?.kind ?? "gone"}-${this.view?.id ?? ""}${this.form ? "-form" : ""}`;
    const scroll = (children) => v_flex().id(`${id}-box`).flex_1().min_h(0).child(v_flex().id(id).size_full().overflow_y_scrollbar().px(16).pt(14).pb(18).gap(12).children(children));
    if (card.kind === "gone") return [scroll([div().text_color(t.dim).child(this.view?.kind === "review" || this.view?.kind === "agents" ? "This proposal is no longer in the review." : "This is no longer in memory.")])];
    const { body, actions } =
      card.kind === "note" ? noteCard(this, t, card)
      : card.kind === "inbox" ? inboxCard(this, t, card.item)
      : card.kind === "review" ? reviewCard(this, t, card)
      : agentsCard(this, t, card);
    const out = [scroll(body)];
    if (actions?.length) out.push(h_flex().id(`${id}-actions`).flex_none().flex_wrap().px(12).py(8).gap(6).items_center().border_t(1).border_color(t.border).children(actions));
    return out;
  }

  // ── the dream, at the bottom ────────────────────────────────────────────

  footer(t) {
    const d = this.data, s = this.status;
    const bar = h_flex().h(30).flex_none().pl(12).pr(8).gap(12).items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim);
    const web = iconButton(t, "f-web", "external", `Open wierd-mem in the browser (${this.server})`, (_e, cx) => cx.open_url(`${this.server}/`), 22);
    if (this.down) return bar.child(div().child("Looking for the server…")).child(div().flex_1());
    if (!d || !s) return bar.child(div().child(this.loading || this.down === null ? "Reading memory…" : "")).child(div().flex_1()).child(web);
    const dream = s.dream ?? {};
    const last = dream.last;
    const item = (id, name, text, tip, color, onClick) => h_flex()
      .id(id)
      .gap(5)
      .items_center()
      .flex_none()
      .when(Boolean(color), (el) => el.text_color(color))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => onClick(cx)))
      .child(name === "spinner" ? svg(icon("spinner")).size(12).text_color(t.working).spin(900) : svg(icon(name)).size(12))
      .child(div().child(text));

    const due = dream.due ?? {};
    const waiting = [due.sessions ? `${due.sessions} new session${due.sessions === 1 ? "" : "s"}` : "", due.inbox ? `${due.inbox} in the inbox` : ""].filter(Boolean).join(", ");
    const next = `\n${dream.scheduled ? (due.due ? "The next dream is due" : `The next dream: not yet${due.reason ? ` (${due.reason})` : ""}`) : "Scheduled dreams are off"}${waiting ? `\nWaiting for it: ${waiting}` : ""}`;
    let status;
    if (dream.running) {
      const r = dream.running;
      status = item("f-dream", "spinner", `Dreaming${running(r.startedAt)}`, `A dream is running (${r.id}), started ${stamp(r.startedAt)}`, t.working);
    } else if (!last) {
      status = item("f-dream", "moon", "No dreams yet", next.trim());
    } else {
      const at = Date.parse(last.finishedAt ?? last.startedAt);
      const facts = [`Last dream ${stamp(last.finishedAt ?? last.startedAt)}`, last.sessions ? `${last.sessions} sessions` : "", last.cost ? `$${last.cost.toFixed(2)}` : "", last.status === "noop" ? "nothing new" : last.status === "cancelled" ? "cancelled" : "", last.id].filter(Boolean).join(" · ");
      status = last.status === "error"
        ? item("f-dream", "alert", `Dream failed ${ago(at)}`, `${facts}\n${last.error ?? ""}${next}`, t.blocked)
        : item("f-dream", "moon", `Dreamt ${ago(at)}`, `${facts}${next}`);
    }
    const todo = this.proposals().length;
    const inbox = d.inbox.length;
    return bar
      .child(status)
      .when(Boolean(d.review), (el) => el.child(item("f-review", "review", `Review ${todo}`, `${d.review.title}\n${todo} to decide: click to go through them`, t.accent, (cx) => {
        this.goReview();
        this.handle.focus();
        cx.notify();
      })))
      .when(inbox > 0, (el) => el.child(item("f-inbox", "inbox", String(inbox), `${inbox} kept for the next dream`, null, (cx) => {
        this.open.inbox = true;
        localStorage.setItem("open", JSON.stringify(this.open));
        this.back(cx);
      })))
      .child(div().flex_1())
      .child(web);
  }
}
