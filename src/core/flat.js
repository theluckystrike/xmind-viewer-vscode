'use strict';
// The model travels to the webview as flat topic lists. VS Code's message passing walks objects recursively,
// so a topic tree 2,000 levels deep would overflow its stack; flat lists have a depth of 4.
// Used by the extension (flatten) and the webview (unflatten). Both walks are iterative.

function flatten(model) {
  return {
    ...model,
    flat: true,
    sheets: model.sheets.map(s => {
      const topics = [];
      const index = new Map();
      const st = [s.root, ...s.detached];
      while (st.length) {
        const t = st.pop();
        index.set(t, topics.length);
        topics.push(t);
        for (const c of t.children) st.push(c);
        for (const x of t.summaries) if (x.topic) st.push(x.topic);
      }
      const flatTopics = topics.map(t => ({
        ...t,
        children: t.children.map(c => index.get(c)),
        summaries: t.summaries.map(x => ({ ...x, topic: x.topic ? index.get(x.topic) : -1 })),
      }));
      return { ...s, root: index.get(s.root), detached: s.detached.map(d => index.get(d)), topics: flatTopics };
    }),
  };
}

function unflatten(model) {
  if (!model || !model.flat) return model;
  for (const s of model.sheets) {
    const ts = s.topics;
    for (const t of ts) {
      t.children = t.children.map(i => ts[i]).filter(Boolean);
      t.summaries = t.summaries.map(x => ({ ...x, topic: x.topic >= 0 ? ts[x.topic] || null : null }));
    }
    s.root = ts[s.root];
    s.detached = s.detached.map(i => ts[i]).filter(Boolean);
    delete s.topics;
  }
  delete model.flat;
  return model;
}

module.exports = { flatten, unflatten };
