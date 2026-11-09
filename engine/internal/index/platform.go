package index

import "runtime"

// caseInsensitiveFS reports whether the current platform compares paths
// without letter case. The index still stores the original spelling.
const caseInsensitiveFS = runtime.GOOS == "windows" || runtime.GOOS == "darwin"
