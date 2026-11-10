// The list, scrolling itself, as the sidebar's does (wierd-agents' scroll.js; a
// mod can't import another mod's files): a native scroll area can't be moved
// from code, and keeping the cursor's row in view needs that. Every piece has a
// known height, so where each one sits is known without drawing it.
//
// Every step of the wheel draws the panel again, so only what shows is made:
// the pieces in view and OVERSCAN around them; the rest of the list is room
// above and below them. (Made whole, a long list cost more than a frame.)
//
// scrollList(owner, t, items, st, opts)
//   owner     the panel: keeps viewH / viewW (the list's size, px at zoom 1) and
//             drag (the thumb being dragged) on it.
//   items     [{ h, make }]: each piece's height (px at zoom 1) and what makes
//             its element, edge to edge.
//   st        the list's own state: { offset, animateUntil, from }.
//   followAt  an item to bring into view, animated.
//   onScroll  runs when the wheel or the thumb moves the list.

import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { settings } from "herdr";

// The scrollbar: a thin thumb in the list's right padding, clear of the rows,
// in a wider strip that takes the pointer.
const THUMB_W = 3, THUMB_RIGHT = 2, THUMB_HIT = 7;
// How long scrolling to a row takes, and the room kept around it.
const SCROLL_MS = 280;
const FOLLOW_MARGIN = 8;
// How far past the edges pieces are made (px): a fast flick shows no gap
// before the next frame.
const OVERSCAN = 300;

export function scrollList(owner, t, items, st, { followAt = null, onScroll = null } = {}) {
  const now = Date.now();
  let y = 0;
  const tops = items.map((it) => {
    const top = y;
    y += it.h;
    return top;
  });
  const total = y;
  const viewH = owner.viewH ?? 0;
  const maxOff = Math.max(0, total - viewH);
  const clamp = (v) => Math.max(0, Math.min(v, maxOff));
  st.offset = clamp(st.offset ?? 0);

  if (followAt != null && items[followAt] && viewH > 0) {
    const top = tops[followAt];
    const h = items[followAt].h;
    if (top < st.offset + FOLLOW_MARGIN || top + h > st.offset + viewH - FOLLOW_MARGIN) {
      // Just inside the edge it was going past: the rows around it stay where the eye is.
      st.from = st.offset;
      st.offset = clamp(top < st.offset + FOLLOW_MARGIN ? top - FOLLOW_MARGIN - 40 : top + h - viewH + FOLLOW_MARGIN + 40);
      st.animateUntil = now + SCROLL_MS + 50;
    }
  }
  const gliding = now < (st.animateUntil ?? 0);
  const motion = gliding ? { duration: SCROLL_MS, easing: "ease-out" } : { duration: 0 };

  // What shows: while it glides to a row, everything on the way.
  const from = gliding ? Math.min(st.offset, st.from ?? st.offset) : st.offset;
  const to = (gliding ? Math.max(st.offset, st.from ?? st.offset) : st.offset) + (viewH || 1000);
  let first = 0;
  while (first < items.length && tops[first] + items[first].h < from - OVERSCAN) first++;
  let last = first;
  while (last < items.length && tops[last] <= to + OVERSCAN) last++;
  const above = first < items.length ? tops[first] : total;
  const below = total - (last < items.length ? tops[last] : total);

  const thumbH = total > 0 ? Math.max(24, (viewH * viewH) / total) : 0;
  const thumbTop = maxOff > 0 ? (st.offset / maxOff) * (viewH - thumbH) : 0;
  const zoom = settings().zoom || 1;
  const scrollTo = (v, cx) => {
    const next = clamp(v);
    st.animateUntil = 0;
    if (next === st.offset) return;
    st.offset = next;
    onScroll?.();
    cx.notify();
  };
  return v_flex()
    .id("mem-list")
    .relative()
    .flex_1()
    .min_h(0)
    .overflow_hidden()
    .on_size_change((size, cx) => {
      const h = size.height / zoom, w = size.width / zoom;
      if (h === owner.viewH && Math.abs(w - (owner.viewW ?? 0)) < 1) return;
      owner.viewH = h;
      owner.viewW = w;
      cx.notify();
    })
    .on_scroll_wheel((e, cx) => scrollTo(st.offset - e.delta.y / zoom, cx))
    .on_mouse_move((e, cx) => {
      if (!owner.drag) return;
      const track = viewH - thumbH;
      if (track > 0) scrollTo(owner.drag.off + ((e.position.y - owner.drag.y) / zoom) * (maxOff / track), cx);
    })
    .on_mouse_up("left", () => {
      owner.drag = null;
    })
    .on_hover((on) => {
      if (!on) owner.drag = null;
    })
    .child(v_flex()
      .id("mem-content")
      .absolute()
      .left(0)
      .right(0)
      .top(-st.offset)
      .transition("top", motion)
      .px(8)
      .when(above > 0, (el) => el.child(div().h(above).flex_none()))
      .children(items.slice(first, last).map((it) => it.make()))
      .when(below > 0, (el) => el.child(div().h(below).flex_none())))
    .when(maxOff > 0, (el) => el.child(div()
      .id("mem-thumb")
      .absolute()
      .right(0)
      .top(thumbTop)
      .transition("top", motion)
      .w(THUMB_HIT)
      .h(thumbH)
      .flex()
      .justify_end()
      .pr(THUMB_RIGHT)
      .on_hover((on, cx) => {
        owner.thumbHover = on;
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        owner.drag = { y: e.position.y, off: st.offset };
        st.animateUntil = 0;
        cx.notify();
      })
      .child(div()
        .w(THUMB_W)
        .h_full()
        .rounded(THUMB_W / 2)
        .bg(owner.drag || owner.thumbHover ? t.muted + "99" : t.dim + "66"))));
}
