// Command indexd builds, persists, watches and queries the locator file index.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/scan"
	"github.com/PerryLink/dsh-locator/engine/internal/server"
	"github.com/PerryLink/dsh-locator/engine/internal/store"
	"github.com/PerryLink/dsh-locator/engine/internal/usn"
	"github.com/PerryLink/dsh-locator/engine/internal/usnstate"
)

// version is injected by scripts/build-engine.mjs and the CI build.
var version = "0.0.0-dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd := os.Args[1]
	args := os.Args[2:]
	var err error
	switch cmd {
	case "scan":
		err = cmdScan(args)
	case "query":
		err = cmdQuery(args)
	case "status":
		err = cmdStatus(args)
	case "serve":
		err = cmdServe(args)
	case "usn-probe":
		err = cmdUsnProbe(args)
	case "version", "--version", "-v":
		fmt.Printf("indexd %s %s/%s\n", version, runtime.GOOS, runtime.GOARCH)
	case "help", "--help", "-h":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", cmd)
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "indexd:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `indexd — persistent file index for DeepSeek Harness

usage:
  indexd scan    --state DIR --root PATH [--root PATH...] [--exclude GLOB...]
  indexd query   --state DIR [--limit N] [--offset N] [--sort name|path|size|mtime|ext]
                 [--desc] [--json] [--files] [--folders] [--regex] [--case]
                 [--whole-word] QUERY...
  indexd status  --state DIR [--json]
  indexd serve   --state DIR [--root PATH...] [--exclude GLOB...] [--no-watch]
  indexd usn-probe [--volume C:] [--root 'C:\\Users\\me'] [--limit 10]
                   [--enumerate=false] [--json]

The state directory holds index.snapshot and meta.json. serve speaks
line-delimited JSON on stdin/stdout.
`)
}

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

func cmdScan(args []string) error {
	fs := flag.NewFlagSet("scan", flag.ContinueOnError)
	state := fs.String("state", store.DefaultDir(), "state directory")
	var roots, excludes stringList
	fs.Var(&roots, "root", "directory to index (repeatable)")
	fs.Var(&excludes, "exclude", "base-name glob to skip (repeatable)")
	follow := fs.Bool("follow", false, "follow directory symlinks")
	workers := fs.Int("workers", 0, "directory reader concurrency (0 = CPU count)")
	useUSN := fs.Bool("usn", false, "try the NTFS USN/MFT enumeration first (Windows, administrator)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		roots = append(roots, fs.Args()...)
	}
	if len(roots) == 0 {
		return errors.New("scan needs at least one --root")
	}
	ctx, stop := signalContext()
	defer stop()

	ix := index.New()
	st, err := scan.Run(ctx, ix, scan.Options{
		Roots:          roots,
		Excludes:       excludes,
		FollowSymlinks: *follow,
		Workers:        *workers,
		WindowsUSN:     *useUSN,
		Warn: func(err error) {
			fmt.Fprintf(os.Stderr, "usn: %v (falling back to directory walk)\n", err)
		},
		Progress: func(p scan.Progress) {
			if p.Current != "" {
				fmt.Fprintf(os.Stderr, "\r%d entries, %d dirs  %s", p.Entries, p.Dirs, shorten(p.Current, 80))
			}
		},
		ProgressEvery: 200 * time.Millisecond,
		OnUSNState: func(cursor scan.USNState) {
			if err := usnstate.Save(*state, cursor); err != nil {
				fmt.Fprintf(os.Stderr, "usn state: %v\n", err)
			}
		},
	})
	fmt.Fprintln(os.Stderr)
	if st.Entries > 0 {
		m := store.Meta{
			Version:  version,
			Excludes: excludes,
			BuiltAt:  time.Now(),
			Platform: runtime.GOOS + "/" + runtime.GOARCH,
			Stats:    st,
		}
		if err := store.Save(*state, ix, m); err != nil {
			return err
		}
		fmt.Printf("indexed %d entries (%d files, %d dirs) in %s -> %s\n",
			st.Entries, st.Files, st.Dirs, st.Took.Round(time.Millisecond), *state)
		fmt.Printf("  %s\n", strings.Join(ix.Roots(), ", "))
	}
	return err
}

func cmdQuery(args []string) error {
	fs := flag.NewFlagSet("query", flag.ContinueOnError)
	state := fs.String("state", store.DefaultDir(), "state directory")
	limit := fs.Int("limit", 50, "maximum results")
	offset := fs.Int("offset", 0, "result offset")
	sortKey := fs.String("sort", "name", "name|path|size|mtime|ext")
	desc := fs.Bool("desc", false, "descending order")
	asJSON := fs.Bool("json", false, "print JSON")
	files := fs.Bool("files", false, "files only")
	folders := fs.Bool("folders", false, "folders only")
	regex := fs.Bool("regex", false, "treat the query as a regular expression")
	caseSens := fs.Bool("case", false, "case-sensitive match")
	whole := fs.Bool("whole-word", false, "whole-word match")
	if err := fs.Parse(args); err != nil {
		return err
	}
	text := strings.Join(fs.Args(), " ")
	snap, _ := store.Paths(*state)
	ix, err := index.Load(snap)
	if err != nil {
		return fmt.Errorf("load index (run scan first): %w", err)
	}
	var q index.Query
	if *regex {
		q = index.Query{Text: text, Regex: true, MinSize: -1, MaxSize: -1, MinMtime: -1, MaxMtime: -1}
	} else {
		q, err = index.ParseQuery(text)
		if err != nil {
			return err
		}
	}
	q.Limit, q.Offset = *limit, *offset
	q.SetSort(*sortKey, *desc)
	q.FilesOnly, q.DirsOnly = *files, *folders
	q.Case, q.WholeWord = *caseSens, *whole
	res, err := ix.Search(q)
	if err != nil {
		return err
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(res)
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintf(w, "SIZE\tMODIFIED\tPATH\n")
	for _, h := range res.Hits {
		fmt.Fprintf(w, "%s\t%s\t%s\n", humanSize(h.Size), time.UnixMilli(h.Mtime).Format("2006-01-02 15:04"), h.Path)
	}
	w.Flush()
	fmt.Printf("\n%d match(es), showing %d from offset %d, %s\n",
		res.Total, res.Returned, res.Offset, time.Duration(res.TookNanos).Round(time.Microsecond))
	return nil
}

func cmdStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	state := fs.String("state", store.DefaultDir(), "state directory")
	asJSON := fs.Bool("json", false, "print JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	ix, meta, err := store.Load(*state)
	if err != nil {
		return fmt.Errorf("no index in %s (run scan first): %w", *state, err)
	}
	s := ix.Stats()
	snap, _ := store.Paths(*state)
	var bytes int64
	if info, err := os.Stat(snap); err == nil {
		bytes = info.Size()
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(map[string]any{"meta": meta, "stats": s, "bytes": bytes})
	}
	fmt.Printf("entries  %d (%d files, %d dirs)\n", s.Entries, s.Files, s.Dirs)
	fmt.Printf("snapshot %s\n", humanSize(bytes))
	fmt.Printf("built    %s\n", meta.BuiltAt.Format(time.RFC3339))
	fmt.Printf("platform %s\n", meta.Platform)
	fmt.Printf("roots    %s\n", strings.Join(meta.Roots, ", "))
	fmt.Printf("scan     %d entries in %s (%d errors)\n", meta.Stats.Entries, meta.Stats.Took.Round(time.Millisecond), meta.Stats.Errors)
	return nil
}

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	state := fs.String("state", store.DefaultDir(), "state directory")
	var roots, excludes stringList
	fs.Var(&roots, "root", "directory to index (repeatable)")
	fs.Var(&excludes, "exclude", "base-name glob to skip (repeatable)")
	noWatch := fs.Bool("no-watch", false, "disable filesystem watching")
	refresh := fs.Duration("refresh", 30*time.Minute, "rebuild interval when no native watcher exists (0 disables)")
	workers := fs.Int("workers", 0, "directory reader concurrency during scans (0 = CPU count)")
	useUSN := fs.Bool("usn", false, "try the NTFS USN/MFT enumeration first (Windows, administrator)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		roots = append(roots, fs.Args()...)
	}
	if len(roots) == 0 {
		if ix, meta, err := store.Load(*state); err == nil {
			roots = append(roots, meta.Roots...)
			if len(excludes) == 0 {
				excludes = append(excludes, meta.Excludes...)
			}
			_ = ix
		}
	}
	if len(roots) == 0 {
		return errors.New("serve needs --root or an existing snapshot")
	}
	for i, r := range roots {
		if abs, err := filepath.Abs(r); err == nil {
			roots[i] = abs
		}
	}
	ctx, stop := signalContext()
	defer stop()
	srv := server.New(server.Options{
		StateDir: *state,
		Roots:    roots,
		Excludes: excludes,
		Watch:           !*noWatch,
		RefreshInterval: *refresh,
		ScanWorkers:     *workers,
		USN:             *useUSN,
		Version:         version,
	})
	return srv.Run(ctx, os.Stdin, os.Stdout)
}

func cmdUsnProbe(args []string) error {
	fs := flag.NewFlagSet("usn-probe", flag.ContinueOnError)
	volume := fs.String("volume", "C:", "NTFS volume, for example C: or D:")
	root := fs.String("root", "", "restrict counts/samples to this directory (default: volume root)")
	limit := fs.Int("limit", 10, "sample paths to print")
	enumerate := fs.Bool("enumerate", true, "enumerate the MFT to measure throughput")
	journalSamples := fs.Int("journal", 0, "print this many recent USN journal records")
	asJSON := fs.Bool("json", false, "print JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	result, err := usn.Probe(usn.ProbeOptions{Volume: *volume, Root: *root, Limit: *limit, Enumerate: *enumerate, JournalSamples: *journalSamples})
	if err != nil {
		return err
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(result)
	}
	fmt.Printf("volume      %s\n", result.Volume)
	fmt.Printf("journal id  %x\n", result.Journal.ID)
	fmt.Printf("journal usn first=%d next=%d lowest-valid=%d\n", result.Journal.FirstUSN, result.Journal.NextUSN, result.Journal.LowestValidUSN)
	if *journalSamples > 0 {
		fmt.Printf("journal     %d record(s) read\n", result.JournalRead)
		for _, sample := range result.JournalList {
			fmt.Printf("  %s\n", sample)
		}
	}
	if *enumerate {
		fmt.Printf("enumerated  %d records in %d ms (%d/s)%s\n", result.Records, result.ElapsedMS, result.RecordsPerS, map[bool]string{true: " [truncated]"}[result.Truncated])
		fmt.Printf("tree        %d nodes, %d paths resolved, %d unresolved\n", result.TreeNodes, result.Resolved, result.Unresolved)
		for _, sample := range result.AnySamples {
			fmt.Printf("  any: %s\n", sample)
		}
		fmt.Printf("under root  %d entries (%d files, %d dirs) below %s\n", result.UnderRoot, result.Files, result.Dirs, result.Root)
		for _, sample := range result.Samples {
			fmt.Printf("  %s\n", sample)
		}
	}
	return nil
}

func signalContext() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-ch
		cancel()
	}()
	return ctx, cancel
}

func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}

func shorten(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
