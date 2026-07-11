import "fake-indexeddb/auto";
import { O, ROOT_INODE, STORE_BLOCKS, STORE_INODES, TinyFS } from "../src/tinyfs.ts";
import type { StatBuf } from "../src/tinyfs.ts";
import { fuzz } from "./fuzzer.ts";

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
//     1 CREAT  path                          (open CREATE|O.READ_WRITE + close)
//     2 WRITE  path  fill:1  count:1         (write count+1 bytes of fill)
//     3 READ   path                          (read + verify against shadow)
//     4 UNLINK path
//     5 RMDIR  path
//     6 TRUNC  path                          (open TRUNCATE|O.READ_WRITE + close)
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
        mode:    O.TYPE_DIR | 0o755,
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
                    const fd : number = await tfs.open(p, O.CREATE | O.READ_WRITE);

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

                    const fd : number = await tfs.open(p, O.READ_WRITE);

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

                    const fd : number = await tfs.open(p, O.READ);

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
                    const fd : number = await tfs.open(p, O.TRUNCATE | O.READ_WRITE);

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

    let seed : number | string | undefined;

    const seed_arg_idx : number = process.argv.indexOf("--seed");

    if (seed_arg_idx >= 0 && seed_arg_idx + 1 < process.argv.length)
        seed = parseInt(process.argv[seed_arg_idx + 1]!, 16) >>> 0;

    const result = await fuzz(
        async (input) => (await runSequence(input)) === null,
        { seed, max_len: MAX_LEN, time_ms: TIME_MS }
    );

    console.log(`fuzz: seed=0x${result.seed.toString(16).padStart(8, "0")}  time_ms=${TIME_MS}  max_len=${MAX_LEN}`);

    if (!result.ok)
    {
        console.log(`\nFAIL after ${result.num_tests_run} tests in ${result.duration_ms}ms`);
        console.log(`error: ${result.error}`);
        console.log(`counterexample (${result.counterex!.length} bytes) : ${formatBytes(result.counterex!)}`);

        console.log("\n--- trace ---");
        process.stdout.write(await decodeTrace(result.counterex!));

        console.log(`\nshrunk to ${result.shrunk_counterex!.length} bytes: ${formatBytes(result.shrunk_counterex!)}`);

        console.log("\n--- minimal trace ---");
        process.stdout.write(await decodeTrace(result.shrunk_counterex!));

        process.exit(1);
    }

    console.log(`\nok -- ${result.num_tests_run} tests passed in ${result.duration_ms}ms`);
}

await main();
