/**
 * Worker entry for document extraction.
 *
 * The host thread must never spend a second parsing a PDF or unzipping a deck:
 * this worker owns the heavy parse, is capped by the parent with a deadline and
 * a resource limit, and is torn down when it overruns. It is a thin shell over
 * {@link extractDocumentFromBuffer}; all format logic stays in extract.ts so the
 * in-process fallback and the worker behave identically.
 * @module dsh-locator/extract-worker
 */
import { parentPort } from 'node:worker_threads';
import { extractDocumentFromBuffer } from "./extract.js";
const port = parentPort;
if (port === null)
    throw new Error('dsh-locator extractor worker requires a parent port');
port.on('message', (message) => { void handle(message); });
/** Run one extraction and answer with a serializable reply. */
async function handle(message) {
    if (typeof message !== 'object' || message === null)
        return;
    const request = message;
    if (typeof request.id !== 'number' || typeof request.path !== 'string' || !(request.data instanceof Uint8Array))
        return;
    const warnings = [];
    const view = request.data;
    const data = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    const result = await extractDocumentFromBuffer(request.path, data, {
        maxBytes: typeof request.maxBytes === 'number' ? request.maxBytes : 0,
        ...(typeof request.maxChars === 'number' ? { maxChars: request.maxChars } : {}),
        ...(typeof request.maxMs === 'number' ? { maxMs: request.maxMs } : {}),
        onWarning: (warning) => { if (warnings.length < 20)
            warnings.push(warning); },
    });
    if (result === null) {
        port.postMessage({ id: request.id, ok: false, warnings });
        return;
    }
    port.postMessage({
        id: request.id,
        ok: true,
        result: {
            format: result.format,
            text: result.text,
            ...(result.pages === undefined ? {} : { pages: result.pages }),
        },
        warnings,
    });
}
//# sourceMappingURL=extract-worker.js.map