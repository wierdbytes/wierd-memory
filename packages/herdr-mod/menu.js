// Menus and questions. The panel opens a copy of this mod as a popup (⋯, a right
// click: props { menu }) or a dialog (are you sure: props { dialog }), drawn as
// Herdr's own menu and confirm are. The copy answers with a command to the panel,
// `wierd-memory.menu-<token>-<index>` or `wierd-memory.dialog-<token>`:
// the panel keeps what each item does, the copy only shows the labels.
// menuItems() says what a menu holds, for each thing the panel shows.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme } from "herdr";
import { icon, mark, avatarBox, scopeLook, INDEX, TYPES, TYPE_ICON, REACH_LABEL } from "./ui.js";
import { plural, clip, textWidth } from "./text.js";

// A menu row's height, a separator's, the menu's padding; a row's padding, its
// lead (icon, mark, avatar) and the gaps; the label's size, the key's.
const ROW = 31, SEP = 9, PAD = 5, ROW_PX = 8, LEAD = 16, GAP = 9, LABEL = 12.8, KEY = 11;
export const menuHeight = (items) => items.reduce((h, it, i) => h + ROW + (it.sep && i > 0 ? SEP : 0), 2 * PAD);
// As wide as its widest item (a little room over the estimate, so no label is cut).
export function menuWidth(items) {
  const label = Math.max(0, ...items.map((it) => textWidth(it.label, LABEL)));
  const right = Math.max(0, ...items.map((it) => (it.check ? 14 : it.hint ? textWidth(it.hint, KEY) : 0)));
  const w = 2 * PAD + 2 * ROW_PX + LEAD + GAP + label * 1.05 + (right ? GAP + right : 0) + 12;
  return Math.round(Math.max(140, Math.min(460, w)));
}

// ── what each menu holds ────────────────────────────────────────────────────

// [{ label, icon, hint (its key), danger, sep (a line above it), off, run(cx) }]
export function menuItems(m, target) {
  const d = m.data;
  const busy = Boolean(m.busy);
  const web = (path) => (cx) => cx.open_url(`${m.server}/#/${path}`);
  switch (target.kind) {
    case "note": {
      const n = target.note;
      const active = n.status === "active";
      return [
        ...(active ? [
          n.enabled === false
            ? { label: "Turn on", icon: "power", hint: "O", run: (cx) => m.patchNote(n, { enabled: true }, cx) }
            : { label: "Turn off", icon: "power", hint: "O", run: (cx) => m.patchNote(n, { enabled: false }, cx) },
          { label: "Edit", icon: "edit", hint: "E", run: (cx) => m.editNote(n, cx) },
          { label: n.pinned ? "Unpin" : "Pin", icon: n.pinned ? "pin-off" : "pin", hint: "P", run: (cx) => m.patchNote(n, { pinned: !n.pinned }, cx) },
        ] : [{ label: "Edit", icon: "edit", hint: "E", run: (cx) => m.editNote(n, cx) }]),
        active
          ? { label: "Close: it no longer holds", icon: "archive", sep: true, run: (cx) => m.patchNote(n, { status: "deprecated" }, cx) }
          : { label: "Reopen", icon: "archive-restore", sep: true, run: (cx) => m.patchNote(n, { status: "active" }, cx) },
        { label: "Move to…", icon: "move", off: (d?.scopes.length ?? 0) < 2, run: (cx) => m.menu({ kind: "move", note: n }, cx) },
        { label: "History", icon: "history", run: (cx) => m.showHistory(n, cx) },
        ...(n.file ? [{ label: "Open the file in $EDITOR", icon: "open", sep: true, run: (cx) => m.openFile(n.file, cx) }] : []),
        { label: `Copy ${n.id}`, icon: "copy", sep: !n.file, run: (cx) => m.copy(n.id, cx) },
        { label: "Open in the browser", icon: "external", run: web(`note/${n.id}`) },
        { label: "Delete…", icon: "trash", danger: true, sep: true, run: (cx) => m.confirmDelete(n, cx) },
      ];
    }
    case "choose": {
      // A chip's list: each choice with what marks it (the reach mark, the type's
      // icon, the project's avatar), ✓ on what it is now.
      const { field, subject } = target;
      const now = m.chosen(subject, field);
      const t = theme();
      const options = field === "index" ? INDEX.map(([v]) => ({ v, label: REACH_LABEL[v], mark: v }))
        : field === "type" ? TYPES.map((v) => ({ v, label: v, icon: TYPE_ICON[v] }))
        : m.scopeChoices().map((s) => ({ v: s.id, label: s.name, avatar: scopeLook(t, s) }));
      return options.map(({ v, ...look }) => ({ ...look, check: v === now, off: busy, run: (cx) => m.choose(subject, field, v, cx) }));
    }
    case "move": {
      const n = target.note;
      const t = theme();
      return (d?.scopes ?? []).filter((s) => s.id !== n.scope).map((s) => ({ label: s.name, avatar: scopeLook(t, s), run: (cx) => m.patchNote(n, { scope: s.id }, cx) }));
    }
    case "review": {
      const it = target.item;
      const inMemory = it.kind !== "added" && it.kind !== "skill" && it.note?.id && m.noteById(it.note.id);
      return [
        { label: "Accept", icon: "check", hint: "A", off: busy, run: (cx) => m.decide("accept", it, {}, cx) },
        ...(it.editable ? [{ label: "Edit, then accept", icon: "edit", hint: "E", run: (cx) => m.editProposal(it, cx) }] : []),
        { label: "Reject", icon: "x", hint: "X", off: busy, run: (cx) => m.decide("reject", it, {}, cx) },
        { label: "Reject with a reason…", icon: "x", hint: "⇧X", run: (cx) => m.reasonForm([it], cx) },
        ...(it.note?.id ? [{ label: "Comment for the dream…", icon: "comment", hint: "C", sep: true, run: (cx) => m.commentForm(it, cx) }] : []),
        ...(inMemory ? [{ label: "The approved note", icon: "memory", sep: !it.note?.id, run: (cx) => m.show(inMemory, cx) }] : []),
        { label: "Open in the browser", icon: "external", sep: true, run: web("review") },
      ];
    }
    case "agents": {
      const p = target.proposal;
      return [
        { label: `Apply to ${p.rel}`, icon: "check", hint: "A", off: busy, run: (cx) => m.agents("apply", p, cx) },
        { label: "Reject", icon: "x", hint: "X", off: busy, run: (cx) => m.agents("reject", p, cx) },
        { label: "Open in the browser", icon: "external", sep: true, run: web("review") },
      ];
    }
    case "inbox": {
      const it = target.item;
      return [
        { label: "Dismiss", icon: "x", hint: "X", off: busy, run: (cx) => m.dismiss(it, cx) },
        ...(it.sessionFile || it.sessionId ? [{ label: "Open the session", icon: "open", run: (cx) => m.openSession({ id: it.sessionId, file: it.sessionFile, cwd: it.cwd, name: "" }, cx) }] : []),
        { label: "Remember something…", icon: "bookmark", sep: true, run: (cx) => m.rememberForm(cx) },
      ];
    }
    case "inbox-card":
      return [
        { label: "Remember something…", icon: "bookmark", run: (cx) => m.rememberForm(cx) },
        { label: "Open the inbox in the browser", icon: "external", sep: true, run: web("inbox") },
      ];
    case "skill": {
      const s = target.skill;
      return [
        { label: "Open", icon: "file-text", run: (cx) => m.show({ kind: "skill", skill: s }, cx) },
        { label: "Delete…", icon: "trash", danger: true, sep: true, run: (cx) => m.deleteSkill(s, cx) },
      ];
    }
    case "review-card": {
      const r = d?.review;
      const items = r?.items ?? [];
      const waiting = (r?.comments ?? []).filter((c) => !c.processedRun).length;
      const comments = r?.comments?.length ?? 0;
      return [
        ...(items.length ? [{ label: `Accept all ${items.length}…`, icon: "check-check", off: busy, run: (cx) => m.acceptMany(items, "All the proposals shown", cx) }] : []),
        ...(items.length ? [{ label: `Reject all ${items.length}…`, icon: "x", off: busy, run: (cx) => m.reasonForm(items, cx) }] : []),
        { label: "Comment on the proposals…", icon: "comment", sep: items.length > 0, run: (cx) => m.commentForm(null, cx) },
        ...(comments ? [{ label: `Comments for the dream · ${comments}`, icon: "comment", run: (cx) => m.go({ kind: "comments" }, cx) }] : []),
        ...(waiting ? [{ label: "Apply the comments now", icon: "play", off: busy || Boolean(m.status?.dream?.running), run: (cx) => m.startDream("review", cx) }] : []),
        { label: "What was decided lately", icon: "history", sep: true, run: (cx) => m.go({ kind: "decided" }, cx) },
        ...(items.length ? [{ label: "The dreams behind them", icon: "moon", run: (cx) => m.go({ kind: "about" }, cx) }] : []),
        { label: "Open in the browser", icon: "external", run: web("review") },
      ];
    }
    case "review-scope": {
      const its = target.items;
      return [
        { label: `Accept ${its.length} of ${target.name}…`, icon: "check-check", off: busy, run: (cx) => m.acceptMany(its, `The ${plural(its.length, "proposal")} of ${target.name}`, cx) },
        { label: `Reject ${its.length} of ${target.name}…`, icon: "x", off: busy, run: (cx) => m.reasonForm(its, cx) },
      ];
    }
    case "scope": {
      const s = target.scope;
      return [
        { label: `New note in ${clip(s.name, 28)}`, icon: "plus", run: (cx) => m.newNote(s.id, cx) },
        { label: "What it's for, what a session gets", icon: "info", run: (cx) => m.go({ kind: "scope", id: s.id }, cx) },
        { label: "Open in the browser", icon: "external", sep: true, run: web(`memory/${encodeURIComponent(s.id)}`) },
      ];
    }
    case "add": {
      const ctx = target.ctx;
      const here = ctx?.scope ?? ctx?.newScope ?? null;
      return [
        ...(here ? [{ label: `New note in ${clip(ctx.name, 28)}`, icon: "plus", run: (cx) => m.newNote(here, cx) }] : []),
        { label: "New note in Global", icon: "plus", run: (cx) => m.newNote("global", cx) },
        { label: "Remember for the next dream…", icon: "bookmark", sep: true, run: (cx) => m.rememberForm(cx) },
      ];
    }
    case "dream": {
      const s = m.status?.dream ?? {};
      const waiting = (d?.review?.comments ?? []).filter((c) => !c.processedRun).length;
      const due = s.due ?? {};
      const fresh = (due.sessions ?? 0) + (due.inbox ?? 0);
      return [
        ...(s.running
          ? [{ label: "Stop the dream", icon: "square", danger: true, run: (cx) => m.cancelDream(s.running, cx) }]
          : [{ label: "Dream now", icon: "play", hint: fresh ? `${fresh} new` : "", off: busy, run: (cx) => m.startDream("run", cx) }]),
        ...(waiting && !s.running ? [{ label: `Apply ${plural(waiting, "comment")} now`, icon: "comment", off: busy, run: (cx) => m.startDream("review", cx) }] : []),
        { label: s.scheduled ? "Scheduled dreams: turn off" : "Scheduled dreams: turn on", icon: "clock", sep: true, off: busy, run: (cx) => m.setSchedule(!s.scheduled, cx) },
        ...(m.status?.remote?.url ? [{ label: "Sync with the remote now", icon: "refresh", off: busy, run: (cx) => m.sync(cx) }] : []),
        { label: "The dreams in the browser", icon: "external", sep: true, run: web("dreams") },
        { label: "wierd-memory in the browser", icon: "external", run: (cx) => cx.open_url(`${m.server}/`) },
      ];
    }
    default:
      return [];
  }
}

// ── the popup ───────────────────────────────────────────────────────────────

export class MenuPopup {
  init(cx) {
    this.at = -1;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  get spec() {
    return props()?.menu ?? { items: [] };
  }

  choose(i) {
    const { token, items } = this.spec;
    const it = items[i];
    if (!it || it.off) return;
    closeOverlay(props()?.overlay);
    run(`wierd-memory.menu-${token}-${i}`);
  }

  key(e, cx) {
    const items = this.spec.items;
    const k = e.keystroke;
    const step = (dir) => {
      let i = this.at;
      for (let n = 0; n < items.length; n++) {
        i = (i + dir + items.length) % items.length;
        if (!items[i].off) break;
      }
      this.at = i;
    };
    if (k === "down") step(1);
    else if (k === "up") step(-1);
    else if (k === "enter") this.choose(this.at);
    else if (k === "escape") closeOverlay(props()?.overlay);
    else {
      // A letter picks the item it's the key of (A, X, ⇧X…).
      const want = k === "shift-x" ? "⇧X" : k.length === 1 ? k.toUpperCase() : null;
      const i = want ? items.findIndex((it) => it.hint === want && !it.off) : -1;
      if (i < 0) return;
      this.choose(i);
    }
    cx.stop_propagation();
    cx.notify();
  }

  render() {
    const t = theme();
    const items = this.spec.items;
    return v_flex()
      .id("mem-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(PAD)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => this.key(e, cx))
      .children(items.map((it, i) => v_flex()
        .when(Boolean(it.sep) && i > 0, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex()
          .id(`mi-${i}`)
          .h(ROW)
          .px(ROW_PX)
          .gap(GAP)
          .rounded(7)
          .items_center()
          .text_color(it.off ? t.dim : it.danger ? t.blocked : t.foreground)
          .when(i === this.at, (el) => el.bg(t.selected))
          .when(!it.off, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
          .on_click(() => this.choose(i))
          .child(h_flex().w(LEAD).flex_none().items_center().justify_center().child(it.avatar ? avatarBox(t, it.avatar, 16)
            : it.mark ? mark(t, it.mark, `mi-mark-${i}`)
            : it.icon ? svg(icon(it.icon)).size(14).flex_none().text_color(it.off ? t.dim : it.danger ? t.blocked : t.muted)
            : div()))
          .child(div().flex_1().min_w(0).truncate().child(it.label))
          .child(it.check ? svg(icon("check")).size(14).flex_none().text_color(t.accent) : div().flex_none().text_size(KEY).text_color(t.dim).child(it.hint ?? "")))));
  }
}

// ── the question ────────────────────────────────────────────────────────────

// props { dialog: { token, title, detail, confirm, danger } }: Enter confirms,
// Esc cancels.
export class Dialog {
  init(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  yes() {
    const spec = props()?.dialog ?? {};
    closeOverlay(props()?.overlay);
    run(`wierd-memory.dialog-${spec.token}`);
  }

  render() {
    const t = theme();
    const p = props()?.dialog ?? {};
    const btn = (id, label, bg, fg, border, onClick) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(border).bg(bg).text_color(fg).cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    return v_flex()
      .id("mem-dialog")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.keystroke === "enter") this.yes();
        else if (e.keystroke === "escape") closeOverlay(props()?.overlay);
        else return;
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .rounded(8)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(p.title ?? "Are you sure?")).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().line_height("19px").text_color(t.muted).child(p.detail ?? ""))
      .child(h_flex()
        .justify_end()
        .gap(8)
        .text_size(12)
        .child(btn("no", "Cancel", t.raised, t.foreground, t.input ?? t.border, () => closeOverlay(props()?.overlay)))
        .child(btn("yes", p.confirm ?? "Confirm", p.danger ? t.blocked : t.solid, p.danger ? "#ffffff" : t.solid_foreground, p.danger ? t.blocked : t.solid, () => this.yes())));
  }
}
