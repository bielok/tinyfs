<div align="center">
<br>

![TinyFS](../../.github/tinyfs_light.svg#gh-light-mode-only)
![TinyFS](../../.github/tinyfs_dark.svg#gh-dark-mode-only)

*IndexedDB 기반으로 구축된, 브라우저에서 동작하는 검증된 파일 시스템입니다.*

[English](../../README.md) | [简体中文](./zh-CN.md) | [繁體中文](./zh-TW.md) | [日本語](./ja-JP.md) | **한국어** | [Español](./es-ES.md) | [Русский](./ru-RU.md)
</div>


**요약**

TInyFS의 모든 상태 변경 시스템 콜은 단일 IndexedDB 트랜잭션 내에서 실행됩니다. 브라우저가 충돌하거나, 할당량을 초과하거나, 작업 중간에 탭이 닫히면 트랜잭션은 원자적으로 롤백됩니다. 모든 블록 쓰기와 메타데이터 업데이트가 함께 커밋되거나, 전혀 커밋되지 않습니다. torn write, 댕글링 inode, 또는 크기가 블록과 일치하지 않는 파일이 발생하지 않습니다.

**주요 기능**

- `stat`, `mkdir`, `rmdir`, `readdir`, `open`, `close`, `read`, `write`, `rename`, `lseek`, `link`, `unlink`를 지원합니다.
- 런타임 의존성이 전혀 없습니다.
- 테스트 관련 개발 의존성만 소수 포함합니다.
- 90% 이상의 테스트 커버리지.
- 기본 퍼저를 포함합니다.
- 브라우저 내 원자성 및 동시성 테스트를 포함합니다.
- Puppeteer를 사용하여 Chrome에서 벤치마크를 수행했습니다.
- CommonJS, ESM 및 UMD 배포판을 제공합니다.
- 순수 JavaScript 및 TypeScript 프로젝트와 모두 호환됩니다.

## 시작하기

### 설치

```bash
> npm install tinyfs
```

### ESM

```ts
import { TinyFS, CREATE, READ_WRITE, SET, CURRENT, END, TRUNCATE, WRITE, READ, EXCLUSIVE, TYPE_MASK, TYPE_DIR, TYPE_FILE } from "tinyfs";

const tfs = await TinyFS.create("my-database");
```

### CommonJS

```js
const { TinyFS, CREATE, READ_WRITE, SET, CURRENT, END, TRUNCATE, WRITE, READ, EXCLUSIVE, TYPE_MASK, TYPE_DIR, TYPE_FILE } = require("tinyfs");

async function main() {
    const tfs = await TinyFS.create("my-database");
}
```

### UMD (브라우저)

```html
<script src="dist/tinyfs.umd.js"></script>
<script>
    const { TinyFS, CREATE, READ_WRITE, SET, CURRENT, END, TRUNCATE, WRITE, READ, EXCLUSIVE, TYPE_MASK, TYPE_DIR, TYPE_FILE } = window.tinyfs;
    const tfs = await TinyFS.create("tinyfs");
</script>
```

## 사용 방법

모든 경로는 절대 경로입니다——`/`로 시작해야 합니다. 루트 디렉터리는 `/`입니다.

### 예제

```ts
import { TinyFS, CREATE, READ_WRITE, SET, CURRENT, END, TRUNCATE, WRITE, READ, EXCLUSIVE, TYPE_MASK, TYPE_DIR, TYPE_FILE } from "tinyfs";

const tfs = await TinyFS.create("my-database");

const fd = await tfs.open("/foo", CREATE | READ_WRITE);
await tfs.write(fd, new Uint8Array([104, 101, 108, 108, 111]), 5);
await tfs.lseek(fd, 0, SET);

const buf = new Uint8Array(5);
await tfs.read(fd, buf, 5);
// buf -> [104, 101, 108, 108, 111]

tfs.close(fd);
tfs.shutdown();
```

### API Reference

`TinyFS.create(db_name, opts?)`

IndexedDB 데이터베이스를 열거나 생성하고 루트 디렉터리를 초기화합니다. 다른 모든 작업보다 먼저 호출해야 합니다. 동일한 이름으로 여러 번 호출하면 기존 데이터베이스를 재사용하므로 데이터가 페이지 로드 간에 유지됩니다.

선택적 설정을 받습니다：

| 옵션 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `block_size` | `uint` | `4096` | 각 데이터 블록의 크기(바이트)입니다. |
| `max_fd` | `int` | `256` | 동시에 열 수 있는 파일 디스크립터의 최대 개수입니다. |

```ts
// 애플리케이션용 새 데이터베이스를 생성합니다.
const tfs = await TinyFS.create("my-app-data");

// 두 인스턴스가 독립적인 데이터베이스를 사용할 수 있습니다:
const cfg  = await TinyFS.create("config");
const data = await TinyFS.create("user-data");

// Override defaults for a specific workload.
const big   = await TinyFS.create("big-fs",   { block_size: 65536 });
const small = await TinyFS.create("small-fs", { max_fd:     16    });
```

`shutdown()`

IndexedDB 연결을 닫습니다. 데이터베이스를 삭제하기 전에 이 메서드를 호출해야 합니다. 그렇지 않으면 `deleteDatabase`가 연결이 종료될 때까지 대기합니다.

```ts
// 정리를 위해 연결을 닫습니다.
tfs.shutdown();

// 이제 데이터베이스를 안전하게 삭제할 수 있습니다.
await new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase("my-app-data");
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
});
```

`stat(path, buf)`

지정된 경로의 `{ size, mode, nlink }`를 `buf`에 채웁니다. 성공 시 0을, 경로가 없거나 상위 경로가 디렉터리가 아닌 경우 -1을 반환합니다.

```ts
const sb = { size: 0, mode: 0, nlink: 0 };

if (await tfs.stat("/foo", sb) === 0) {
    const is_dir  = (sb.mode & TYPE_MASK) === TYPE_DIR;
    const is_file = (sb.mode & TYPE_MASK) === TYPE_FILE;

    console.log(sb.size, "bytes", is_dir ? "dir" : "file", sb.nlink, "links");
}
```

`open(path, flags)`

파일을 열거나 생성하고 파일 디스크립터를 반환합니다. `flags` 인수는 비트마스크입니다. `|`로 상수를 조합합니다:

| 플래그 | 효과 |
|---|---|
| `READ` | 읽기 전용으로 열기 |
| `WRITE` | 쓰기 전용으로 열기 |
| `READ_WRITE` | 읽기/쓰기 겸용으로 열기 |
| `CREATE` | 파일이 없으면 생성 |
| `EXCLUSIVE` | `CREATE`가 설정되고 파일이 이미 있으면 실패 |
| `TRUNCATE` | 열 때 파일 크기를 0으로 설정 |
| `APPEND` | 모든 쓰기를 파일 끝에 추가 |

> **TRUNCATE 사용 시기:** 기존 파일 내용을 원자적으로 모두 지우려면 `TRUNCATE`를 전달하세요. 파일을 읽거나 데이터만 추가하면 되는 경우 `TRUNCATE`를 생략하세요. `TRUNCATE` 없이 열면 더 가벼운 트랜잭션을 사용하며(가능한 경우 읽기 전용, 블록 스토어 미포함), 동시 쓰기와의 직렬화 충돌을 줄입니다.

```ts
// 기존 파일을 원자적으로 덮어씁니다(이전 내용 삭제).
const fd = await tfs.open("/output.bin", TRUNCATE | WRITE);

// 기존 파일을 읽기 전용으로 엽니다(없으면 -1 반환).
const fd = await tfs.open("/config.json", READ);

// 원자적으로 생성——이미 있으면 실패.
const fd = await tfs.open("/lock", CREATE | EXCLUSIVE | READ_WRITE);
if (fd < 0) { /* 다른 인스턴스가 이미 존재함 */ }
```

`close(fd)`

파일 디스크립터를 해제하여 슬롯을 재사용할 수 있게 합니다. 성공 시 0을, fd가 범위를 벗어나거나 이미 닫힌 경우 -1을 반환합니다.

```ts
if (tfs.close(fd) === -1)
    console.error("이중 닫기 또는 유효하지 않은 fd");
```

`max_fd`

동시에 열 수 있는 파일 디스크립터의 최대 개수입니다. 이 제한에 도달하면 `open()`이 -1을 반환합니다. `TinyFS.create()`의 `max_fd` 옵션으로 설정할 수 있습니다.

`block_size`

각 데이터 블록의 크기(바이트)입니다. 모든 파일 I/O는 이 크기의 청크로 나뉩니다. `TinyFS.create()`의 `block_size` 옵션으로 설정할 수 있습니다.

`read(fd, buffer, length)`

현재 파일 오프셋에서 최대 `length` 바이트를 `buffer`로 읽습니다. 읽은 바이트 수만큼 오프셋이 앞으로 이동합니다. 읽은 바이트 수를 반환하고, EOF인 경우 0을, 오류 시 -1을 반환합니다.

```ts
const buf = new Uint8Array(1024);
const n   = await tfs.read(fd, buf, 1024);

if (n > 0) {
    const text = new TextDecoder().decode(buf.subarray(0, n));
    console.log(n, "바이트 읽음:", text);
} else if (n === 0) {
    console.log("파일 끝");
}
```

`write(fd, buffer, length)`

현재 파일 오프셋에서 `buffer`의 `length` 바이트를 씁니다. fd에 `APPEND`가 설정된 경우 오프셋이 먼저 끝으로 이동합니다. 쓴 바이트 수를 반환하고, 오류 시 -1을 반환합니다.

```ts
const data = new TextEncoder().encode("hello\n");
const n    = await tfs.write(fd, data, data.length);

if (n !== data.length)
    console.error("쓰기 부족——공간이 부족할 수 있음");
```

`lseek(fd, offset, whence)`

파일 오프셋을 재배치합니다. `whence`는 `SET`(처음부터 절대 위치), `CURRENT`(현재 위치 기준), `END`(파일 끝 기준) 중 하나입니다. 새 오프셋을 반환하고, 오류 시 -1을 반환합니다.

```ts
// 처음으로 되감기.
await tfs.lseek(fd, 0, SET);

// 100바이트 앞으로 건너뛰기(예: 헤더 읽기).
await tfs.lseek(fd, 100, CURRENT);

// 추가——끝을 지나 마지막 바이트까지 시크. 다음 쓰기에서
// 파일이 확장되어 이전 크기와 오프셋 사이에 스파스 영역이 생깁니다.
const size = await tfs.lseek(fd, 10, END);

// 시작보다 앞으로 시크하려고 하면 0으로 고정됩니다.
```

`mkdir(path)`

디렉터리를 생성합니다. 부모 디렉터리가 이미 존재해야 합니다. 성공 시 0을, 경로가 이미 있거나 부모를 확인할 수 없는 경우 -1을 반환합니다.

```ts
// 단일 디렉터리.
if (await tfs.mkdir("/data") === -1)
    console.error("mkdir 실패——/가 존재합니까?");

// 깊게 중첩된 디렉터리는 한 레벨씩 생성해야 합니다.
await tfs.mkdir("/a");
await tfs.mkdir("/a/b");
await tfs.mkdir("/a/b/c");
```

`rmdir(path)`

빈 디렉터리를 제거합니다. 성공 시 0을, 디렉터리가 비어 있지 않거나, 디렉터리가 아니거나, 존재하지 않는 경우 -1을 반환합니다.

```ts
// 빈 디렉터리만 제거 가능.
if (await tfs.rmdir("/data") === -1) {
    // 하위 항목이 있을 수 있음——목록을 확인.
    const entries = await tfs.readdir("/data");
    console.log("아직", entries.length, "개의 항목이 있음");
}
```

`readdir(path)`

디렉터리의 각 항목에 대한 `{ id, name }` 객체 배열을 반환합니다. 경로가 없거나 디렉터리가 아닌 경우 -1을 반환합니다.

```ts
const entries = await tfs.readdir("/");

if (Array.isArray(entries)) {
    for (const entry of entries)
        console.log(entry.name, "(inode", entry.id + ")");
}
```

`unlink(path)`

파일 시스템에서 이름(하드 링크)을 제거합니다. 마지막 링크가 제거되면 inode와 모든 데이터 블록이 삭제됩니다. 성공 시 0을, 오류 시 -1을 반환합니다. 디렉터리는 `rmdir`로 제거해야 합니다.

```ts
// 파일 제거. 유일한 링크였다면 데이터가 해제됩니다.
if (await tfs.unlink("/tempfile") === 0)
    console.log("파일이 제거됨");
```

`link(oldpath, newpath)`

`oldpath`와 동일한 inode를 가리키는 하드 링크를 생성합니다. 이 호출 후 두 이름은 서로 바꿔 사용할 수 있습니다. inode는 두 링크가 모두 삭제될 때까지 유지됩니다. 성공 시 0을, 오류 시 -1을 반환합니다. 디렉터리에는 하드 링크를 만들 수 없습니다.

```ts
// 두 이름, 하나의 inode.
await tfs.link("/original", "/backup");

const sb1 = { size: 0, mode: 0, nlink: 0 };
const sb2 = { size: 0, mode: 0, nlink: 0 };

await tfs.stat("/original", sb1);
await tfs.stat("/backup",  sb2);

console.log(sb1.nlink); // 2 — 두 이름이 inode를 공유
console.log(sb1.size === sb2.size); // true

// 하나의 이름을 제거해도 데이터는 해제되지 않음.
await tfs.unlink("/original");
// /backup은 여전히 읽기 가능.
```

`rename(oldpath, newpath)`

파일을 `oldpath`에서 `newpath`로 이동합니다. `newpath`가 이미 있으면 원자적으로 대체됩니다. 디렉터리 이름은 변경할 수 없습니다. 성공 시 0을, 오류 시 -1을 반환합니다.

```ts
// 간단한 이름 변경.
await tfs.rename("/tmp_download", "/final.txt");

// 원자적 대체——대상이 있으면 덮어씁니다.
await tfs.rename("/new_config", "/config");
```

## 빌드 및 테스트 실행

```bash
bun run build     # 모든 배포판을 빌드합니다.
bun test          # 단위 테스트 및 동시성 테스트를 실행합니다.
bun run fuzz      # 무작위 작업 퍼저를 실행합니다.
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

## 라이선스

The author disclaims copyright to this source code.

This software is released into the public domain and is provided 'as-is', without warranty of any kind, express or implied.
