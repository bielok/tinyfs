import "fake-indexeddb/auto";
import { CREATE, READ, READ_WRITE, ROOT_INODE, STORE_BLOCKS, STORE_INODES, TinyFS, TRUNCATE, TYPE_DIR, type StatBuf } from "../src/tinyfs.ts";
import { Mulberry32 } from "./fuzzer.ts";

let tfs : TinyFS;

function charsFromBytes(bytes : Uint8Array) : string
{
    let s : string = "";

    for (let i = 0; i < bytes.length; i++)
    {
        const b : number = bytes[i]!;

        if (b >= 32 && b <= 126)
            s += String.fromCharCode(b);
    }

    return s;
}

function arraysEqual(a : Uint8Array, b : Uint8Array) : boolean
{
    if (a.length !== b.length)
        return false;

    for (let i = 0; i < a.length; i++)
    {
        if (a[i] !== b[i])
            return false;
    }

    return true;
}

function formatBytes(bytes : Uint8Array) : string
{
    let s : string = "[";

    for (let i = 0; i < Math.min(bytes.length, 48); i++)
    {
        if (i > 0)
            s += ", ";

        s += String(bytes[i]);
    }

    if (bytes.length > 48)
        s += ", ... (" + bytes.length + " bytes)";

    s += "]";
    return s;
}

// Each operation is laid out as a variable-length byte sequence:
//
//   byte  0      : opcode (0-7)
//   byte  1      : path_len (includes own byte, min 1 for str "/" via fallback)
//   bytes 2..N   : path content (N = 1 + path_len - 1, clipped to input bounds)
//                   Empty -> "/" after char-filtering.
//   optional... : per-opcode extra data
//
//   opcode >= 8  : END (stop decoding)
//
//   Opcodes:
//     0 MKDIR  path
//     1 CREAT  path                          (open CREATE|READ_WRITE + close)
//     2 WRITE  path  fill:1  count:1         (write count+1 bytes of fill)
//     3 READ   path                          (read + verify against shadow)
//     4 UNLINK path
//     5 RMDIR  path
//     6 TRUNC  path                          (open TRUNCATE|READ_WRITE + close)
//     7 LINK   path  path2...               (hard link)

function idbReq<T>(
    req : IDBRequest<T>
) : Promise<T>
{
    return new Promise<T>((resolve, reject) => {
        req.onsuccess = () : void  => resolve(req.result);
        req.onerror   = () : void  => reject(req.error);
    });
}

async function resetFs () : Promise<void>
{
    for (let i = 0; i < tfs.max_fd; i++)
    {
        if (tfs.fd_table[i]!.used)
            tfs.close(i);
    }

    tfs.dcache.clear();

    const tx : IDBTransaction = tfs.fs_db!.transaction([ STORE_INODES, STORE_BLOCKS ], "readwrite");

    await idbReq(tx.objectStore(STORE_BLOCKS).clear());

    const inodes : IDBObjectStore = tx.objectStore(STORE_INODES);
    const keys   : IDBValidKey[]  = await idbReq<IDBValidKey[]>(inodes.getAllKeys());

    for (const key of keys)
    {
        if (key !== ROOT_INODE)
            inodes.delete(key);
    }

    await idbReq(inodes.put({
        id:      ROOT_INODE as number,
        mode:    TYPE_DIR | 0o755,
        nlink:   1,
        size:    0,
        entries: {}
    }));

    await new Promise<void>((resolve, reject) =>
    {
        tx.oncomplete = () : void => resolve();
        tx.onerror    = () : void => reject(tx.error);
    });
}

async function runSequence (
    input : Uint8Array
) : Promise<string | null>
{
    await resetFs();

    const field_data : Map<string, Uint8Array> = new Map<string, Uint8Array>();
    const labels     : Array<string>           = ["MKDIR", "CREAT", "WRITE", "READ ", "UNLINK", "RMDIR", "TRUNC", "LINK "];

    let i : number = 0;

    while (i < input.length)
    {
        const opcode : number = input[i]!;
        i += 1;

        if (opcode >= 8)
            break;

        if (i >= input.length)
            return null;

        const plen : number = input[i]!;
        i += 1;

        if (plen < 1)
            return null;

        const end     : number               = Math.min(i + plen - 1, input.length);
        const pathRaw : Uint8Array           = input.subarray(i, end);
        i                                     = end;

        let p : string = charsFromBytes(pathRaw);

        if (p.length === 0)
            p = "/";
        else
            p = "/" + p;

        const opName : string = opcode < labels.length ? labels[opcode]! : `OP${opcode}`;

        try
        {
            switch (opcode)
            {
                case 0:
                {
                    await tfs.mkdir(p);
                    break;
                }

                case 1:
                {
                    const fd : number = await tfs.open(p, CREATE | READ_WRITE);

                    if (fd >= 0)
                    {
                        if (!field_data.has(p))
                            field_data.set(p, new Uint8Array(0));

                        tfs.close(fd);
                    }

                    break;
                }

                case 2:
                {
                    const fill  : number = i < input.length ? input[i]! : 0;
                    i += 1;

                    const count : number = Math.min(i < input.length ? input[i]! + 1 : 1, 8192);
                    i += 1;

                    const fd : number = await tfs.open(p, READ_WRITE);

                    if (fd < 0)
                        break;

                    const data : Uint8Array = new Uint8Array(count).fill(fill);
                    const nw   : number    = await tfs.write(fd, data, count);
                    tfs.close(fd);

                    if (nw !== count)
                        return `${opName} "${p}": write returned ${nw}, expected ${count}`;

                    field_data.set(p, data);

                    const sb : StatBuf = { size: 0, mode: 0, nlink: 0 };
                    const sr : number     = await tfs.stat(p, sb);

                    if (sr < 0)
                        return `${opName} "${p}": stat failed after write`;

                    if (sb.size !== count)
                        return `${opName} "${p}": stat size=${sb.size} after writing ${count} bytes`;

                    break;
                }

                case 3:
                {
                    const expected : Uint8Array | undefined = field_data.get(p);

                    if (expected === undefined)
                        break;

                    const fd : number = await tfs.open(p, READ);

                    if (fd < 0)
                        return `${opName} "${p}": open failed for expected file`;

                    const buf : Uint8Array = new Uint8Array(expected.length);
                    const nr  : number     = await tfs.read(fd, buf, buf.length);
                    tfs.close(fd);

                    if (nr !== expected.length)
                        return `${opName} "${p}": read ${nr} bytes, expected ${expected.length}`;

                    if (!arraysEqual(buf, expected))
                        return `${opName} "${p}": data mismatch`;

                    break;
                }

                case 4:
                {
                    await tfs.unlink(p);
                    field_data.delete(p);
                    break;
                }

                case 5:
                {
                    await tfs.rmdir(p);
                    break;
                }

                case 6:
                {
                    const fd : number = await tfs.open(p, TRUNCATE | READ_WRITE);

                    if (fd >= 0)
                    {
                        field_data.set(p, new Uint8Array(0));
                        tfs.close(fd);

                        const sb : StatBuf = { size: 0, mode: 0, nlink: 0 };
                        const sr : number     = await tfs.stat(p, sb);

                        if (sr < 0)
                            return `${opName} "${p}": stat failed after truncate`;

                        if (sb.size !== 0)
                            return `${opName} "${p}": stat size=${sb.size} after truncate, expected 0`;
                    }

                    break;
                }

                case 7:
                {
                    if (i >= input.length)
                        return null;

                    const plen_2 : number = input[i]!;
                    i += 1;

                    if (plen_2 < 1)
                        return null;

                    const end_2  : number     = Math.min(i + plen_2 - 1, input.length);
                    const raw_2  : Uint8Array = input.subarray(i, end_2);

                    i = end_2;

                    let p_2 : string = charsFromBytes(raw_2);

                    if (p_2.length === 0)
                        p_2 = "/";
                    else
                        p_2 = "/" + p_2;

                    await tfs.link(p, p_2);

                    const src : Uint8Array | undefined = field_data.get(p);

                    if (src !== undefined)
                        field_data.set(p_2, new Uint8Array(src));

                    break;
                }
            }
        }
        catch (e)
        {
            return `${opName} "${p}": exception: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    return null;
}

// Wrapper for shrink functions that expect a synchronous-ish boolean check
function wrapCheck (
    checkFn : (input: Uint8Array) => Promise<string | null>
) : (input: Uint8Array) => Promise<boolean>
{
    return async (input : Uint8Array) => (await checkFn(input)) === null;
}

async function testFailAsync (
    bytes   : Uint8Array,
    checkFn : (b: Uint8Array) => Promise<boolean>
) : Promise<boolean>
{
    return !(await checkFn(bytes));
}

async function shrinkRemoveChunksAsync (
    bytes    : Uint8Array,
    testFail : (candidate: Uint8Array) => Promise<boolean>
) : Promise<Uint8Array>
{
    let arr : number[] = Array.from(bytes);
    let n   : number   = arr.length;
    let k   : number   = 2;

    while (n >= 1)
    {
        const chunk_size : number = Math.ceil(n / k);
        let removed      : boolean = false;

        for (let i = 0; i < n; i += chunk_size)
        {
            const candidate : number[] = arr.slice(0, i).concat(arr.slice(Math.min(n, i + chunk_size)));

            if (candidate.length === arr.length)
                continue;

            const candidateU8 : Uint8Array = new Uint8Array(candidate);

            if (await testFail(candidateU8))
            {
                arr     = candidate;
                n       = arr.length;
                k       = 2;
                removed = true;

                break;
            }
        }

        if (!removed)
        {
            if (chunk_size === 1)
                break;

            k = Math.min(n || 1, k * 2);
        }
    }

    return new Uint8Array(arr);
}

async function shrinkByteValuesAsync (
    bytes    : Uint8Array,
    testFail : (candidate: Uint8Array) => Promise<boolean>
) : Promise<Uint8Array>
{
    const data : Uint8Array = new Uint8Array(bytes);

    for (let i = 0; i < data.length; i++)
    {
        const original : number = data[i]!;

        if (original === 0)
            continue;

        data[i] = 0;

        if (await testFail(data))
            continue;

        data[i] = original;

        let low  : number = 0;
        let high : number = original;

        while (high - low > 1)
        {
            const mid : number = (low + high) >>> 1;
            data[i]             = mid;

            if (await testFail(data))
                high = mid;
            else
                low = mid;
        }

        data[i] = high;
    }

    return data;
}

async function shrinkCounterexampleAsync(
    initial_bytes : Uint8Array,
    checkFn       : (input: Uint8Array) => Promise<boolean>
) : Promise<Uint8Array>
{
    const tF = (candidate : Uint8Array) : Promise<boolean> => testFailAsync(candidate, checkFn);

    if (!(await tF(initial_bytes)))
        return initial_bytes;

    let current : Uint8Array = new Uint8Array(initial_bytes);
    let changed : boolean   = true;
    let rounds  : number    = 0;

    while (changed && rounds < 8)
    {
        changed = false;
        rounds++;

        const afterChunks : Uint8Array = await shrinkRemoveChunksAsync(current, tF);

        if (afterChunks.length < current.length)
        {
            current = afterChunks;
            changed = true;
        }

        const afterValues : Uint8Array = await shrinkByteValuesAsync(current, tF);

        if (!arraysEqual(afterValues, current))
        {
            current = afterValues;
            changed = true;
        }
    }

    return current;
}

async function decodeTrace(input : Uint8Array) : Promise<string>
{
    const labels : string[] = ["MKDIR", "CREAT", "WRITE", "READ ", "UNLINK", "RMDIR", "TRUNC", "LINK "];
    let result   : string   = "";
    let i        : number   = 0;

    while (i < input.length)
    {
        const opcode : number = input[i]!;
        i += 1;

        if (opcode >= 8)
        {
            result += `  END (opcode=${opcode})\n`;
            break;
        }

        const label : string = opcode < labels.length ? labels[opcode]! : `OP${opcode}`;

        if (i >= input.length)
        {
            result += `  ${label} (truncated at path_len)\n`;
            break;
        }

        const plen : number = input[i]!;
        i += 1;

        if (plen < 1)
        {
            result += `  ${label} (invalid path_len=${plen})\n`;
            break;
        }

        const end : number     = Math.min(i + plen - 1, input.length);
        const raw : Uint8Array = input.subarray(i, end);
        i                       = end;

        let p : string = charsFromBytes(raw);

        if (p.length === 0)
            p = "/";
        else
            p = "/" + p;

        result += `  ${label} "${p}"`;

        if (opcode === 2)
        {
            const fill  : number = i < input.length ? input[i]! : 0;
            const count : number = i + 1 < input.length ? input[i + 1]! + 1 : 1;

            result += `  fill=0x${fill.toString(16).padStart(2, "0")} count=${count}`;
        }

        if (opcode === 7)
        {
            if (i < input.length)
            {
                const plen_2 : number = input[i]!;
                i += 1;

                if (plen_2 >= 1)
                {
                    const end_2 : number     = Math.min(i + plen_2 - 1, input.length);
                    const r_2   : Uint8Array = input.subarray(i, end_2);
                    i                         = end_2;

                    let p_2 : string = charsFromBytes(r_2);

                    if (p_2.length === 0)
                        p_2 = "/";
                    else
                        p_2 = "/" + p_2;

                    result += ` -> "${p_2}"`;
                }
            }
        }

        result += "\n";

        // If we consumed nothing, break
        if (i >= input.length && opcode !== 7)
            break;
    }

    return result;
}

async function main() : Promise<void>
{
    tfs = await TinyFS.create("tinyfs");

    const MAX_LEN : number = 256;
    const TIME_MS : number = 900000;

    let seed : number;

    const seed_arg_idx : number = process.argv.indexOf("--seed");

    if (seed_arg_idx >= 0 && seed_arg_idx + 1 < process.argv.length)
        seed = parseInt(process.argv[seed_arg_idx + 1]!, 16) >>> 0;
    else
        seed = ((Date.now() ^ ((Math.random() * 0x7fffffff) >>> 0)) >>> 0);

    const rng = new Mulberry32(seed);

    console.log(`fuzz: seed=0x${seed.toString(16).padStart(8, "0")}  time_ms=${TIME_MS}  max_len=${MAX_LEN}`);

    const start    : number = performance.now();
    let tests_run  : number = 0;

    while (performance.now() - start < TIME_MS)
    {
        const r : number = rng.next();

        let len : number;

        if (MAX_LEN <= 0)
            len = 0;
        else if (r < 0.8)
            len = Math.min(MAX_LEN, Math.floor(rng.next() * Math.min(MAX_LEN + 1, 32)));
        else
            len = Math.floor(rng.next() * (MAX_LEN + 1));

        const buf : Uint8Array = new Uint8Array(len);

        const use_pattern : boolean = (len >= 3 && rng.next() < 0.10);

        for (let j = 0; j < len; j++)
            buf[j] = (rng.next() * 256) | 0;

        if (use_pattern && len >= 3)
        {
            const base : number = Math.floor(rng.next() * 253);
            const pos  : number = Math.floor(rng.next() * (len - 2));

            buf[pos + 0] = base + 0;
            buf[pos + 1] = base + 1;
            buf[pos + 2] = base + 2;
        }

        tests_run++;

        const err : string | null = await runSequence(buf);

        if (err !== null)
        {
            const elapsed : number = Math.round(performance.now() - start);

            console.log(`\nFAIL after ${tests_run} tests in ${elapsed}ms`);
            console.log(`error: ${err}`);
            console.log(`counterexample (${buf.length} bytes) : ${formatBytes(buf)}`);

            console.log("\n--- trace ---");
            process.stdout.write(await decodeTrace(buf));

            console.log("\nshrinking...");

            const check_bool : (input: Uint8Array) => Promise<boolean> = wrapCheck(runSequence);
            const shrunk     : Uint8Array                              = await shrinkCounterexampleAsync(buf, check_bool);

            console.log(`shrunk to ${shrunk.length} bytes: ${formatBytes(shrunk)}`);

            console.log("\n--- minimal trace ---");
            process.stdout.write(await decodeTrace(shrunk));

            process.exit(1);
        }
    }

    const duration : number = Math.round(performance.now() - start);
    console.log(`\nok -- ${tests_run} tests passed in ${duration}ms`);
}

await main();
