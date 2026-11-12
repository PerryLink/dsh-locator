/**
 * Reveal/open one indexed path safely.
 *
 * Both operations are authorized against the indexed roots on the **real**
 * path: the target and every root are canonicalized with `realpath`, so a
 * symlink cannot be used to point the file manager or the platform opener at
 * something outside the configured roots. A target that does not exist is
 * authorized through its nearest existing ancestor, whose real path must still
 * live inside a root. Opening with the default application is additionally
 * refused for executable and script file types (extension or Unix executable
 * bit), because a document viewer route must never launch a program.
 * @module dsh-locator/reveal
 */
/** A canonical path and whether the target itself (not just an ancestor) exists. */
export interface ResolvedTarget {
    /** Canonical real path; for a missing target, its nearest real ancestor plus the missing suffix. */
    readonly path: string;
    /** True when the target itself exists. */
    readonly exists: boolean;
}
/**
 * Canonical real path of `target`, or of its nearest existing ancestor with the
 * missing suffix appended when `target` itself is absent.
 *
 * `realpath` resolves every symlink in an existing component, so the result is
 * the only value that may be compared against canonical roots. Returns
 * undefined for a relative path, a filesystem error other than ENOENT/ENOTDIR
 * (for example EACCES), or a path whose root has no existing ancestor.
 * @param target - absolute path to canonicalize.
 * @returns the canonical target and whether it exists.
 */
export declare function realPathOf(target: string): ResolvedTarget | undefined;
/**
 * Return the nested mount point that could hide content outside a root, if any.
 * @param target - canonical target path.
 * @param roots - canonical roots.
 * @param mounts - test seam; defaults to the current process mount table.
 */
export declare function mountEscape(target: string, roots: readonly string[], mounts?: readonly string[]): string | undefined;
/**
 * Authorize `target` against the indexed roots on canonical paths.
 *
 * The target and the roots are both resolved with `realpath`; a symlink that
 * points outside a root is denied even though its lexical path looked inside.
 * A missing target is still authorized when its nearest existing ancestor is
 * inside a root, which keeps the containment check meaningful for paths that
 * appear between the search and the reveal.
 * @param target - requested absolute path.
 * @param roots - configured indexed roots (any form: they are canonicalized).
 * @returns the canonical path plus whether it exists, or undefined when the
 * request must be refused.
 */
export declare function resolveWithinRoots(target: string, roots: readonly string[]): ResolvedTarget | undefined;
/** Whether target is one of the roots or lives below one of them (canonical paths). */
export declare function withinRoots(target: string, roots: readonly string[]): boolean;
/**
 * Extensions that name a program or a script, not a document. Opening one with
 * the platform's default handler can execute code (Windows ShellExecute,
 * `.desktop` launchers, shell script interpreters), so the open route refuses
 * them outright instead of relying on the handler's own judgement.
 */
export declare const EXECUTABLE_EXTENSIONS: ReadonlySet<string>;
/**
 * Why opening `target` with the default application is unsafe, if it is.
 *
 * Extension matching is case-insensitive and uses the **real** path, so a
 * harmless-looking symlink name cannot disguise a script. On Unix an
 * executable permission bit is refused too, which covers extensionless
 * binaries and scripts.
 * @param target - canonical path about to be opened.
 * @param mode - the target's `stat.mode`, when known.
 * @returns a human-readable refusal, or undefined when the open may proceed.
 */
export declare function executableFileRejection(target: string, mode?: number): string | undefined;
/**
 * Ask the platform to reveal a path in its file manager. Uses an argument
 * vector, not a shell, so a path can never be interpreted as a command. The
 * child is detached: the opener outlives the plugin call.
 * @param target - canonical path inside the indexed roots.
 */
export declare function revealInFileManager(target: string): Promise<void>;
/**
 * Open a path with its default application.
 * @param target - canonical path inside the indexed roots; callers must have
 * rejected {@link executableFileRejection} first.
 */
export declare function openWithDefaultApp(target: string): Promise<void>;
//# sourceMappingURL=reveal.d.ts.map