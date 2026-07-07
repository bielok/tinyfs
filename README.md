![TinyFS](.github/tinyfs_light.svg#gh-light-mode-only)
![TinyFS](.github/tinyfs_dark.svg#gh-dark-mode-only)

![npm downloads](https://img.shields.io/npm/d18m/@bielok/tinyfs.svg?label=npm%20downloads&color=green)
![Made in Buenos Aires](.github/madein.svg)

*An in-browser filesystem built on IndexedDB.*

> Hey there! This is a bit of an experimental idea, let me know if you find it useful.

English | [简体中文](./docs/readme/zh-CN.md) | [繁體中文](./docs/readme/zh-TW.md) | [日本語](./docs/readme/ja-JP.md) | [한국어](./docs/readme/ko-KR.md) | [Español](./docs/readme/es-ES.md) | [Русский](./docs/readme/ru-RU.md)

**Summary**

Every tinyfs syscall that modifies state executes within a single IndexedDB
transaction. If the browser crashes, runs out of quota, or the tab is closed
mid-operation, the transaction atomically rolls back: either all block writes
and the metadata update commit together, or none of them do. There is no path
to a torn write, a dangling inode, or a file whose size doesn't match its
blocks.

**Notable Features**

- Supports `stat`, `mkdir` `rmdir`, `readdir`, `open`, `close`, `read`, `write`, `rename`, `lseek`, `link`, `unlink`.
- Zero runtime dependencies.
- Few testing-related development dependencies.
- 90%+ test coverage.
- Includes a basic fuzzer.
- Includes in-browser atomicity and concurrency tests.
- Benchmarked in Chrome using Puppeteer.
- CommonJS, ESM and UMD distributables.
- Compatible with both pure JavaScript and TypeScript projects.

## Installation

```bash
$ npm install @bielok/tinyfs
```

## Usage

### ESM

```ts
import { TinyFS } from "@bielok/tinyfs";

const tfs = await TinyFS.create("my-database");
```

### CommonJS

```js
const { TinyFS } = require("@bielok/tinyfs");

async function main() {
    const tfs = await TinyFS.create("my-database");
}
```

### UMD (browser)

```html
<script src="https://unpkg.com/@bielok/tinyfs/dist/tinyfs.umd.js"></script>
<script>
    const { TinyFS } = window.tinyfs;
    const tfs = await TinyFS.create("tinyfs");
</script>
```

## How to use

All paths are absolute: they must start with `/`. The root directory is `/`.

### Example

```ts
import { TinyFS } from "@bielok/tinyfs";

const tfs = await TinyFS.create("my-database");

const fd = await tfs.open("/foo", tfs.CREATE | tfs.READ_WRITE);
await tfs.write(fd, new Uint8Array([104, 101, 108, 108, 111]), 5);
await tfs.lseek(fd, 0, tfs.SET);

const buf = new Uint8Array(5);
await tfs.read(fd, buf, 5);
// buf -> [104, 101, 108, 108, 111]

tfs.close(fd);
tfs.shutdown();
```

### API Reference

`TinyFS.create(db_name, opts?)`

Opens or creates an IndexedDB database and initialises the root directory.
Must be called once before any other operation. Each call with the same
name reuses the existing database; data persists across page loads.

Accepts optional settings:

| Option | Type | Default | Description |
|---|---|---|---|
| `block_size` | `uint` | `4096` | Size in bytes of each data block. |
| `max_fd` | `int` | `256` | Maximum number of simultaneously open file descriptors. |

```ts
// Create a fresh database for this application.
const tfs = await TinyFS.create("my-app-data");

// Two instances can use independent databases:
const cfg  = await TinyFS.create("config");
const data = await TinyFS.create("user-data");

// Override defaults for a specific workload:
const big   = await TinyFS.create("big-fs",   { block_size: 65536 });
const small = await TinyFS.create("small-fs", { max_fd:     16    });
```

`shutdown()`

Closes the IndexedDB connection. Required before deleting the database,
otherwise `deleteDatabase` will hang waiting for the connection to close.

```ts
// Close the connection so we can clean up.
tfs.shutdown();

// Now the database can be safely deleted.
await new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase("my-app-data");
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
});
```

`stat(path, buf)`

Fills `buf` with `{ size, mode, nlink }` for the given path. Returns 0
on success, -1 if the path does not exist or an ancestor is not a
directory.

```ts
const sb = { size: 0, mode: 0, nlink: 0 };

if (await tfs.stat("/foo", sb) === 0) {
    const is_dir  = (sb.mode & tfs.TYPE_MASK) === tfs.TYPE_DIR;
    const is_file = (sb.mode & tfs.TYPE_MASK) === tfs.TYPE_FILE;

    console.log(sb.size, "bytes", is_dir ? "dir" : "file", sb.nlink, "links");
}
```

`open(path, flags)`

Opens or creates a file and returns a file descriptor. The `flags`
argument is a bitmask; combine constants with `|`:

| Flag | Effect |
|---|---|
| `READ` | Open for reading |
| `WRITE` | Open for writing |
| `READ_WRITE` | Open for both |
| `CREATE` | Create the file if it does not exist |
| `EXCLUSIVE` | Fail if `CREATE` is set and the file exists |
| `TRUNCATE` | Set the file size to 0 on open |
| `APPEND` | All writes go to the end of the file |

> **When to use TRUNCATE:** Pass `TRUNCATE` when you want to clear all
> existing file content atomically on open.  Omit it when you only need
> to read the file or append new data.  Without `TRUNCATE` the open
> uses a lighter transaction (readonly when possible, and the blocks
> store is excluded), reducing serialization with concurrent writers.

```ts
// Overwrite an existing file atomically (clears old content).
const fd = await tfs.open("/output.bin", tfs.TRUNCATE | tfs.WRITE);

// Open an existing file for reading (fails with -1 if missing).
const fd = await tfs.open("/config.json", tfs.READ);

// Atomically create (fails if already exists).
const fd = await tfs.open("/lock", tfs.CREATE | tfs.EXCLUSIVE | tfs.READ_WRITE);
if (fd < 0) { /* another instance already exists */ }
```

`close(fd)`

Releases a file descriptor so its slot can be reused. Returns 0 on
success, -1 if the fd is out of range or already closed.

```ts
if (tfs.close(fd) === -1)
    console.error("double-close or invalid fd");
```

`max_fd`

The maximum number of simultaneously open file descriptors. `open()` returns -1
when this limit is reached. Set via the `max_fd` option in `TinyFS.create()`.

`block_size`

The size in bytes of each data block. All file I/O is divided into chunks of
this size. Set via the `block_size` option in `TinyFS.create()`.

`read(fd, buffer, length)`

Reads up to `length` bytes from the current file offset into `buffer`.
Advances the offset by the number of bytes read. Returns the number
of bytes read, 0 at EOF, or -1 on error.

```ts
const buf = new Uint8Array(1024);
const n   = await tfs.read(fd, buf, 1024);

if (n > 0) {
    const text = new TextDecoder().decode(buf.subarray(0, n));
    console.log("read", n, "bytes:", text);
} else if (n === 0) {
    console.log("end of file");
}
```

`write(fd, buffer, length)`

Writes `length` bytes from `buffer` at the current file offset.
If `APPEND` was set on the fd, the offset is first moved to the end.
Returns the number of bytes written, or -1 on error.

```ts
const data = new TextEncoder().encode("hello\n");
const n    = await tfs.write(fd, data, data.length);

if (n !== data.length)
    console.error("short write (likely out of space)");
```

`lseek(fd, offset, whence)`

Repositions the file offset. `whence` is one of `SET` (absolute from
start), `CURRENT` (relative to current position), or `END` (relative
to end of file). Returns the new offset, or -1 on error.

```ts
// Rewind to the beginning.
await tfs.lseek(fd, 0, tfs.SET);

// Skip ahead 100 bytes (e.g., to read a header).
await tfs.lseek(fd, 100, tfs.CURRENT);

// Append: seek past the end to the last byte. The next write extends
// the file, producing a sparse region between the old size and offset.
const size = await tfs.lseek(fd, 10, tfs.END);

// Attempting to seek before the start clamps to 0.
```

`mkdir(path)`

Creates a directory. The parent directory must already exist. Returns
0 on success, -1 if the path already exists or the parent cannot be
resolved.

```ts
// Single directory.
if (await tfs.mkdir("/data") === -1)
    console.error("mkdir failed (does / exist?)");

// Deeply nested directories must be created one level at a time.
await tfs.mkdir("/a");
await tfs.mkdir("/a/b");
await tfs.mkdir("/a/b/c");
```

`rmdir(path)`

Removes an empty directory. Returns 0 on success, -1 if the directory
is not empty, is not a directory, or does not exist.

```ts
// Only empty directories can be removed.
if (await tfs.rmdir("/data") === -1) {
    // Maybe it has children. List them.
    const entries = await tfs.readdir("/data");
    console.log("still has", entries.length, "entries");
}
```

`readdir(path)`

Returns an array of `{ id, name }` objects for every entry in the
directory, or -1 if the path does not exist or is not a directory.

```ts
const entries = await tfs.readdir("/");

if (Array.isArray(entries)) {
    for (const entry of entries)
        console.log(entry.name, "(inode", entry.id + ")");
}
```

`unlink(path)`

Removes a name (hard link) from the filesystem. When the last link is
removed the inode and all its data blocks are deleted. Returns 0 on
success, -1 on error. Directories must be removed with `rmdir`.

```ts
// Remove a file. If it was the only link, the data is freed.
if (await tfs.unlink("/tempfile") === 0)
    console.log("file removed");
```

`link(oldpath, newpath)`

Creates a hard link pointing to the same inode as `oldpath`. Both
names are interchangeable after this call; the inode persists until
both are unlinked. Returns 0 on success, -1 on error. Directories
cannot be linked.

```ts
// Two names, one inode.
await tfs.link("/original", "/backup");

const sb1 = { size: 0, mode: 0, nlink: 0 };
const sb2 = { size: 0, mode: 0, nlink: 0 };

await tfs.stat("/original", sb1);
await tfs.stat("/backup",  sb2);

console.log(sb1.nlink); // 2 (both names share the inode)
console.log(sb1.size === sb2.size); // true

// Removing one name does not free the data.
await tfs.unlink("/original");
// /backup still readable.
```

`rename(oldpath, newpath)`

Moves a file from `oldpath` to `newpath`. If `newpath` already exists
it is atomically replaced. Directories cannot be renamed. Returns 0
on success, -1 on error.

```ts
// Simple rename.
await tfs.rename("/tmp_download", "/final.txt");

// Atomic replace (overwrites target if it exists).
await tfs.rename("/new_config", "/config");
```

## Building & Running tests

```bash
$ bun run build # Builds all distributables.
$ bun test      # Run unit and concurrency tests.
$ bun run fuzz  # Run the random-op fuzzer.
```

## Benchmarks

Use the `bench` command to un a benchmark on your system using Puppeteer.
You can also open bench.html to benchmark in other browsers.
Otherwise, refer to the baseline below.

```
$ bun run bench

tinyfs bench test

chrome:      /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
cpu:         Apple M1 (8 cores)
time:        2026-07-06T20:25:10.363Z
runtime:     Chrome/149.0.7827.201
database:    IndexedDB


Single-operation latency:
op                   mean/us    min/us    p50/us    p95/us    p99/us    max/us    ops/sec
-----------------------------------------------------------------------------------------
stat("/")               55.2       0.0     100.0     100.0     200.0     400.0      18116
stat(file)             101.2       0.0     100.0     200.0     200.0     500.0       9881
open+close             101.8       0.0     100.0     200.0     200.0     400.0       9823
write 100B             324.6     100.0     300.0     400.0     700.0     900.0       3081
read 100B              207.6     100.0     200.0     300.0     300.0    1000.0       4817
mkdir+rmdir            610.6     400.0     600.0     700.0     700.0   19100.0       1638
create+unlink          948.2     600.0     900.0    1000.0    1700.0   25900.0       1055
readdir("/")            59.2       0.0     100.0     100.0     200.0     200.0      16892
link+unlink            684.6     500.0     600.0     700.0     800.0   24200.0       1461
seek                   160.6       0.0     200.0     200.0     300.0    1700.0       6227
rename                1022.6     800.0    1000.0    1100.0    1200.0    2500.0        978

Throughput by file size:
size     op           n   mean/us    p95/us     MB/s    ops/sec
---------------------------------------------------------------
100B     write     1000     956.6    1000.0     0.10       1045
100B     read      1000     212.1     300.0     0.47       4715
1KB      write     1000     910.2    1000.0     1.10       1099
1KB      read      1000     230.0     300.0     4.35       4348
10KB     write      500    1037.0    1200.0     9.64        964
10KB     read       500     283.0     400.0    35.34       3534
100KB    write      200    2829.0    4100.0    35.35        353
100KB    read       200    1224.0    1300.0    81.70        817
1.00MB   write       50   19160.0   21900.0    52.19         52
1.00MB   read        50    9980.0   10400.0   100.20        100
10.00MB  write       10  216770.0  340900.0    46.13          5
10.00MB  read        10  109000.0  134100.0    91.74          9

Summary:
latency benchmarks:  5500 operations across 11 benchmarks
throughput benches:  5520 operations, 352.20MB total
fastest operation:   55.20000000298023 us mean  (stat("/"))
```

## License

The author disclaims copyright to this source code.

This software is released into the public domain and is provided 'as-is', without warranty of any kind, express or implied.
