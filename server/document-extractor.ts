import { parentPort, workerData } from 'node:worker_threads';
import { extractDocument } from './document-extraction.js';

try {
  parentPort!.postMessage({ text: await extractDocument(workerData.data, workerData.name) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : 'Could not read this document.' });
}
