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
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
const WINDOWS = process.platform === 'win32';
/** Compare paths case-insensitively on Windows, where the filesystem does. */
function comparable(path) {
    return WINDOWS ? path.toLowerCase() : path;
}
/** Filesystem errors that mean "this path does not exist (yet)". */
function isMissing(error) {
    if (typeof error !== 'object' || error === null || !('code' in error))
        return false;
    const code = error.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
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
export function realPathOf(target) {
    if (typeof target !== 'string' || target === '' || !isAbsolute(target))
        return undefined;
    const absolute = resolve(target);
    const missing = [];
    let current = absolute;
    for (;;) {
        try {
            const real = realpathSync.native(current);
            return { path: missing.length === 0 ? real : join(real, ...missing.reverse()), exists: missing.length === 0 };
        }
        catch (error) {
            if (!isMissing(error))
                return undefined;
            const parent = dirname(current);
            if (parent === current)
                return undefined;
            missing.push(basename(current));
            current = parent;
        }
    }
}
/** Whether canonical `target` is `root` itself or lives below it. */
function isUnder(root, target) {
    const rel = relative(comparable(root), comparable(target));
    if (rel === '')
        return true;
    if (isAbsolute(rel))
        return false;
    return rel !== '..' && !rel.startsWith(`..${sep}`);
}
/**
 * Mount points that live *below* an indexed root. A bind mount can put a
 * directory from outside the root there while its canonical path still looks
 * inside; Linux exposes those mount points in `/proc/self/mountinfo`. This is a
 * best-effort defence, not a substitute for the realpath check.
 */
function linuxMountPoints() {
    if (process.platform !== 'linux')
        return [];
    let text = '';
    try {
        text = readFileSync('/proc/self/mountinfo', 'utf8');
    }
    catch {
        return [];
    }
    const points = [];
    for (const line of text.split('\n')) {
        if (line === '')
            continue;
        // mountinfo field 5 (0-based 4) is the mount point, escaped as \040 etc.
        const fields = line.split(' ');
        const raw = fields[4];
        if (raw === undefined)
            continue;
        const point = raw.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8)));
        if (isAbsolute(point))
            points.push(point);
    }
    return points;
}
/**
 * Return the nested mount point that could hide content outside a root, if any.
 * @param target - canonical target path.
 * @param roots - canonical roots.
 * @param mounts - test seam; defaults to the current process mount table.
 */
export function mountEscape(target, roots, mounts = linuxMountPoints()) {
    for (const mount of mounts) {
        for (const root of roots) {
            if (!isUnder(root, mount) || comparable(mount) === comparable(root))
                continue;
            if (isUnder(mount, target))
                return mount;
        }
    }
    return undefined;
}
/** Canonical (real) forms of the configured roots; unusable roots are dropped, never widened. */
function realRoots(roots) {
    const canonical = [];
    for (const root of roots) {
        const resolved = realPathOf(root);
        if (resolved !== undefined)
            canonical.push(resolved.path);
    }
    return canonical;
}
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
export function resolveWithinRoots(target, roots) {
    const real = realPathOf(target);
    if (real === undefined)
        return undefined;
    const canonicalRoots = realRoots(roots);
    for (const root of canonicalRoots) {
        if (!isUnder(root, real.path))
            continue;
        if (mountEscape(real.path, canonicalRoots) !== undefined)
            return undefined;
        return real;
    }
    return undefined;
}
/** Whether target is one of the roots or lives below one of them (canonical paths). */
export function withinRoots(target, roots) {
    return resolveWithinRoots(target, roots) !== undefined;
}
/**
 * Extensions that name a program or a script, not a document. Opening one with
 * the platform's default handler can execute code (Windows ShellExecute,
 * `.desktop` launchers, shell script interpreters), so the open route refuses
 * them outright instead of relying on the handler's own judgement.
 */
export const EXECUTABLE_EXTENSIONS = new Set([
    '.exe', '.com', '.msi', '.msix', '.scr', '.pif', '.cpl',
    '.bat', '.cmd', '.ps1', '.psm1', '.psd1',
    '.sh', '.bash', '.zsh', '.fish', '.ksh', '.csh', '.command', '.run',
    '.desktop', '.app', '.appimage', '.lnk', '.url',
    '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta',
    '.jar', '.reg', '.dll', '.so', '.dylib',
    '.service', '.workflow', '.terminal',
]);
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
export function executableFileRejection(target, mode) {
    const extension = extname(target).toLowerCase();
    if (EXECUTABLE_EXTENSIONS.has(extension)) {
        return `refusing to open an executable or script file (${extension})`;
    }
    if (!WINDOWS && mode !== undefined && (mode & 0o111) !== 0) {
        return 'refusing to open an executable file (executable permission set)';
    }
    return undefined;
}
/**
 * Ask the platform to reveal a path in its file manager. Uses an argument
 * vector, not a shell, so a path can never be interpreted as a command. The
 * child is detached: the opener outlives the plugin call.
 * @param target - canonical path inside the indexed roots.
 */
export async function revealInFileManager(target) {
    const absolute = resolve(target);
    if (process.platform === 'win32')
        return spawnDetached('explorer.exe', [`/select,${absolute}`]);
    if (process.platform === 'darwin')
        return spawnDetached('open', ['-R', absolute]);
    return spawnDetached('xdg-open', [dirname(absolute)]);
}
/**
 * Open a path with its default application.
 * @param target - canonical path inside the indexed roots; callers must have
 * rejected {@link executableFileRejection} first.
 */
export async function openWithDefaultApp(target) {
    const absolute = resolve(target);
    if (process.platform === 'win32')
        return spawnDetached('explorer.exe', [absolute]);
    if (process.platform === 'darwin')
        return spawnDetached('open', [absolute]);
    return spawnDetached('xdg-open', [absolute]);
}
/** Editors that accept a `file:line` goto argument. */
const GOTO_EDITORS = new Set(['code', 'code-insiders', 'codium', 'cursor', 'windsurf', 'subl', 'sublime_text']);
/** Bare executable name of an editor path (lowercased, no .exe/.cmd/.bat). */
function editorBase(command) {
    const normalized = command.replace(/\\/g, '/');
    const name = normalized.slice(normalized.lastIndexOf('/') + 1);
    return name.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}
/**
 * Arguments that make one editor open `target` at `line`. VS Code-family
 * editors take `--goto path:line`; Sublime takes the combined argument; any
 * other command opens the file only, so the caller can report that the line
 * jump was not honored.
 * @param editor - executable name or absolute path.
 * @param target - absolute file path.
 * @param line - 1-based line number.
 * @returns argv tail for the editor process.
 */
export function editorLaunchArgs(editor, target, line) {
    const base = editorBase(editor);
    if (base === 'subl' || base === 'sublime_text')
        return [`${target}:${line}`];
    if (GOTO_EDITORS.has(base))
        return ['--goto', `${target}:${line}`];
    return [target];
}
/**
 * Validate the optional line number of an `/open` request.
 * @param value - raw body value.
 * @returns the line, or null when it is absent/invalid.
 */
export function parseLineNumber(value) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000_000)
        return null;
    return value;
}
/**
 * Open a file, jumping to `line` when a known editor is available. Falls back
 * to the platform opener (file only) when no goto-capable editor is installed.
 * @param target - already authorized absolute path.
 * @param line - 1-based line number.
 * @returns `line` when the editor jump was requested, `file` for a plain open.
 */
export async function openAtLine(target, line) {
    const absolute = resolve(target);
    const configured = process.env.DSH_LOCATOR_EDITOR?.trim();
    const candidates = configured !== undefined && configured !== '' ? [configured] : ['code', 'cursor', 'codium', 'windsurf', 'subl'];
    for (const candidate of candidates) {
        if (!GOTO_EDITORS.has(editorBase(candidate)))
            continue;
        try {
            await spawnDetached(candidate, editorLaunchArgs(candidate, absolute, line));
            return 'line';
        }
        catch { /* try the next editor, then the platform opener */ }
    }
    await openWithDefaultApp(absolute);
    return 'file';
}
async function spawnDetached(command, args) {
    await new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolvePromise();
        });
    });
}
//# sourceMappingURL=reveal.js.map