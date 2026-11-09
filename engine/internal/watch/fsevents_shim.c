//go:build darwin && cgo

// C shim for the FSEvents watcher. The Go callback is declared here and
// implemented by cgo in watch_fsevents_darwin.go.

#include <CoreServices/CoreServices.h>
#include <dispatch/dispatch.h>
#include <stdint.h>
#include <stdlib.h>

extern void dshLocatorFSEventCallback(FSEventStreamRef stream, void *info,
                                      size_t numEvents, char **paths,
                                      FSEventStreamEventFlags *flags,
                                      FSEventStreamEventId *ids);

void *dsh_locator_info_new(uint64_t id) {
  uint64_t *value = (uint64_t *)malloc(sizeof(uint64_t));
  if (value != NULL) {
    *value = id;
  }
  return value;
}

void dsh_locator_info_free(void *info) {
  free(info);
}

// Pass a real C function pointer to FSEventStreamCreate instead of casting the
// cgo-exported symbol in place; the bridge also adapts the const-qualified
// CoreServices signature.
static void dsh_locator_callback_bridge(ConstFSEventStreamRef stream,
                                        void *info,
                                        size_t numEvents,
                                        void *eventPaths,
                                        const FSEventStreamEventFlags eventFlags[],
                                        const FSEventStreamEventId eventIds[]) {
  dshLocatorFSEventCallback((FSEventStreamRef)stream, info, numEvents,
                            (char **)eventPaths,
                            (FSEventStreamEventFlags *)eventFlags,
                            (FSEventStreamEventId *)eventIds);
}

CFArrayRef dsh_locator_paths_new(void) {
  return CFArrayCreateMutable(kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);
}

void dsh_locator_paths_add(CFArrayRef array, const char *path) {
  CFStringRef string = CFStringCreateWithCString(kCFAllocatorDefault, path, kCFStringEncodingUTF8);
  if (string != NULL) {
    CFArrayAppendValue((CFMutableArrayRef)array, string);
    CFRelease(string);
  }
}

void dsh_locator_paths_free(CFArrayRef array) {
  CFRelease(array);
}

FSEventStreamRef dsh_locator_stream_create(CFArrayRef paths, void *info, double latency) {
  return FSEventStreamCreate(kCFAllocatorDefault,
                             dsh_locator_callback_bridge,
                             info, paths, kFSEventStreamEventIdSinceNow, latency,
                             kFSEventStreamCreateFlagFileEvents |
                                 kFSEventStreamCreateFlagNoDefer |
                                 kFSEventStreamCreateFlagWatchRoot);
}

void dsh_locator_stream_start(FSEventStreamRef stream) {
  FSEventStreamSetDispatchQueue(stream, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0));
  FSEventStreamStart(stream);
}

int dsh_locator_stream_valid(FSEventStreamRef stream) {
  return stream != NULL;
}

void dsh_locator_stream_stop(FSEventStreamRef stream) {
  FSEventStreamStop(stream);
  FSEventStreamInvalidate(stream);
  FSEventStreamRelease(stream);
}
