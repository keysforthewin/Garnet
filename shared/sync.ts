import * as Y from 'yjs';
// CRDT struct encodings may differ after garbage collection. Acknowledgments
// compare the version vector plus deletion intervals, not raw binary encodings.
export function persistenceSignature(update: Uint8Array) {
  const vector = [...Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update))].sort((a, b) => a[0] - b[0]);
  const deleted = [...Y.decodeUpdate(update).ds.clients].sort((a, b) => a[0] - b[0]).map(([id, ranges]) => [id, ranges.map(range => [range.clock, range.len])]);
  return JSON.stringify([vector, deleted]);
}
