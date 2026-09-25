/// <reference lib="webworker" />
import { BackplotParser, chunks, transferables, type BackplotOptions } from '../util/gcodeBackplot';

export interface BackplotRequest {
  id: number;
  text: string;
  opts: BackplotOptions;
}

export type BackplotMessage =
  | { id: number; type: 'progress'; done: number; total: number }
  | { id: number; type: 'done'; result: import('../util/gcodeBackplot').BackplotResult }
  | { id: number; type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<BackplotRequest>) => {
  const { id, text, opts } = e.data;
  try {
    const t0 = performance.now();
    const p = new BackplotParser(opts);
    let last = 0;
    for (const [a, b] of chunks(text, 1 << 19)) {
      p.feed(text, a, b);
      const now = performance.now();
      if (now - last > 80) {
        last = now;
        ctx.postMessage({ id, type: 'progress', done: b, total: text.length } satisfies BackplotMessage);
      }
    }
    const result = p.finish(performance.now() - t0);
    ctx.postMessage({ id, type: 'done', result } satisfies BackplotMessage, transferables(result));
  } catch (err) {
    ctx.postMessage({ id, type: 'error', message: String((err as Error)?.message ?? err) } satisfies BackplotMessage);
  }
};
