import * as Y from 'yjs';
// CRDT struct encodings may differ after garbage collection. Acknowledgments
// compare the version vector plus deletion intervals, not raw binary encodings.
export function persistenceSignature(update: Uint8Array) {
  return signature(Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update)), Y.decodeUpdate(update).ds);
}
// The same signature for a live document, read from its struct store instead of
// encoding every character. Updates still waiting on missing dependencies only
// appear in the encoded form, so those documents take the slow path.
export function documentSignature(doc: Y.Doc) {
  if (doc.store.pendingStructs || doc.store.pendingDs) return persistenceSignature(Y.encodeStateAsUpdate(doc));
  const { sv, ds } = Y.snapshot(doc); return signature(sv, ds);
}
function signature(vector: Map<number, number>, ds: Y.Snapshot['ds']) {
  const deleted = [...ds.clients].sort((a, b) => a[0] - b[0]).map(([id, ranges]) => [id, ranges.map(range => [range.clock, range.len])]);
  return JSON.stringify([[...vector].sort((a, b) => a[0] - b[0]), deleted]);
}
