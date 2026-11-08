'use strict';
// Mind map layouts. Pure functions over a list of visible nodes; no DOM. Every walk is iterative.
// A node here: { t (topic), w, h, kids: [node], parent, depth, dir (+1 right, -1 left), x, y }
// Layouts: map (both sides), right, left, tree (indented, right), org (down), orgup.

const H_GAP = 36;      // parent to child, horizontal layouts
const V_GAP = 10;      // between siblings, horizontal layouts
const ORG_H_GAP = 16;  // between siblings, org chart
const ORG_V_GAP = 40;  // parent to child, org chart
const TREE_INDENT = 28;
const TREE_V_GAP = 8;
const SUM_GAP = 34;    // range to summary topic

/** Height of a subtree plus the room kept for boundary frames around it. */
const ext = k => k.sh + (k.padT || 0) + (k.padB || 0);

/** Preorder list of a subtree (iterative). */
function preorder(root) {
  const out = [];
  const st = [root];
  while (st.length) {
    const n = st.pop();
    out.push(n);
    for (let i = n.kids.length - 1; i >= 0; i--) st.push(n.kids[i]);
  }
  return out;
}

/** Horizontal (logic) layout of a subtree. dir +1 grows right, -1 grows left. Root of the subtree at (x, y center 0). */
function layoutHorizontal(root, dir) {
  const order = preorder(root);
  // subtree heights, postorder
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    n.dir = dir;
    let kh = 0;
    for (const k of n.kids) kh += ext(k);
    if (n.kids.length) kh += V_GAP * (n.kids.length - 1);
    n.kh = kh;
    n.sh = Math.max(n.h, kh);
  }
  root.cx = 0; root.cy = 0; // center of the node
  for (const n of order) {
    n.x = dir > 0 ? n.cx - (n === root ? n.w / 2 : 0) : n.cx - (n === root ? n.w / 2 : n.w);
    // for non-root nodes cx is the attach edge: left edge when dir>0, right edge when dir<0
    if (n !== root) n.x = dir > 0 ? n.cx : n.cx - n.w;
    n.y = n.cy - n.h / 2;
    let y = n.cy - n.kh / 2;
    const edge = dir > 0 ? n.x + n.w + H_GAP : n.x - H_GAP;
    for (const k of n.kids) {
      k.cx = edge;
      k.cy = y + (k.padT || 0) + k.sh / 2;
      y += ext(k) + V_GAP;
    }
  }
}

/** Org chart (top down). up=true mirrors it. */
function layoutOrg(root, up) {
  const order = preorder(root);
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    n.dir = 2;
    let kw = 0;
    for (const k of n.kids) kw += k.sw;
    if (n.kids.length) kw += ORG_H_GAP * (n.kids.length - 1);
    n.kw = kw;
    n.sw = Math.max(n.w, kw);
  }
  root.cx = 0; root.ty = 0;
  for (const n of order) {
    n.x = n.cx - n.w / 2;
    n.y = up ? -n.ty - n.h : n.ty;
    let x = n.cx - n.kw / 2;
    for (const k of n.kids) {
      k.cx = x + k.sw / 2;
      k.ty = n.ty + n.h + ORG_V_GAP;
      x += k.sw + ORG_H_GAP;
    }
  }
  if (up) for (const n of order) n.dir = 3;
}

/** Indented tree: children under the parent, shifted right. */
function layoutTree(root) {
  const order = preorder(root);
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    n.dir = 4;
    let sh = n.h;
    for (const k of n.kids) sh += TREE_V_GAP + ext(k);
    n.sh = sh;
  }
  root.x = -root.w / 2; root.y = -root.h / 2;
  for (const n of order) {
    let y = n.y + n.h + TREE_V_GAP;
    for (const k of n.kids) {
      k.x = n.x + TREE_INDENT;
      k.y = y + (k.padT || 0);
      y += ext(k) + TREE_V_GAP;
    }
  }
}

/** Map: main topics split over the right and the left side by height, clockwise like XMind. */
function layoutMap(root) {
  const kids = root.kids;
  const sizes = [];
  // measure each main subtree with a throwaway horizontal pass
  for (const k of kids) {
    layoutHorizontalHeights(k);
    sizes.push(ext(k));
  }
  const total = sizes.reduce((a, b) => a + b, 0) + V_GAP * Math.max(0, kids.length - 1);
  let right = [], left = [];
  const forced = kids.some(k => k.t.side);
  if (forced) {
    for (const k of kids) (k.t.side === 'left' ? left : right).push(k);
  } else if (kids.length <= 1) right = kids.slice();
  else {
    let acc = 0, split = kids.length;
    for (let i = 0; i < kids.length; i++) {
      if (acc + sizes[i] / 2 > total / 2 && i > 0) { split = i; break; }
      acc += sizes[i] + V_GAP;
    }
    if (split === kids.length) split = Math.ceil(kids.length / 2);
    right = kids.slice(0, split);
    left = kids.slice(split).reverse(); // clockwise: the left side runs bottom to top
  }
  root.x = -root.w / 2; root.y = -root.h / 2; root.dir = 0;
  // A stand-in root of the same size: its children land at the real root's edges.
  const side = (list, dir) => layoutHorizontal({ kids: list, w: root.w, h: root.h, t: root.t }, dir);
  side(right, 1);
  side(left, -1);
  root.kids = right.concat(left.slice().reverse());
  root.sh = Math.max(root.h, total);
}

function layoutHorizontalHeights(root) {
  const order = preorder(root);
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    let kh = 0;
    for (const k of n.kids) kh += ext(k);
    if (n.kids.length) kh += V_GAP * (n.kids.length - 1);
    n.kh = kh;
    n.sh = Math.max(n.h, kh);
  }
}

/** Bounding box of each subtree (bx0, by0, bx1, by1), postorder. */
function subtreeBoxes(root) {
  const order = preorder(root);
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    let x0 = n.x, y0 = n.y, x1 = n.x + n.w, y1 = n.y + n.h;
    for (const k of n.kids) { if (k.bx0 < x0) x0 = k.bx0; if (k.by0 < y0) y0 = k.by0; if (k.bx1 > x1) x1 = k.bx1; if (k.by1 > y1) y1 = k.by1; }
    n.bx0 = x0; n.by0 = y0; n.bx1 = x1; n.by1 = y1;
  }
}

function layout(root, mode) {
  if (mode === 'map') layoutMap(root);
  else if (mode === 'left' || mode === 'right') {
    layoutHorizontal(root, mode === 'left' ? -1 : 1);
    root.dir = 0;
  } else if (mode === 'org' || mode === 'orgup') layoutOrg(root, mode === 'orgup');
  else if (mode === 'tree') layoutTree(root);
  else layoutMap(root);
  subtreeBoxes(root);
}

/** Moves a whole subtree. */
function shift(root, dx, dy) {
  for (const n of preorder(root)) { n.x += dx; n.y += dy; if (n.bx0 !== undefined) { n.bx0 += dx; n.bx1 += dx; n.by0 += dy; n.by1 += dy; } }
}

/** Org layout of a summary subtree, with subtree boxes. */
function layoutOrgSub(root, up) {
  layoutOrg(root, up);
  subtreeBoxes(root);
}

module.exports = { layoutOrgSub, layout, preorder, subtreeBoxes, shift, layoutHorizontal, H_GAP, V_GAP, SUM_GAP, ORG_V_GAP };
