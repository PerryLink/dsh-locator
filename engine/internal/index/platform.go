package index

import "runtime"

// caseInsensitiveFS reports whether the current platform compares paths
// without letter case. The index still stores the original spelling.
const caseInsensitiveFS = runtime.GOOS == "windows" || runtime.GOOS == "darwin"

// windowsPaths reports whether the platform accepts both slashes and
// backslashes as path separators (os.IsPathSeparator semantics).
const windowsPaths = runtime.GOOS == "windows"

// isPathSepByte mirrors os.IsPathSeparator without the function call.
func isPathSepByte(c byte) bool {
	if c == '/' {
		return true
	}
	return windowsPaths && c == '\\'
}
