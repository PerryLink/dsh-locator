//go:build darwin && cgo

// FSEvents shim. The stream callback is pure C: it serializes each event into
// a pipe, and Go reads the records from the other end. Keeping Go out of the
// callback path avoids the arm64 callback crash seen with cgo-exported symbols.

#include <CoreServices/CoreServices.h>
#include <dispatch/dispatch.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct {
  int write_fd;
} dsh_locator_context;

typedef struct {
  uint32_t path_len;
  uint32_t flags;
} dsh_locator_header;

static void dsh_locator_pipe_callback(ConstFSEventStreamRef stream, void *info,
                                      size_t numEvents, void *eventPaths,
                                      const FSEventStreamEventFlags eventFlags[],
                                      const FSEventStreamEventId eventIds[]) {
  dsh_locator_context *context = (dsh_locator_context *)info;
  char **paths = (char **)eventPaths;
  for (size_t i = 0; i < numEvents; i++) {
    if (paths[i] == NULL) {
      continue;
    }
    size_t length = strlen(paths[i]);
    if (length > (1u << 20)) {
      continue;
    }
    dsh_locator_header header;
    header.path_len = (uint32_t)length;
    header.flags = (uint32_t)eventFlags[i];
    if (write(context->write_fd, &header, sizeof(header)) != (ssize_t)sizeof(header)) {
      continue;
    }
    (void)write(context->write_fd, paths[i], length);
  }
}

int dsh_locator_create(const char *const *roots, int count, int *read_fd,
                       FSEventStreamRef *stream_out, void **info_out) {
  int fds[2];
  if (pipe(fds) != 0) {
    return -1;
  }
  dsh_locator_context *context = (dsh_locator_context *)malloc(sizeof(dsh_locator_context));
  if (context == NULL) {
    close(fds[0]);
    close(fds[1]);
    return -2;
  }
  context->write_fd = fds[1];

  CFMutableArrayRef paths = CFArrayCreateMutable(kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);
  for (int i = 0; i < count; i++) {
    CFStringRef path = CFStringCreateWithCString(kCFAllocatorDefault, roots[i], kCFStringEncodingUTF8);
    if (path != NULL) {
      CFArrayAppendValue(paths, path);
      CFRelease(path);
    }
  }
  FSEventStreamContext stream_context;
  memset(&stream_context, 0, sizeof(stream_context));
  stream_context.info = context;
  FSEventStreamRef stream = FSEventStreamCreate(
      kCFAllocatorDefault, dsh_locator_pipe_callback, &stream_context, paths,
      kFSEventStreamEventIdSinceNow, 0.2,
      kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer |
          kFSEventStreamCreateFlagWatchRoot);
  CFRelease(paths);
  if (stream == NULL) {
    close(fds[0]);
    close(fds[1]);
    free(context);
    return -3;
  }
  FSEventStreamSetDispatchQueue(stream, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0));
  FSEventStreamStart(stream);
  *read_fd = fds[0];
  *stream_out = stream;
  *info_out = context;
  return 0;
}

void dsh_locator_destroy(FSEventStreamRef stream, void *info) {
  if (stream != NULL) {
    FSEventStreamStop(stream);
    FSEventStreamInvalidate(stream);
    FSEventStreamRelease(stream);
  }
  if (info != NULL) {
    dsh_locator_context *context = (dsh_locator_context *)info;
    close(context->write_fd);
    free(context);
  }
}
