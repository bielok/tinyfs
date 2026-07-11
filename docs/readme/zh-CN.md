<div align="center">
<br>
<h1>bielok's TinyFS</h1>

*一个构建在 IndexedDB 之上的浏览器内文件系统。*

[English](../../README.md) | **简体中文** | [繁體中文](./zh-TW.md) | [日本語](./ja-JP.md) | [한국어](./ko-KR.md) | [Español](./es-ES.md) | [Русский](./ru-RU.md)
</div>

---

<h4>概要</h4>

TinyFS 的每一个修改状态的系统调用都在单个 IndexedDB 事务中执行。如果浏览器崩溃、超出配额限制或在操作中途关闭标签页，事务会原子性地回滚：要么所有块写入和元数据更新一起提交，要么全部不提交。不会出现 torn write、悬空 inode 或文件大小与块不匹配的情况。

<h4>主要特性</h4>

- 支持 `stat`、`mkdir`、`rmdir`、`readdir`、`open`、`close`、`read`、`write`、`rename`、`lseek`、`link`、`unlink`。
- 零运行时依赖。
- 少量仅用于测试的开发依赖。
- 90% 以上的测试覆盖率。
- 包含基础模糊测试（fuzzer）。
- 包含浏览器内原子性和并发测试。
- 使用 Puppeteer 在 Chrome 中进行基准测试。
- 提供 CommonJS、ESM 和 UMD 格式的分发包。
- 兼容纯 JavaScript 和 TypeScript 项目。
- 安装体积 < 500 KiB（[查看具体内容](https://www.npmjs.com/package/@bielok/tinyfs?activeTab=code)）！

## 快速入门

### 安装

```bash
$ npm install @bielok/tinyfs
```

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

### UMD（浏览器）

```html
<script src="https://unpkg.com/@bielok/tinyfs/dist/tinyfs.umd.js"></script>
<script>
    const { TinyFS } = window.tinyfs;
    const tfs = await TinyFS.create("tinyfs");
</script>
```

## 如何使用

所有路径都是绝对路径——必须以 `/` 开头。根目录是 `/`。

### 示例

```ts
import { TinyFS, O } from "@bielok/tinyfs";

const tfs = await TinyFS.create("my-database");

const fd = await tfs.open("/foo", O.CREATE | O.READ_WRITE);
await tfs.write(fd, new Uint8Array([104, 101, 108, 108, 111]), 5);
await tfs.lseek(fd, 0, O.SET);

const buf = new Uint8Array(5);
await tfs.read(fd, buf, 5);
// buf -> [104, 101, 108, 108, 111]

tfs.close(fd);
tfs.shutdown();
```

### API Reference

`TinyFS.create(db_name, opts?)`

打开或创建一个 IndexedDB 数据库并初始化根目录。在任何其他操作之前必须先调用此方法。使用相同名称重复调用会复用已有的数据库——数据在页面加载之间持续存在。

接受可选设置：

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `block_size` | `uint` | `4096` | 每个数据块的大小（字节）。 |
| `max_fd` | `int` | `256` | 同时打开的文件描述符的最大数量。 |

```ts
// 为应用程序创建一个全新的数据库。
const tfs = await TinyFS.create("my-app-data");

// 两个实例可以使用独立的数据库：
const cfg  = await TinyFS.create("config");
const data = await TinyFS.create("user-data");

// Override defaults for a specific workload.
const big   = await TinyFS.create("big-fs",   { block_size: 65536 });
const small = await TinyFS.create("small-fs", { max_fd:     16    });
```

`shutdown()`

关闭 IndexedDB 连接。在删除数据库之前必须调用此方法，否则 `deleteDatabase` 将一直等待连接关闭。

```ts
// 关闭连接以便清理。
tfs.shutdown();

// 现在可以安全删除数据库。
await new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase("my-app-data");
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
});
```

`stat(path, buf)`

用给定路径的 `{ size, mode, nlink }` 填充 `buf`。成功返回 0，路径不存在或祖先不是目录时返回 -1。

```ts
const sb = { size: 0, mode: 0, nlink: 0 };

if (await tfs.stat("/foo", sb) === 0) {
    const is_dir  = (sb.mode & O.TYPE_MASK) === O.TYPE_DIR;
    const is_file = (sb.mode & O.TYPE_MASK) === O.TYPE_FILE;

    console.log(sb.size, "bytes", is_dir ? "dir" : "file", sb.nlink, "links");
}
```

`open(path, flags)`

打开或创建一个文件并返回文件描述符。`flags` 参数是一个位掩码——使用 `|` 组合常量：

| 标志 | 作用 |
|---|---|
| `READ` | 以读取方式打开 |
| `WRITE` | 以写入方式打开 |
| `READ_WRITE` | 以读写方式打开 |
| `CREATE` | 文件不存在时创建 |
| `EXCLUSIVE` | 如果设置了 `CREATE` 且文件已存在则失败 |
| `TRUNCATE` | 打开时将文件大小置零 |
| `APPEND` | 所有写入追加到文件末尾 |

> **何时使用 TRUNCATE：** 当你需要原子性地清除文件所有现有内容时，传入 `TRUNCATE`。如果只需要读取文件或追加数据，则省略 `TRUNCATE`。没有 `TRUNCATE` 时打开操作使用较轻量的事务（可能为只读，且不涉及 blocks 存储），减少与并发写入者的序列化冲突。

```ts
// 原子性地覆写一个已有文件（清除旧内容）。
const fd = await tfs.open("/output.bin", O.TRUNCATE | O.WRITE);

// 以只读方式打开已有文件（不存在时返回 -1）。
const fd = await tfs.open("/config.json", O.READ);

// 原子性创建——如果已存在则失败。
const fd = await tfs.open("/lock", O.CREATE | O.EXCLUSIVE | O.READ_WRITE);
if (fd < 0) { /* 另一个实例已存在 */ }
```

`close(fd)`

释放文件描述符以供复用。成功返回 0，fd 超出范围或已关闭时返回 -1。

```ts
if (tfs.close(fd) === -1)
    console.error("重复关闭或无效的 fd");
```

`max_fd`

同时打开的文件描述符的最大数量。达到此限制时 `open()` 返回 -1。可通过 `TinyFS.create()` 的 `max_fd` 选项设置。

`block_size`

每个数据块的大小（字节）。所有文件 I/O 按此大小分块。可通过 `TinyFS.create()` 的 `block_size` 选项设置。

`read(fd, buffer, length)`

从当前文件偏移量读取最多 `length` 字节到 `buffer` 中。偏移量按实际读取的字节数向前移动。返回读取的字节数、EOF 时返回 0，出错时返回 -1。

```ts
const buf = new Uint8Array(1024);
const n   = await tfs.read(fd, buf, 1024);

if (n > 0) {
    const text = new TextDecoder().decode(buf.subarray(0, n));
    console.log("读取了", n, "个字节:", text);
} else if (n === 0) {
    console.log("到达文件末尾");
}
```

`write(fd, buffer, length)`

从当前文件偏移量写入 `buffer` 中的 `length` 个字节。如果 fd 设置了 `APPEND`，偏移量会先移动到末尾。返回实际写入的字节数，出错时返回 -1。

```ts
const data = new TextEncoder().encode("hello\n");
const n    = await tfs.write(fd, data, data.length);

if (n !== data.length)
    console.error("写入不足——可能空间不足");
```

`lseek(fd, offset, whence)`

重新定位文件偏移量。`whence` 可以是 `SET`（从开头绝对定位）、`CURRENT`（相对于当前位置）或 `END`（相对于文件末尾）。返回新的偏移量，出错时返回 -1。

```ts
// 回到开头。
await tfs.lseek(fd, 0, O.SET);

// 向前跳过 100 字节（例如读取头部信息）。
await tfs.lseek(fd, 100, O.CURRENT);

// 追加场景下——将偏移量移到文件末尾之后。下一次写入会扩展文件，
// 在旧大小和新偏移量之间产生稀疏区域。
const size = await tfs.lseek(fd, 10, O.END);

// 尝试定位到起始位置之前会限制为 0。
```

`mkdir(path)`

创建一个目录。父目录必须已经存在。成功返回 0，路径已存在或无法解析父目录时返回 -1。

```ts
// 单层目录。
if (await tfs.mkdir("/data") === -1)
    console.error("mkdir 失败——根目录 / 是否存在？");

// 深层嵌套目录必须逐层创建。
await tfs.mkdir("/a");
await tfs.mkdir("/a/b");
await tfs.mkdir("/a/b/c");
```

`rmdir(path)`

删除一个空目录。成功返回 0，目录非空、不是目录或不存在时返回 -1。

```ts
// 只能删除空目录。
if (await tfs.rmdir("/data") === -1) {
    // 可能有子条目——列出它们。
    const entries = await tfs.readdir("/data");
    console.log("仍有", entries.length, "个条目");
}
```

`readdir(path)`

返回目录中每个条目的 `{ id, name }` 对象数组，如果路径不存在或不是目录则返回 -1。

```ts
const entries = await tfs.readdir("/");

if (Array.isArray(entries)) {
    for (const entry of entries)
        console.log(entry.name, "(inode", entry.id + ")");
}
```

`unlink(path)`

从文件系统中删除一个名称（硬链接）。当最后一个链接被移除时，inode 及其所有数据块将被删除。成功返回 0，出错返回 -1。目录必须使用 `rmdir` 删除。

```ts
// 删除一个文件。如果它是唯一的链接，数据将被释放。
if (await tfs.unlink("/tempfile") === 0)
    console.log("文件已删除");
```

`link(oldpath, newpath)`

创建一个指向与 `oldpath` 相同 inode 的硬链接。调用后两个名称完全等价——inode 会一直存在，直到两个链接都被删除。成功返回 0，出错返回 -1。不能为目录创建硬链接。

```ts
// 两个名称，同一个 inode。
await tfs.link("/original", "/backup");

const sb1 = { size: 0, mode: 0, nlink: 0 };
const sb2 = { size: 0, mode: 0, nlink: 0 };

await tfs.stat("/original", sb1);
await tfs.stat("/backup",  sb2);

console.log(sb1.nlink); // 2 — 两个名称共享同一个 inode
console.log(sb1.size === sb2.size); // true

// 删除一个名称不会释放数据。
await tfs.unlink("/original");
// /backup 仍然可读。
```

`rename(oldpath, newpath)`

将文件从 `oldpath` 移动到 `newpath`。如果 `newpath` 已存在，会原子性地覆盖它。不能重命名目录。成功返回 0，出错返回 -1。

```ts
// 简单重命名。
await tfs.rename("/tmp_download", "/final.txt");

// 原子性替换——如果目标存在则覆盖。
await tfs.rename("/new_config", "/config");
```

`export()`

将整个文件系统序列化为 `ArrayBuffer`，用于备份或传输。在文件系统使用中调用是安全的——export 打开只读的 IndexedDB 事务，不会阻塞并发写入。

```ts
const blob : ArrayBuffer = await tfs.export();
```

`import(db_name, data, opts?)`

从之前导出的 `ArrayBuffer` 创建一个 TinyFS 文件系统。数据库中任何现有数据都会被替换。

```ts
const blob = await tfs.export();

// … 之后或在另一个应用程序中：
const restored = await TinyFS.import("my-db", blob);
```

## 构建与运行测试

```bash
bun run build # 构建所有分发文件。
bun test      # 运行单元测试和并发测试。
bun run fuzz  # 运行随机操作模糊测试（fuzzer）。
```

## Benchmarks

```
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

**NOTE**: Open bench.html to benchmark on other browsers.

## 许可证

The author disclaims copyright to this source code.

This software is released into the public domain and is provided 'as-is', without warranty of any kind, express or implied.
