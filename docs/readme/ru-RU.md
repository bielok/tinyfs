![TinyFS](../../.github/tinyfs_light.svg#gh-light-mode-only)
![TinyFS](../../.github/tinyfs_dark.svg#gh-dark-mode-only)

![Build Status](https://github.com/bielok/tinyfs/actions/workflows/test.yml/badge.svg) ![Made in Buenos Aires](../../.github/madein.svg)

*Браузерная файловая система на основе IndexedDB.*

> [!NOTE]
> Это экспериментальная идея — дайте знать, если она окажется полезной.

[English](../../README.md) | [简体中文](./zh-CN.md) | [繁體中文](./zh-TW.md) | [日本語](./ja-JP.md) | [한국어](./ko-KR.md) | [Español](./es-ES.md) | **Русский**

**Кратко**

Каждый системный вызов tinyfs, изменяющий состояние, выполняется в рамках одной транзакции IndexedDB. Если браузер упадёт, закончится квота или вкладка закроется посередине операции, транзакция атомарно откатится: либо все записи блоков и обновление метаданных фиксируются вместе, либо ни одна из них. Невозможны разорванная запись, потерянный inode или файл, размер которого не соответствует его блокам.

**Примечательные возможности**

- Поддерживает `stat`, `mkdir`, `rmdir`, `readdir`, `open`, `close`, `read`, `write`, `rename`, `lseek`, `link`, `unlink`.
- Ноль зависимостей времени выполнения.
- Минимум зависимостей для разработки (только тестирование).
- Покрытие тестами 90%+.
- Включает базовый фаззер.
- Включает браузерные тесты атомарности и конкурентности.
- Тестирование производительности в Chrome с помощью Puppeteer.
- Доступен в форматах CommonJS, ESM и UMD.
- Совместим с проектами на чистом JavaScript и TypeScript.

## Установка

```bash
> npm install tinyfs
```

<details>
<summary>Установка с другими менеджерами пакетов и средами выполнения</summary>

### Установка из GitHub

```bash
> npm install bielok/tinyfs
```

См. [документацию npm install](https://docs.npmjs.com/cli/v8/commands/npm-install).

### Установка с pnpm

```bash
> pnpm install tinyfs
```

См. [документацию pnpm install](https://pnpm.io/cli/install).

### Установка с yarn

```bash
> yarn add tinyfs
```

См. [документацию yarn add](https://classic.yarnpkg.com/lang/en/docs/cli/add/).

### Установка с bun

```bash
> bun add tinyfs
```

См. [документацию bun add](https://bun.com/docs/pm/cli/add).

### Установка с deno

```bash
> deno install tinyfs
```

См. [документацию deno install](https://docs.deno.com/runtime/reference/cli/install/).
</details>

## Использование

### ESM

```ts
import { TinyFS } from "tinyfs";

const tfs = await TinyFS.create("my-database");
```

### CommonJS

```js
const { TinyFS } = require("tinyfs");

async function main() {
    const tfs = await TinyFS.create("my-database");
}
```

### UMD (браузер)

```html
<script src="dist/tinyfs.umd.js"></script>
<script>
    const { TinyFS } = window.tinyfs;
    const tfs = await TinyFS.create("tinyfs");
</script>
```

## Как использовать

Все пути абсолютны: они должны начинаться с `/`. Корневой каталог — `/`.

### Пример

```ts
import { TinyFS } from "tinyfs";

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

Открывает или создаёт базу данных IndexedDB и инициализирует корневой каталог. Должна быть вызвана один раз перед любой другой операцией. Каждый вызов с тем же именем использует существующую базу данных; данные сохраняются между перезагрузками страницы.

Принимает необязательные настройки:

| Опция | Тип | По умолчанию | Описание |
|---|---|---|---|
| `block_size` | `uint` | `4096` | Размер каждого блока данных в байтах. |
| `max_fd` | `int` | `256` | Максимальное количество одновременно открытых файловых дескрипторов. |

```ts
// Создать новую базу данных для приложения.
const tfs = await TinyFS.create("my-app-data");

// Два экземпляра могут использовать независимые базы данных:
const cfg  = await TinyFS.create("config");
const data = await TinyFS.create("user-data");

// Override defaults for a specific workload.
const big   = await TinyFS.create("big-fs",   { block_size: 65536 });
const small = await TinyFS.create("small-fs", { max_fd:     16    });
```

`shutdown()`

Закрывает соединение с IndexedDB. Требуется перед удалением базы данных, иначе `deleteDatabase` будет ждать закрытия соединения.

```ts
// Закрыть соединение, чтобы можно было выполнить очистку.
tfs.shutdown();

// Теперь базу данных можно безопасно удалить.
await new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase("my-app-data");
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
});
```

`stat(path, buf)`

Заполняет `buf` значениями `{ size, mode, nlink }` для указанного пути. Возвращает 0 при успехе, -1 если путь не существует или один из родителей не является каталогом.

```ts
const sb = { size: 0, mode: 0, nlink: 0 };

if (await tfs.stat("/foo", sb) === 0) {
    const is_dir  = (sb.mode & tfs.TYPE_MASK) === tfs.TYPE_DIR;
    const is_file = (sb.mode & tfs.TYPE_MASK) === tfs.TYPE_FILE;

    console.log(sb.size, "bytes", is_dir ? "dir" : "file", sb.nlink, "links");
}
```

`open(path, flags)`

Открывает или создаёт файл и возвращает файловый дескриптор. Аргумент `flags` — битовая маска; комбинируйте константы с помощью `|`:

| Флаг | Действие |
|---|---|
| `READ` | Открыть для чтения |
| `WRITE` | Открыть для записи |
| `READ_WRITE` | Открыть для чтения и записи |
| `CREATE` | Создать файл, если он не существует |
| `EXCLUSIVE` | Завершиться ошибкой, если установлен `CREATE` и файл существует |
| `TRUNCATE` | Установить размер файла в 0 при открытии |
| `APPEND` | Все записи производятся в конец файла |

> **Когда использовать TRUNCATE:** Передавайте `TRUNCATE`, когда нужно атомарно очистить всё содержимое файла при открытии. Пропускайте `TRUNCATE`, если требуется только чтение или добавление данных. Без `TRUNCATE` открытие использует более лёгкую транзакцию (только чтение, если возможно, а хранилище блоков исключается), уменьшая сериализацию с конкурирующими писателями.

```ts
// Атомарно перезаписать существующий файл (очищает старое содержимое).
const fd = await tfs.open("/output.bin", tfs.TRUNCATE | tfs.WRITE);

// Открыть существующий файл для чтения (возвращает -1, если файл отсутствует).
const fd = await tfs.open("/config.json", tfs.READ);

// Атомарное создание (завершается ошибкой, если уже существует).
const fd = await tfs.open("/lock", tfs.CREATE | tfs.EXCLUSIVE | tfs.READ_WRITE);
if (fd < 0) { /* другой экземпляр уже существует */ }
```

`close(fd)`

Освобождает файловый дескриптор, чтобы его слот можно было использовать повторно. Возвращает 0 при успехе, -1 если fd вне допустимого диапазона или уже закрыт.

```ts
if (tfs.close(fd) === -1)
    console.error("двойное закрытие или недопустимый fd");
```

`max_fd`

Максимальное количество одновременно открытых файловых дескрипторов. `open()` возвращает -1 при достижении этого лимита. Устанавливается опцией `max_fd` в `TinyFS.create()`.

`block_size`

Размер каждого блока данных в байтах. Весь файловый ввод-вывод делится на блоки этого размера. Устанавливается опцией `block_size` в `TinyFS.create()`.

`read(fd, buffer, length)`

Читает до `length` байт из текущей позиции файла в `buffer`. Сдвигает позицию на количество прочитанных байт. Возвращает количество прочитанных байт, 0 в конце файла или -1 при ошибке.

```ts
const buf = new Uint8Array(1024);
const n   = await tfs.read(fd, buf, 1024);

if (n > 0) {
    const text = new TextDecoder().decode(buf.subarray(0, n));
    console.log("прочитано", n, "байт:", text);
} else if (n === 0) {
    console.log("конец файла");
}
```

`write(fd, buffer, length)`

Записывает `length` байт из `buffer` в текущую позицию файла. Если для fd был установлен `APPEND`, позиция сначала перемещается в конец. Возвращает количество записанных байт или -1 при ошибке.

```ts
const data = new TextEncoder().encode("hello\n");
const n    = await tfs.write(fd, data, data.length);

if (n !== data.length)
    console.error("короткая запись (вероятно, не хватает места)");
```

`lseek(fd, offset, whence)`

Перемещает позицию в файле. `whence` — одно из `SET` (абсолютно от начала), `CURRENT` (относительно текущей позиции) или `END` (относительно конца файла). Возвращает новую позицию или -1 при ошибке.

```ts
// Перейти в начало.
await tfs.lseek(fd, 0, tfs.SET);

// Пропустить 100 байт вперёд (например, чтобы прочитать заголовок).
await tfs.lseek(fd, 100, tfs.CURRENT);

// Добавление: переместиться за конец файла к последнему байту. Следующая
// запись расширит файл, создав разреженную область между старым
// размером и новой позицией.
const size = await tfs.lseek(fd, 10, tfs.END);

// Попытка переместиться до начала файла фиксируется на 0.
```

`mkdir(path)`

Создаёт каталог. Родительский каталог уже должен существовать. Возвращает 0 при успехе, -1 если путь уже существует или родительский каталог не найден.

```ts
// Одиночный каталог.
if (await tfs.mkdir("/data") === -1)
    console.error("mkdir не удался (существует ли /?)");

// Глубоко вложенные каталоги создаются по одному уровню за раз.
await tfs.mkdir("/a");
await tfs.mkdir("/a/b");
await tfs.mkdir("/a/b/c");
```

`rmdir(path)`

Удаляет пустой каталог. Возвращает 0 при успехе, -1 если каталог не пуст, не является каталогом или не существует.

```ts
// Можно удалить только пустые каталоги.
if (await tfs.rmdir("/data") === -1) {
    // Возможно, у него есть содержимое. Перечислить его.
    const entries = await tfs.readdir("/data");
    console.log("всё ещё содержит", entries.length, "записей");
}
```

`readdir(path)`

Возвращает массив объектов `{ id, name }` для каждой записи в каталоге или -1, если путь не существует или не является каталогом.

```ts
const entries = await tfs.readdir("/");

if (Array.isArray(entries)) {
    for (const entry of entries)
        console.log(entry.name, "(inode", entry.id + ")");
}
```

`unlink(path)`

Удаляет имя (жёсткую ссылку) из файловой системы. Когда удаляется последняя ссылка, inode и все его блоки данных удаляются. Возвращает 0 при успехе, -1 при ошибке. Каталоги должны удаляться через `rmdir`.

```ts
// Удалить файл. Если это была единственная ссылка, данные освобождаются.
if (await tfs.unlink("/tempfile") === 0)
    console.log("файл удалён");
```

`link(oldpath, newpath)`

Создаёт жёсткую ссылку, указывающую на тот же inode, что и `oldpath`. После вызова оба имени взаимозаменяемы; inode сохраняется, пока не будут удалены оба. Возвращает 0 при успехе, -1 при ошибке. Ссылки на каталоги не допускаются.

```ts
// Два имени, один inode.
await tfs.link("/original", "/backup");

const sb1 = { size: 0, mode: 0, nlink: 0 };
const sb2 = { size: 0, mode: 0, nlink: 0 };

await tfs.stat("/original", sb1);
await tfs.stat("/backup",  sb2);

console.log(sb1.nlink); // 2 (оба имени разделяют inode)
console.log(sb1.size === sb2.size); // true

// Удаление одного имени не освобождает данные.
await tfs.unlink("/original");
// /backup остаётся читаемым.
```

`rename(oldpath, newpath)`

Перемещает файл из `oldpath` в `newpath`. Если `newpath` уже существует, он атомарно заменяется. Переименование каталогов не допускается. Возвращает 0 при успехе, -1 при ошибке.

```ts
// Простое переименование.
await tfs.rename("/tmp_download", "/final.txt");

// Атомарная замена (перезаписывает целевой файл, если он существует).
await tfs.rename("/new_config", "/config");
```

## Сборка и запуск тестов

```bash
bun run build     # Собрать все дистрибутивы.
bun test          # Запустить модульные тесты и тесты конкурентности.
bun run fuzz      # Запустить фаззер случайных операций.
```

## Бенчмарки

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

## Лицензия

The author disclaims copyright to this source code.

This software is released into the public domain and is provided 'as-is', without warranty of any kind, express or implied.
