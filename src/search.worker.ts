const index = new Map<string, { title: string; text: string }>();
self.onmessage = ({ data }) => {
  if (data.type === 'index') { for (const d of data.docs) index.set(d.id, { title: d.title.toLowerCase(), text: (d.markdown || '').toLowerCase() }); }
  if (data.type === 'search') {
    const q = data.query.toLowerCase().trim(); const terms = q.split(/\s+/);
    const ids = [...index].filter(([, d]) => terms.every((term: string) => `${d.title}\n${d.text}`.includes(term))).sort((a, b) => Number(b[1].title.includes(q)) - Number(a[1].title.includes(q))).map(([id]) => id);
    self.postMessage({ type: 'results', query: data.query, ids });
  }
};
