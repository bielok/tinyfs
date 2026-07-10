<div align="center">
<br>

![TinyFS](../../.github/tinyfs_light.svg#gh-light-mode-only)
![TinyFS](../../.github/tinyfs_dark.svg#gh-dark-mode-only)

*Un sistema de archivos para el navegador, probado y construido sobre IndexedDB.*

[English](../../README.md) | [简体中文](./zh-CN.md) | [繁體中文](./zh-TW.md) | [日本語](./ja-JP.md) | [한국어](./ko-KR.md) | **Español** | [Русский](./ru-RU.md)

</div>

**Resumen**

En TInyFS, cada syscall que modifica estado se ejecuta dentro de una única transacción de IndexedDB. Si el navegador se bloquea, se supera la cuota o la pestaña se cierra a mitad de la operación, la transacción se revierte atómicamente. O bien la escritura de todos los bloques y la respectiva actualización de metadata se confirman juntas, o no se confirma ninguna. No existe la posibilidad de una escritura incompleta, un inode huérfano o un archivo cuyo tamaño no coincida con sus bloques.

**Características destacadas**

- Soporta `stat`, `mkdir`, `rmdir`, `readdir`, `open`, `close`, `read`, `write`, `rename`, `lseek`, `link`, `unlink`.
- Cero dependencias en tiempo de ejecución.
- Pocas dependencias de desarrollo relacionadas con pruebas.
- Más del 90% de cobertura con pruebas.
- Incluye un fuzzer básico.
- Incluye pruebas de atomicidad y concurrencia en el navegador.
- Pruebas de bench en Chrome usando Puppeteer.
- Disponible en CommonJS, ESM y UMD.
- Compatible con proyectos tanto de JavaScript puro como de TypeScript.

## Primeros pasos

### Instalación

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

### UMD (navegador)

```html
<script src="https://unpkg.com/@bielok/tinyfs/dist/tinyfs.umd.js"></script>
<script>
    const { TinyFS } = window.tinyfs;
    const tfs = await TinyFS.create("tinyfs");
</script>
```

## Modo de uso

Todas las rutas son absolutas: deben comenzar con `/`. El directorio raíz es `/`.

### Ejemplo

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

### Referencia

`TinyFS.create(db_name, opts?)`

Abre o crea una base de datos IndexedDB e inicializa el directorio raíz. Debe llamarse una vez antes de cualquier otra operación. Cada llamada con el mismo nombre reutiliza la base de datos existente: los datos persisten entre recargas de página.

Acepta ajustes opcionales:

| Opción | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `block_size` | `uint` | `4096` | Tamaño en bytes de cada bloque de datos. |
| `max_fd` | `int` | `256` | Número máximo de descriptores de archivo abiertos simultáneamente. |

```ts
// Crear una base de datos nueva para esta aplicación.
const tfs = await TinyFS.create("my-app-data");

// Dos instancias pueden usar bases de datos independientes:
const cfg  = await TinyFS.create("config");
const data = await TinyFS.create("user-data");

// Override defaults for a specific workload.
const big   = await TinyFS.create("big-fs",   { block_size: 65536 });
const small = await TinyFS.create("small-fs", { max_fd:     16    });
```

`shutdown()`

Cierra la conexión IndexedDB. Necesario antes de eliminar la base de datos; de lo contrario, `deleteDatabase` se quedará esperando a que la conexión se cierre.

```ts
// Cerrar la conexión para poder limpiar.
tfs.shutdown();

// Ahora la base de datos se puede eliminar de forma segura.
await new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase("my-app-data");
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
});
```

`stat(path, buf)`

Llena `buf` con `{ size, mode, nlink }` para la ruta dada. Devuelve 0 en caso de éxito, -1 si la ruta no existe o un ancestro no es un directorio.

```ts
const sb = { size: 0, mode: 0, nlink: 0 };

if (await tfs.stat("/foo", sb) === 0) {
    const is_dir  = (sb.mode & O.TYPE_MASK) === O.TYPE_DIR;
    const is_file = (sb.mode & O.TYPE_MASK) === O.TYPE_FILE;

    console.log(sb.size, "bytes", is_dir ? "dir" : "file", sb.nlink, "links");
}
```

`open(path, flags)`

Abre o crea un archivo y devuelve un descriptor de archivo. El argumento `flags` es una máscara de bits: combine constantes con `|`:

| Indicador | Efecto |
|---|---|
| `READ` | Abrir para lectura |
| `WRITE` | Abrir para escritura |
| `READ_WRITE` | Abrir para ambos |
| `CREATE` | Crear el archivo si no existe |
| `EXCLUSIVE` | Fallar si `CREATE` está establecido y el archivo ya existe |
| `TRUNCATE` | Establecer el tamaño del archivo a 0 al abrir |
| `APPEND` | Todas las escrituras van al final del archivo |

> **Cuando usar TRUNCATE:** Pasa `TRUNCATE` cuando quieras borrar todo el contenido existente de un archivo de forma atómica al abrirlo. Omite `TRUNCATE` si solo necesitas leer el archivo o agregar datos al final. Sin `TRUNCATE` la apertura usa una transacción más ligera (de solo lectura cuando es posible, y el almacén de bloques queda excluido), reduciendo la serialización con escritores concurrentes.

```ts
// Sobrescribir un archivo existente de forma atómica (borra el contenido anterior).
const fd = await tfs.open("/output.bin", O.TRUNCATE | O.WRITE);

// Abrir un archivo existente para lectura (falla con -1 si no existe).
const fd = await tfs.open("/config.json", O.READ);

// Creación atómica (falla si ya existe).
const fd = await tfs.open("/lock", O.CREATE | O.EXCLUSIVE | O.READ_WRITE);
if (fd < 0) { /* otra instancia ya existe */ }
```

`close(fd)`

Libera un descriptor de archivo para que su ranura pueda reutilizarse. Devuelve 0 en caso de éxito, -1 si el fd está fuera de rango o ya está cerrado.

```ts
if (tfs.close(fd) === -1)
    console.error("doble cierre o fd inválido");
```

`max_fd`

Número máximo de descriptores de archivo abiertos simultáneamente. `open()` devuelve -1 cuando se alcanza este límite. Se configura mediante la opción `max_fd` en `TinyFS.create()`.

`block_size`

Tamaño en bytes de cada bloque de datos. Toda la E/S de archivos se divide en fragmentos de este tamaño. Se configura mediante la opción `block_size` en `TinyFS.create()`.

`read(fd, buffer, length)`

Lee hasta `length` bytes desde el desplazamiento actual del archivo en `buffer`. Avanza el desplazamiento en la cantidad de bytes leídos. Devuelve el número de bytes leídos, 0 en EOF, o -1 en caso de error.

```ts
const buf = new Uint8Array(1024);
const n   = await tfs.read(fd, buf, 1024);

if (n > 0) {
    const text = new TextDecoder().decode(buf.subarray(0, n));
    console.log("leídos", n, "bytes:", text);
} else if (n === 0) {
    console.log("fin del archivo");
}
```

`write(fd, buffer, length)`

Escribe `length` bytes desde `buffer` en el desplazamiento actual del archivo. Si se estableció `APPEND` en el fd, el desplazamiento se mueve primero al final. Devuelve el número de bytes escritos, o -1 en caso de error.

```ts
const data = new TextEncoder().encode("hello\n");
const n    = await tfs.write(fd, data, data.length);

if (n !== data.length)
    console.error("escritura corta (probablemente falta de espacio)");
```

`lseek(fd, offset, whence)`

Reposiciona el desplazamiento del archivo. `whence` puede ser `SET` (absoluto desde el inicio), `CURRENT` (relativo a la posición actual) o `END` (relativo al final del archivo). Devuelve el nuevo desplazamiento, o -1 en caso de error.

```ts
// Volver al principio.
await tfs.lseek(fd, 0, O.SET);

// Saltar 100 bytes hacia adelante (p. ej., para leer un encabezado).
await tfs.lseek(fd, 100, O.CURRENT);

// Anexar: buscar más allá del final hasta el último byte. La siguiente
// escritura extiende el archivo, produciendo una región dispersa entre
// el tamaño anterior y el desplazamiento.
const size = await tfs.lseek(fd, 10, O.END);

// Intentar buscar antes del inicio se fija a 0.
```

`mkdir(path)`

Crea un directorio. El directorio padre ya debe existir. Devuelve 0 en caso de éxito, -1 si la ruta ya existe o no se puede resolver el padre.

```ts
// Directorio único.
if (await tfs.mkdir("/data") === -1)
    console.error("mkdir falló (¿existe /?)");

// Los directorios profundamente anidados deben crearse un nivel a la vez.
await tfs.mkdir("/a");
await tfs.mkdir("/a/b");
await tfs.mkdir("/a/b/c");
```

`rmdir(path)`

Elimina un directorio vacío. Devuelve 0 en caso de éxito, -1 si el directorio no está vacío, no es un directorio o no existe.

```ts
// Solo se pueden eliminar directorios vacíos.
if (await tfs.rmdir("/data") === -1) {
    // Quizás tiene hijos. Listarlos.
    const entries = await tfs.readdir("/data");
    console.log("todavía tiene", entries.length, "entradas");
}
```

`readdir(path)`

Devuelve un array de objetos `{ id, name }` para cada entrada en el directorio, o -1 si la ruta no existe o no es un directorio.

```ts
const entries = await tfs.readdir("/");

if (Array.isArray(entries)) {
    for (const entry of entries)
        console.log(entry.name, "(inodo", entry.id + ")");
}
```

`unlink(path)`

Elimina un nombre (enlace duro) del sistema de archivos. Cuando se elimina el último enlace, el inodo y todos sus bloques de datos se borran. Devuelve 0 en caso de éxito, -1 en caso de error. Los directorios deben eliminarse con `rmdir`.

```ts
// Eliminar un archivo. Si era el único enlace, los datos se liberan.
if (await tfs.unlink("/tempfile") === 0)
    console.log("archivo eliminado");
```

`link(oldpath, newpath)`

Crea un enlace duro que apunta al mismo inodo que `oldpath`. Ambos nombres son intercambiables después de esta llamada: el inodo persiste hasta que ambos sean desvinculados. Devuelve 0 en caso de éxito, -1 en caso de error. No se pueden enlazar directorios.

```ts
// Dos nombres, un inodo.
await tfs.link("/original", "/backup");

const sb1 = { size: 0, mode: 0, nlink: 0 };
const sb2 = { size: 0, mode: 0, nlink: 0 };

await tfs.stat("/original", sb1);
await tfs.stat("/backup",  sb2);

console.log(sb1.nlink); // 2 (ambos nombres comparten el inodo)
console.log(sb1.size === sb2.size); // true

// Eliminar un nombre no libera los datos.
await tfs.unlink("/original");
// /backup sigue siendo legible.
```

`rename(oldpath, newpath)`

Mueve un archivo de `oldpath` a `newpath`. Si `newpath` ya existe, se reemplaza atómicamente. Los directorios no pueden renombrarse. Devuelve 0 en caso de éxito, -1 en caso de error.

```ts
// Renombrado simple.
await tfs.rename("/tmp_download", "/final.txt");

// Reemplazo atómico (sobrescribe el destino si existe).
await tfs.rename("/new_config", "/config");
```

`export()`

Serializa todo el sistema de archivos en un `ArrayBuffer` para respaldo o transferencia. Es seguro llamarlo mientras el sistema de archivos está en uso — export abre una transacción de solo lectura de IndexedDB que no bloquea escrituras concurrentes.

```ts
const blob : ArrayBuffer = await tfs.export();
```

`import(db_name, data, opts?)`

Crea un sistema de archivos TinyFS a partir de un `ArrayBuffer` exportado previamente. Cualquier dato existente en la base de datos se reemplaza.

```ts
const blob = await tfs.export();

// … más tarde, o en otra aplicación:
const restored = await TinyFS.import("my-db", blob);
```

## Compilación y ejecución de pruebas

```bash
bun run build # Compila todos los distributivos.
bun test      # Ejecuta pruebas unitarias y de concurrencia.
bun run fuzz  # Ejecuta el fuzzer de operaciones aleatorias.
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

**NOTE**: Abre bench.html para probar el rendimiento en otros navegadores

## Licencia

The author disclaims copyright to this source code.

This software is released into the public domain and is provided 'as-is', without warranty of any kind, express or implied.
