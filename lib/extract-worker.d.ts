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
export {};
//# sourceMappingURL=extract-worker.d.ts.map