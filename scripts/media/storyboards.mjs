// Each video is exactly 30 seconds. Footage is real-time; only agent waiting is cut.
export const videos = [
  {
    id: '01-speed', label: 'THE FAST ONE', theme: 'light', title: 'Your brain hates loading screens',
    post: 'Your brain called. It hates loading screens. Meet Garnet: lightweight shared notes, worker-powered search, local autosave, and your Claude or Codex right in your documents. Free, open source, MIT. https://github.com/keysforthewin/Garnet',
    shots: [
      { source: 'home', duration: 3, title: 'Your brain called.\nIt hates loading screens.', size: 66, bullets: ['Meet Garnet. A little more room to think.'] },
      { source: 'typing', duration: 5, crop: 'editor', title: 'Less waiting.\nMore writing.', bullets: ['Lightweight frontend', 'Responsive editing'] },
      { source: 'search', duration: 5, title: 'Find the thought.\nKeep the flow.', bullets: ['Search runs in a Web Worker', 'Off the UI thread. On with your day.'] },
      { source: 'offline', duration: 5, crop: 'editor', title: 'Type. It’s\nalready saving.', bullets: ['Local autosave · Background sync', 'Service-worker cache for offline use'] },
      { source: 'collaboration', duration: 4, offset: 0.7, crop: 'editor', title: 'Good ideas\ntravel together.', bullets: ['Live collaboration', 'Incremental sync'] },
      { source: 'agent-choice', duration: 4, title: 'Bring your\nClaude or Codex.', bullets: ['Right inside your documents', 'Uses your existing CLI accounts'] },
      { duration: 4, end: true },
    ],
  },
  {
    id: '02-together', label: 'THE SHARED ONE', theme: 'dark', title: 'One doc. Multiple brains.',
    post: 'One doc. Multiple brains. Write together in Garnet with live cursors, local autosave, and incremental sync. Need another brain? Bring your Claude or Codex. Free, open source, MIT. https://github.com/keysforthewin/Garnet',
    shots: [
      { source: 'collaboration', duration: 3, crop: 'editor', title: 'One doc.\nMultiple brains.', bullets: ['Garnet. Shared notes, in real time.'] },
      { source: 'collaboration', offset: 1, duration: 6, crop: 'editor', title: 'You write.\nThey’re already there.', size: 68, bullets: ['Live edits', 'Shared cursors'] },
      { source: 'sync', duration: 5, crop: 'editor', title: 'Small updates.\nShared momentum.', bullets: ['Incremental live sync', 'Automatic local saves'] },
      { source: 'search', duration: 5, title: 'Keep up with\nthe idea pile.', bullets: ['Lightweight frontend', 'Worker-powered search'] },
      { source: 'claude-result', duration: 7, title: 'Invite one\nmore brain.', bullets: ['Your Claude or Codex', 'In-document help'], shortened: true },
      { duration: 4, end: true },
    ],
  },
  {
    id: '03-agents', label: 'THE CLEVER ONE', theme: 'light', title: 'Your notes brought backup',
    post: 'Your notes brought backup. Bring your Claude or Codex into Garnet to turn rough thoughts into useful drafts, then keep writing together. Lightweight, responsive, free, and MIT licensed. https://github.com/keysforthewin/Garnet',
    shots: [
      { source: 'agent-choice', duration: 3, title: 'Your notes\nbrought backup.', bullets: ['Meet Garnet. Your ideas have company.'] },
      { source: 'codex-prompt', duration: 5, title: 'Your Claude. Your Codex.\nYour document.', size: 62, bullets: ['Choose your agent', 'Keep the context'] },
      { source: 'codex-result', duration: 7, title: 'Rough idea.\nUseful first draft.', bullets: ['Reads your document', 'Edits in place'], shortened: true },
      { source: 'agent-collaboration', duration: 5, title: 'Now make it yours.\nTogether.', bullets: ['Live collaboration', 'Local autosave'] },
      { source: 'navigate', duration: 6, title: 'Big ideas.\nLight frontend.', bullets: ['Worker-powered search · Responsive editing', 'Background sync'], bulletSize: 34 },
      { duration: 4, end: true },
    ],
  },
];
