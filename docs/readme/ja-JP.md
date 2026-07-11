<div align="center">
<br>
<h1>bielok's TinyFS</h1>

*IndexedDB 上に構築されたブラウザ内ファイルシステム。*

[English](../../README.md) | [简体中文](./zh-CN.md) | [繁體中文](./zh-TW.md) | **日本語** | [한국어](./ko-KR.md) | [Español](./es-ES.md) | [Русский](./ru-RU.md)
</div>

---

<h4>概要</h4>

TinyFS のすべての状態変更システムコールは、単一の IndexedDB トランザクション内で実行されます。ブラウザがクラッシュしたり、クォータを超過したり、操作の途中でタブが閉じられた場合、トランザクションは原子的にロールバックします。すべてのブロック書き込みとメタデータ更新が一緒にコミットされるか、まったくコミットされないかのいずれかです。破損した書き込み、宙ぶらりんの inode、サイズがブロックと一致しないファイルは発生しません。

<h4>主な機能</h4>

- `stat`、`mkdir`、`rmdir`、`readdir`、`open`、`close`、`read`、`write`、`rename`、`lseek`、`link`、`unlink` をサポート。
- ランタイム依存関係ゼロ。
- テスト関連の開発依存関係のみ少数。
- 90% 以上のテストカバレッジ。
- 基本的なファザーを内蔵。
- ブラウザ内の原子性テストと並行性テストを内蔵。
- Puppeteer を使用して Chrome でベンチマーク測定済み。
- CommonJS、ESM、UMD の配布形態に対応。
- 純粋な JavaScript と TypeScript の両方のプロジェクトに対応。
- インストールサイズ < 500 KiB（[中身を確認](https://www.npmjs.com/package/@bielok/tinyfs?activeTab=code)）！

## はじめに

### インストール

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

### UMD（ブラウザ）

```html
<script src="https://unpkg.com/@bielok/tinyfs/dist/tinyfs.umd.js"></script>
<script>
    const { TinyFS } = window.tinyfs;
    const tfs = await TinyFS.create("tinyfs");
</script>
```

## 使い方

すべてのパスは絶対パスであり、`/` で始まる必要があります。ルートディレクトリは `/` です。

### 例

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

IndexedDB データベースを開くか作成し、ルートディレクトリを初期化します。他の操作よりも先に呼び出す必要があります。同じ名前で複数回呼び出しても既存のデータベースが再利用されるため、データはページをまたいで永続化されます。

オプション設定を受け付けます：

| オプション | 型 | デフォルト | 説明 |
|---|---|---|---|
| `block_size` | `uint` | `4096` | 各データブロックのサイズ（バイト）。 |
| `max_fd` | `int` | `256` | 同時に開くことができるファイルディスクリプタの最大数。 |

```ts
// アプリケーション用に新しいデータベースを作成。
const tfs = await TinyFS.create("my-app-data");

// 2 つのインスタンスで独立したデータベースを使用可能：
const cfg  = await TinyFS.create("config");
const data = await TinyFS.create("user-data");

// Override defaults for a specific workload.
const big   = await TinyFS.create("big-fs",   { block_size: 65536 });
const small = await TinyFS.create("small-fs", { max_fd:     16    });
```

`shutdown()`

IndexedDB 接続を閉じます。データベースを削除する前にこのメソッドを呼び出す必要があります。呼び出さないと `deleteDatabase` が接続の終了を待ち続けます。

```ts
// クリーンアップのために接続を閉じる。
tfs.shutdown();

// これでデータベースを安全に削除できる。
await new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase("my-app-data");
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
});
```

`stat(path, buf)`

指定されたパスの `{ size, mode, nlink }` を `buf` に格納します。成功時は 0、パスが存在しないか祖先がディレクトリでない場合は -1 を返します。

```ts
const sb = { size: 0, mode: 0, nlink: 0 };

if (await tfs.stat("/foo", sb) === 0) {
    const is_dir  = (sb.mode & O.TYPE_MASK) === O.TYPE_DIR;
    const is_file = (sb.mode & O.TYPE_MASK) === O.TYPE_FILE;

    console.log(sb.size, "bytes", is_dir ? "dir" : "file", sb.nlink, "links");
}
```

`open(path, flags)`

ファイルを開くか作成し、ファイルディスクリプタを返します。`flags` 引数はビットマスクです。定数を `|` で組み合わせます：

| フラグ | 効果 |
|---|---|
| `READ` | 読み取り専用で開く |
| `WRITE` | 書き込み専用で開く |
| `READ_WRITE` | 読み書き両用で開く |
| `CREATE` | ファイルが存在しない場合に作成する |
| `EXCLUSIVE` | `CREATE` が設定されていてファイルが既に存在する場合は失敗する |
| `TRUNCATE` | 開いたときにファイルサイズを 0 に設定する |
| `APPEND` | すべての書き込みをファイル末尾に追記する |

> **TRUNCATE を使うタイミング:** ファイルの既存コンテンツをアトミックにクリアしたい場合は `TRUNCATE` を渡します。ファイルの読み取り、またはデータの追加のみが必要な場合は `TRUNCATE` を省略してください。`TRUNCATE` がない場合、オープンはより軽量なトランザクションを使用し（可能な場合は読み取り専用、ブロックストアは含まれません）、同時書き込みとのシリアル化の競合を減らします。

```ts
// 既存のファイルをアトミックに上書き（古い内容を消去）。
const fd = await tfs.open("/output.bin", O.TRUNCATE | O.WRITE);

// 既存のファイルを読み取り専用で開く（存在しない場合は -1）。
const fd = await tfs.open("/config.json", O.READ);

// アトミックに作成——既に存在する場合は失敗。
const fd = await tfs.open("/lock", O.CREATE | O.EXCLUSIVE | O.READ_WRITE);
if (fd < 0) { /* 別のインスタンスが既に存在する */ }
```

`close(fd)`

ファイルディスクリプタを解放し、スロットを再利用可能にします。成功時は 0、fd が範囲外または既に閉じられている場合は -1 を返します。

```ts
if (tfs.close(fd) === -1)
    console.error("二重クローズまたは無効な fd");
```

`max_fd`

同時に開くことができるファイルディスクリプタの最大数。この制限に達すると `open()` は -1 を返します。`TinyFS.create()` の `max_fd` オプションで設定できます。

`block_size`

各データブロックのサイズ（バイト）。すべてのファイル I/O はこのサイズのチャンクに分割されます。`TinyFS.create()` の `block_size` オプションで設定できます。

`read(fd, buffer, length)`

現在のファイルオフセットから最大 `length` バイトを `buffer` に読み込みます。オフセットは読み込んだバイト数だけ進みます。読み込んだバイト数を返し、EOF の場合は 0、エラー時は -1 を返します。

```ts
const buf = new Uint8Array(1024);
const n   = await tfs.read(fd, buf, 1024);

if (n > 0) {
    const text = new TextDecoder().decode(buf.subarray(0, n));
    console.log(n, "バイト読み込みました:", text);
} else if (n === 0) {
    console.log("ファイルの末尾です");
}
```

`write(fd, buffer, length)`

現在のファイルオフセットから `buffer` の `length` バイトを書き込みます。fd に `APPEND` が設定されている場合、オフセットはまず末尾に移動します。書き込んだバイト数を返し、エラー時は -1 を返します。

```ts
const data = new TextEncoder().encode("hello\n");
const n    = await tfs.write(fd, data, data.length);

if (n !== data.length)
    console.error("書き込み不足——容量不足の可能性があります");
```

`lseek(fd, offset, whence)`

ファイルオフセットを再設定します。`whence` は `SET`（先頭からの絶対位置）、`CURRENT`（現在位置からの相対位置）、`END`（ファイル終端からの相対位置）のいずれかです。新しいオフセットを返し、エラー時は -1 を返します。

```ts
// 先頭に戻る。
await tfs.lseek(fd, 0, O.SET);

// 100 バイト先にスキップ（例：ヘッダーを読むため）。
await tfs.lseek(fd, 100, O.CURRENT);

// 追記——終端を越えて最後のバイトまでシーク。次の書き込みで
// ファイルが拡張され、古いサイズとオフセットの間にスパース領域が生じる。
const size = await tfs.lseek(fd, 10, O.END);

// 先頭より前にシークしようとすると 0 に丸められる。
```

`mkdir(path)`

ディレクトリを作成します。親ディレクトリは既に存在している必要があります。成功時は 0、パスが既に存在するか親を解決できない場合は -1 を返します。

```ts
// 単一のディレクトリ。
if (await tfs.mkdir("/data") === -1)
    console.error("mkdir 失敗——/ は存在しますか？");

// 深くネストされたディレクトリは 1 レベルずつ作成する必要がある。
await tfs.mkdir("/a");
await tfs.mkdir("/a/b");
await tfs.mkdir("/a/b/c");
```

`rmdir(path)`

空のディレクトリを削除します。成功時は 0、ディレクトリが空でない、ディレクトリでない、または存在しない場合は -1 を返します。

```ts
// 空のディレクトリのみ削除可能。
if (await tfs.rmdir("/data") === -1) {
    // 子エントリがあるかもしれない——一覧を取得。
    const entries = await tfs.readdir("/data");
    console.log("まだ", entries.length, "個のエントリがあります");
}
```

`readdir(path)`

ディレクトリ内の各エントリの `{ id, name }` オブジェクトの配列を返します。パスが存在しないかディレクトリでない場合は -1 を返します。

```ts
const entries = await tfs.readdir("/");

if (Array.isArray(entries)) {
    for (const entry of entries)
        console.log(entry.name, "(inode", entry.id + ")");
}
```

`unlink(path)`

ファイルシステムから名前（ハードリンク）を削除します。最後のリンクが削除されると、inode とそのすべてのデータブロックが削除されます。成功時は 0、エラー時は -1 を返します。ディレクトリは `rmdir` で削除する必要があります。

```ts
// ファイルを削除。唯一のリンクだった場合、データは解放される。
if (await tfs.unlink("/tempfile") === 0)
    console.log("ファイルを削除しました");
```

`link(oldpath, newpath)`

`oldpath` と同じ inode を指すハードリンクを作成します。この呼び出し後、両方の名前は互換的に使用できます。inode は両方のリンクが削除されるまで存続します。成功時は 0、エラー時は -1 を返します。ディレクトリにはハードリンクを作成できません。

```ts
// 2 つの名前、1 つの inode。
await tfs.link("/original", "/backup");

const sb1 = { size: 0, mode: 0, nlink: 0 };
const sb2 = { size: 0, mode: 0, nlink: 0 };

await tfs.stat("/original", sb1);
await tfs.stat("/backup",  sb2);

console.log(sb1.nlink); // 2 — 両方の名前が inode を共有
console.log(sb1.size === sb2.size); // true

// 一方の名前を削除してもデータは解放されない。
await tfs.unlink("/original");
// /backup はまだ読み取り可能。
```

`rename(oldpath, newpath)`

ファイルを `oldpath` から `newpath` に移動します。`newpath` が既に存在する場合は原子的に置き換えられます。ディレクトリの名前変更はできません。成功時は 0、エラー時は -1 を返します。

```ts
// 単純な名前変更。
await tfs.rename("/tmp_download", "/final.txt");

// 原子的な置き換え——ターゲットが存在すれば上書き。
await tfs.rename("/new_config", "/config");
```

`export()`

ファイルシステム全体を `ArrayBuffer` にシリアライズして、バックアップや転送に使用します。ファイルシステムの使用中に呼び出しても安全です——export は読み取り専用の IndexedDB トランザクションを開くため、同時書き込みをブロックしません。

```ts
const blob : ArrayBuffer = await tfs.export();
```

`import(db_name, data, opts?)`

以前にエクスポートした `ArrayBuffer` から TinyFS ファイルシステムを作成します。データベース内の既存データはすべて置き換えられます。

```ts
const blob = await tfs.export();

// … 後で、または別のアプリケーションで：
const restored = await TinyFS.import("my-db", blob);
```

## ビルドとテストの実行

```bash
bun run build # すべての配布物をビルドします。
bun test      # 単体テストと並行性テストを実行します。
bun run fuzz  # ランダム操作ファザーを実行します。
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

## ライセンス

The author disclaims copyright to this source code.

This software is released into the public domain and is provided 'as-is', without warranty of any kind, express or implied.
