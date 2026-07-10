<div align="center">
<br>

![TinyFS](../../.github/tinyfs_light.svg#gh-light-mode-only)
![TinyFS](../../.github/tinyfs_dark.svg#gh-dark-mode-only)

*一個基於 IndexedDB 建構的瀏覽器內檔案系統。*

[English](../../README.md) | [简体中文](./zh-CN.md) | **繁體中文** | [日本語](./ja-JP.md) | [한국어](./ko-KR.md) | [Español](./es-ES.md) | [Русский](./ru-RU.md)

</div>

**摘要**

TinyFS 的每個修改狀態的系統呼叫都在單一 IndexedDB 交易中執行。如果瀏覽器崩潰、超出配額限制或在操作中途關閉分頁，交易會原子性地回滾：要麼所有區塊寫入和元資料更新一起提交，要麼全部不提交。不會出現 torn write、懸空 inode 或檔案大小與區塊不匹配的情況。

**主要特性**

- 支援 `stat`、`mkdir`、`rmdir`、`readdir`、`open`、`close`、`read`、`write`、`rename`、`lseek`、`link`、`unlink`。
- 零執行時依賴。
- 少量僅用於測試的開發依賴。
- 90% 以上的測試覆蓋率。
- 包含基礎模糊測試器（fuzzer）。
- 包含瀏覽器內原子性和並發測試。
- 使用 Puppeteer 在 Chrome 中進行基準測試。
- 提供 CommonJS、ESM 和 UMD 格式的分發套件。
- 相容於純 JavaScript 和 TypeScript 專案。

## 快速入門

### 安裝

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

### UMD（瀏覽器）

```html
<script src="https://unpkg.com/@bielok/tinyfs/dist/tinyfs.umd.js"></script>
<script>
    const { TinyFS } = window.tinyfs;
    const tfs = await TinyFS.create("tinyfs");
</script>
```

## 如何使用

所有路徑皆為絕對路徑——必須以 `/` 開頭。根目錄是 `/`。

### 範例

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

開啟或建立一個 IndexedDB 資料庫並初始化根目錄。在任何其他操作之前必須先呼叫此方法。使用相同名稱重複呼叫會複用已有的資料庫——資料在頁面載入之間持續存在。

接受可選設定：

| 選項 | 類型 | 預設值 | 說明 |
|---|---|---|---|
| `block_size` | `uint` | `4096` | 每個資料區塊的大小（位元組）。 |
| `max_fd` | `int` | `256` | 同時開啟的檔案描述子最大數量。 |

```ts
// 為應用程式建立一個全新的資料庫。
const tfs = await TinyFS.create("my-app-data");

// 兩個實例可以使用獨立的資料庫：
const cfg  = await TinyFS.create("config");
const data = await TinyFS.create("user-data");

// Override defaults for a specific workload.
const big   = await TinyFS.create("big-fs",   { block_size: 65536 });
const small = await TinyFS.create("small-fs", { max_fd:     16    });
```

`shutdown()`

關閉 IndexedDB 連線。在刪除資料庫之前必須呼叫此方法，否則 `deleteDatabase` 將一直等待連線關閉。

```ts
// 關閉連線以便清理。
tfs.shutdown();

// 現在可以安全刪除資料庫。
await new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase("my-app-data");
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
});
```

`stat(path, buf)`

用指定路徑的 `{ size, mode, nlink }` 填充 `buf`。成功返回 0，路徑不存在或上層不是目錄時返回 -1。

```ts
const sb = { size: 0, mode: 0, nlink: 0 };

if (await tfs.stat("/foo", sb) === 0) {
    const is_dir  = (sb.mode & O.TYPE_MASK) === O.TYPE_DIR;
    const is_file = (sb.mode & O.TYPE_MASK) === O.TYPE_FILE;

    console.log(sb.size, "bytes", is_dir ? "dir" : "file", sb.nlink, "links");
}
```

`open(path, flags)`

開啟或建立一個檔案並返回檔案描述子。`flags` 參數是一個位元遮罩——使用 `|` 組合常數：

| 旗標 | 作用 |
|---|---|
| `READ` | 以讀取方式開啟 |
| `WRITE` | 以寫入方式開啟 |
| `READ_WRITE` | 以讀寫方式開啟 |
| `CREATE` | 檔案不存在時建立 |
| `EXCLUSIVE` | 如果設定了 `CREATE` 且檔案已存在則失敗 |
| `TRUNCATE` | 開啟時將檔案大小歸零 |
| `APPEND` | 所有寫入附加到檔案末尾 |

> **何時使用 TRUNCATE：** 當你需要原子性地清除檔案所有現有內容時傳入 `TRUNCATE`。如果只需要讀取檔案或附加資料則省略 `TRUNCATE`。沒有 `TRUNCATE` 時開啟操作使用較輕量的事務（可能為唯讀，且不包含 blocks 儲存），減少與並發寫入者的序列化衝突。

```ts
// 原子性地覆寫一個既有檔案（清除舊內容）。
const fd = await tfs.open("/output.bin", O.TRUNCATE | O.WRITE);

// 以唯讀方式開啟既有檔案（不存在時返回 -1）。
const fd = await tfs.open("/config.json", O.READ);

// 原子性建立——如果已存在則失敗。
const fd = await tfs.open("/lock", O.CREATE | O.EXCLUSIVE | O.READ_WRITE);
if (fd < 0) { /* 另一個實例已存在 */ }
```

`close(fd)`

釋放檔案描述子供複用。成功返回 0，fd 超出範圍或已關閉時返回 -1。

```ts
if (tfs.close(fd) === -1)
    console.error("重複關閉或無效的 fd");
```

`max_fd`

同時開啟的檔案描述子最大數量。達到此限制時 `open()` 返回 -1。可透過 `TinyFS.create()` 的 `max_fd` 選項設定。

`block_size`

每個資料區塊的大小（位元組）。所有檔案 I/O 按此大小分塊。可透過 `TinyFS.create()` 的 `block_size` 選項設定。

`read(fd, buffer, length)`

從目前檔案偏移量讀取最多 `length` 位元組到 `buffer` 中。偏移量按實際讀取的位元組數向前移動。返回讀取的位元組數、EOF 時返回 0，出錯時返回 -1。

```ts
const buf = new Uint8Array(1024);
const n   = await tfs.read(fd, buf, 1024);

if (n > 0) {
    const text = new TextDecoder().decode(buf.subarray(0, n));
    console.log("讀取了", n, "個位元組:", text);
} else if (n === 0) {
    console.log("到達檔案結尾");
}
```

`write(fd, buffer, length)`

從目前檔案偏移量寫入 `buffer` 中的 `length` 個位元組。如果 fd 設定了 `APPEND`，偏移量會先移動到末尾。返回實際寫入的位元組數，出錯時返回 -1。

```ts
const data = new TextEncoder().encode("hello\n");
const n    = await tfs.write(fd, data, data.length);

if (n !== data.length)
    console.error("寫入不足——可能空間不足");
```

`lseek(fd, offset, whence)`

重新定位檔案偏移量。`whence` 可以是 `SET`（從開頭絕對定位）、`CURRENT`（相對於目前位置）或 `END`（相對於檔案末尾）。返回新的偏移量，出錯時返回 -1。

```ts
// 回到開頭。
await tfs.lseek(fd, 0, O.SET);

// 向前跳過 100 位元組（例如讀取標頭資訊）。
await tfs.lseek(fd, 100, O.CURRENT);

// 附加模式——將偏移量移到檔案末尾之後。下一次寫入會延伸檔案，
// 在舊大小和新偏移量之間產生稀疏區域。
const size = await tfs.lseek(fd, 10, O.END);

// 嘗試定位到起始位置之前會限制為 0。
```

`mkdir(path)`

建立一個目錄。父目錄必須已經存在。成功返回 0，路徑已存在或無法解析父目錄時返回 -1。

```ts
// 單層目錄。
if (await tfs.mkdir("/data") === -1)
    console.error("mkdir 失敗——根目錄 / 是否存在？");

// 深層巢狀目錄必須逐層建立。
await tfs.mkdir("/a");
await tfs.mkdir("/a/b");
await tfs.mkdir("/a/b/c");
```

`rmdir(path)`

刪除一個空目錄。成功返回 0，目錄非空、不是目錄或不存在時返回 -1。

```ts
// 只能刪除空目錄。
if (await tfs.rmdir("/data") === -1) {
    // 可能有子條目——列出它們。
    const entries = await tfs.readdir("/data");
    console.log("仍有", entries.length, "個條目");
}
```

`readdir(path)`

返回目錄中每個條目的 `{ id, name }` 物件陣列，如果路徑不存在或不是目錄則返回 -1。

```ts
const entries = await tfs.readdir("/");

if (Array.isArray(entries)) {
    for (const entry of entries)
        console.log(entry.name, "(inode", entry.id + ")");
}
```

`unlink(path)`

從檔案系統中刪除一個名稱（硬連結）。當最後一個連結被移除時，inode 及其所有資料區塊將被刪除。成功返回 0，出錯返回 -1。目錄必須使用 `rmdir` 刪除。

```ts
// 刪除一個檔案。如果它是唯一的連結，資料將被釋放。
if (await tfs.unlink("/tempfile") === 0)
    console.log("檔案已刪除");
```

`link(oldpath, newpath)`

建立一個指向與 `oldpath` 相同 inode 的硬連結。呼叫後兩個名稱可以互換使用——inode 會一直存在，直到兩個連結都被刪除。成功返回 0，出錯返回 -1。不能為目錄建立硬連結。

```ts
// 兩個名稱，同一個 inode。
await tfs.link("/original", "/backup");

const sb1 = { size: 0, mode: 0, nlink: 0 };
const sb2 = { size: 0, mode: 0, nlink: 0 };

await tfs.stat("/original", sb1);
await tfs.stat("/backup",  sb2);

console.log(sb1.nlink); // 2 — 兩個名稱共享同一個 inode
console.log(sb1.size === sb2.size); // true

// 刪除一個名稱不會釋放資料。
await tfs.unlink("/original");
// /backup 仍然可讀。
```

`rename(oldpath, newpath)`

將檔案從 `oldpath` 移動到 `newpath`。如果 `newpath` 已存在，會被原子性地覆蓋。不能重新命名目錄。成功返回 0，出錯返回 -1。

```ts
// 簡單重新命名。
await tfs.rename("/tmp_download", "/final.txt");

// 原子性替換——如果目標存在則覆蓋。
await tfs.rename("/new_config", "/config");
```

`export()`

將整個檔案系統序列化為 `ArrayBuffer`，用於備份或傳輸。在檔案系統使用中呼叫是安全的——export 開啟唯讀的 IndexedDB 交易，不會阻塞並發寫入。

```ts
const blob : ArrayBuffer = await tfs.export();
```

`import(db_name, data, opts?)`

從之前匯出的 `ArrayBuffer` 建立一個 TinyFS 檔案系統。資料庫中任何現有資料都會被取代。

```ts
const blob = await tfs.export();

// … 之後或在另一個應用程式中：
const restored = await TinyFS.import("my-db", blob);
```

## 建置與執行測試

```bash
bun run build # 建置所有發行版本。
bun test      # 執行單元測試和並發測試。
bun run fuzz  # 執行隨機操作模糊測試。
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

## 授權條款

The author disclaims copyright to this source code.

This software is released into the public domain and is provided 'as-is', without warranty of any kind, express or implied.
