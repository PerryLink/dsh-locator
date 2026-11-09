/**
 * Reveal one indexed path in the platform file manager.
 * @module dsh-locator/reveal
 */
/** Whether target is one of the roots or lives below one of them. */
export declare function withinRoots(target: string, roots: readonly string[]): boolean;
/**
 * Ask the platform file manager to select a path. Uses an argument vector, not
 * a shell, so a path can never be interpreted as a command. The child is
 * detached: the opener outlives the plugin call.
 */
export declare function revealInFileManager(target: string): Promise<void>;
//# sourceMappingURL=reveal.d.ts.map