import { Worker } from 'node:worker_threads';

let running = 0;
export async function convertDocument(data: Buffer, name: string): Promise<string> {
  if (running >= 2) throw Object.assign(new Error('Document extraction is busy. Please try again shortly.'), { status: 429 });
  running++;
  try {
    return await new Promise<string>((resolve, reject) => {
      const worker = new Worker(new URL('./document-extractor.mjs', import.meta.url), {
        workerData: { data, name }, resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      let finished = false;
      const finish = (error?: Error, text?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); void worker.terminate();
        if (error) reject(error); else resolve(text!);
      };
      const timer = setTimeout(() => finish(Object.assign(new Error('Document extraction took too long. Try a smaller file.'), { status: 422 })), 30000);
      worker.once('message', message => finish(message.error ? Object.assign(new Error(message.error), { status: 422 }) : undefined, message.text));
      worker.once('error', () => finish(Object.assign(new Error('Could not extract this document. It may be damaged or too large.'), { status: 422 })));
      worker.once('exit', () => finish(Object.assign(new Error('Document extraction stopped before completing.'), { status: 422 })));
    });
  } finally { running--; }
}
