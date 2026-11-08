'use strict';
// XMind marker ids -> a small drawn glyph. No picture files: circles, pies and text glyphs, colored per family.
// Unknown ids get a neutral tag with the id as tooltip, so nothing is silently lost.

const COLORS = {
  red: '#e5484d', orange: '#f76b15', yellow: '#f5d90a', green: '#30a46c', blue: '#0091ff', purple: '#8e4ec6',
  gray: '#8b8d98', grey: '#8b8d98', black: '#5b5b5b', 'dark-blue': '#2a4ab3', 'dark-green': '#1f7a4d', 'dark-gray': '#5b5b5b', white: '#cfcfcf',
};
const PRIORITY = ['#e5484d', '#f76b15', '#0091ff', '#30a46c', '#8e4ec6', '#8b8d98', '#ad7f58', '#12a594', '#d6409f'];
const TASK = { start: 0, oct: 0.125, quarter: 0.25, '3oct': 0.375, half: 0.5, '5oct': 0.625, '3quar': 0.75, '7oct': 0.875, done: 1 };
const SMILEY = { laugh: '😄', smile: '🙂', cry: '😢', surprise: '😮', boring: '😑', angry: '😠', embarrass: '😳', thumbs: '👍' };
const ARROW = { up: '↑', 'up-right': '↗', right: '→', 'down-right': '↘', down: '↓', 'down-left': '↙', left: '←', 'up-left': '↖', refresh: '⟳' };
const SYMBOL = { plus: '+', minus: '−', question: '?', exclam: '!', info: 'i', wrong: '✕', right: '✓', 'attention': '!' };
const FM = { idea: '💡', stop: '⛔', go: '🟢', bomb: '💣', bookmark: '🔖', info: 'ℹ', attach: '📎', key: '🔑', pencil: '✏', calendar: '📅', list: '☰' };
const MONTH = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** -> { kind: 'num'|'pie'|'text', color, text, frac, label } */
function markerGlyph(id) {
  const s = String(id || '').toLowerCase();
  const [fam, ...rest] = s.split('-');
  const v = rest.join('-');
  if (fam === 'priority') { const n = Number(v); if (n >= 1 && n <= 9) return { kind: 'num', color: PRIORITY[n - 1], text: String(n), label: `Priority ${n}` }; }
  if (fam === 'task' && v in TASK) return { kind: 'pie', color: '#30a46c', frac: TASK[v], label: v === 'done' ? 'Task done' : `Task ${Math.round(TASK[v] * 100)}%` };
  if (fam === 'flag') return { kind: 'text', color: COLORS[v] || COLORS.red, text: '⚑', label: `Flag ${v}` };
  if (fam === 'star') return { kind: 'text', color: COLORS[v] || COLORS.yellow, text: '★', label: `Star ${v}` };
  if (fam === 'people' || fam === 'c' && v === 'people') return { kind: 'text', color: COLORS[v] || COLORS.blue, text: '●', label: `Person ${v}` };
  if (fam === 'smiley' || fam === 'emotion') return { kind: 'text', color: '', text: SMILEY[v] || '🙂', label: `Smiley ${v}` };
  if (fam === 'arrow') return { kind: 'text', color: '#0091ff', text: ARROW[v] || '→', label: `Arrow ${v}` };
  if (fam === 'symbol') return { kind: 'text', color: '#8e4ec6', text: SYMBOL[v] || '•', label: `Symbol ${v}` };
  if (fam === 'month' && MONTH.includes(v)) return { kind: 'tag', color: '#0091ff', text: v.slice(0, 3).replace(/^./, c => c.toUpperCase()), label: `Month ${v}` };
  if (fam === 'week' && WEEK.includes(v)) return { kind: 'tag', color: '#12a594', text: v.slice(0, 2).replace(/^./, c => c.toUpperCase()), label: `Day ${v}` };
  if (fam === 'half' || fam === 'other') return { kind: 'text', color: '#8b8d98', text: '◐', label: s };
  if (fam === 'fm') return { kind: 'text', color: '', text: FM[v] || '•', label: v };
  if (fam === 'tag' || fam === 'c') return { kind: 'text', color: COLORS[v] || '#8b8d98', text: '◆', label: s };
  return { kind: 'tag', color: '#8b8d98', text: '?', label: `Marker ${s || '(empty)'}` };
}

module.exports = { markerGlyph };
