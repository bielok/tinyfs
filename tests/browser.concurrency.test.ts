// Concurrency tests.
//
// These tests use two Puppeteer pages (tabs) connected to the same IndexedDB
// database to verify that tinyfs behaves correctly under concurrent access.
//
// Key architectural point: both tabs share a single IndexedDB database on the
// same origin. Each tab has its own heap, so fd_table, dcache, and next_fd ar
// per-tab and independent. The only shared state lives in IndexedDB: inodes,
// directory entries, and data blocks.
//
// Transaction mechanics:
//
//   Every readwrite transaction in tinyfs does one of two things:
//     (a) opens a single readwrite transaction per call (open, write,
//         unlink, mkdir, rmdir, link, rename), or
//     (b) for stat/open, opens a readonly transaction.
//   IndexedDB serialises readwrite transactions per database. Only one write
//   transaction can be active at a time. Microtask-based coordination between
//   the two tabs is therefore unnecessary: IDB provides serialisation
//   automatically.
//
//   However, between the creation of a transaction and its first IDB request,
//   the following sequence can be interrupted by a microtask from the other
//   tab. This means that two tabs can both start a write transaction, both
//   read an inode (seeing the same state), and then both attempt to modify it.
//   The second transaction's modifications will silently overwrite the first's
//   at the block level (last-writer-wins), but structural invariants
//   (directory entry uniqueness, nlink counts) may be violated.
//
//   Each test below documents which of these scenarios it exercises.

import puppeteer, { Browser, Page } from "puppeteer-core";
import { test, expect, beforeAll, afterAll } from "bun:test";

declare var tfs : any;

let browser  : Browser | null = null;
let page_a   : Page | null    = null;
let page_b   : Page | null    = null;
let server   : any            = null;

beforeAll(async () =>
{
    server = Bun.serve({
        port: 0,
        async fetch (req : Request) : Promise<Response>
        {
            const url  = new URL(req.url);
            const file = Bun.file("." + url.pathname);

            if (!await file.exists())
                return new Response("not found", { status: 404 });

            return new Response(file);
        },
    });

    browser = await puppeteer.launch({
        headless: !process.env.NO_HEADLESS,
        channel: 'chrome',
        args: ["--no-sandbox", "--disable-web-security"],
    });

    page_a = await browser.newPage();
    page_b = await browser.newPage();

    const url = `http://localhost:${server.port}/tests/browser-concurrency.html`;

    await page_a.goto(url);
    await page_b.goto(url);

    await page_a.waitForFunction("typeof window.tinyfs !== 'undefined'");
    await page_b.waitForFunction("typeof window.tinyfs !== 'undefined'");

    await Promise.all([
        page_a.evaluate(async () => {
            const { TinyFS } = window.tinyfs;
            window.tfs = await TinyFS.create("tinyfs");
        }),
        page_b.evaluate(async () => {
            const { TinyFS } = window.tinyfs;
            window.tfs = await TinyFS.create("tinyfs");
        }),
    ]);
});

afterAll(async () =>
{
    if (browser)
        await browser.close();

    if (server)
        server.stop();
});

// Helper: evaluate in a page and expect null return.

async function evalExpect (page : Page, fn : () => Promise<any>, name : string) : Promise<void>
{
    const result = await page.evaluate(fn);
    expect(result, name).toBeNull();
}

// Test 1: Cross-tab write/read visibility.
//
// Verifies that data written in one tab is immediately visible in another.
// Page A creates /con and writes "ABC" in a single synchronous sequence
// (open -> write -> close, all within one page.evaluate). This guarantees
// the transaction completes before Page B's evaluate fires.
//
// Page B then opens /con, reads, and returns the bytes. Because Page A's
// write transaction committed before Page B's read transaction begins, Page B
// sees "ABC". (Readonly transactions are not serialised, but writes are, so
// the write committed before the read started.)
//
// The reverse direction is tested next: Page B appends "DEF" (its own write
// transaction), then Page A reopens and reads. Again, the write committed
// before Page A's read transaction, so Page A sees "ABCDEF" through a fresh
// open call.
//
// Key insight: there is no shared in-memory cache between tabs. Each open()
// traverses the path from root via IDB, so every read reads committed data.
// _dcache is per-tab and scoped to a single page.evaluate call's lifetime in
// these tests. The only way one tab sees another's writes is through
// IndexedDB itself, which correctly serialises transactions.

test("cross-tab write/read visibility", async () => {
    // Page A creates a file and writes "ABC".

    await evalExpect(page_a!, async () => {
        const { O } = window.tinyfs;
        const fd = await tfs.open("/con", O.CREATE | O.READ_WRITE);
        await tfs.write(fd, new Uint8Array([65, 66, 67]), 3);
        tfs.close(fd);
        return null;
    }, "pageA create/write");

    // Page B opens and reads -> "ABC".

    const fromB = await page_b!.evaluate(async () => {
        const { O } = window.tinyfs;
        const fd  = await tfs.open("/con", O.READ);
        const buf = new Uint8Array(10);
        const nr  = await tfs.read(fd, buf, 10);
        tfs.close(fd);
        return Array.from(buf.slice(0, nr));
    });

    expect(fromB).toEqual([65, 66, 67]);

    // Page B appends "DEF".

    await evalExpect(page_b!, async () => {
        const { O } = window.tinyfs;
        const fd = await tfs.open("/con", O.READ_WRITE);
        await tfs.lseek(fd, 0, O.END);
        await tfs.write(fd, new Uint8Array([68, 69, 70]), 3);
        tfs.close(fd);
        return null;
    }, "pageB append");

    // Page A reopens and reads -> "ABCDEF".

    const fromA = await page_a!.evaluate(async () => {
        const { O } = window.tinyfs;
        const fd  = await tfs.open("/con", O.READ);
        const buf = new Uint8Array(10);
        const nr  = await tfs.read(fd, buf, 10);
        tfs.close(fd);
        return Array.from(buf.slice(0, nr));
    });

    expect(fromA).toEqual([65, 66, 67, 68, 69, 70]);
});

// Test 2: Simultaneous multi-block write: no torn data.
//
// Starts two write transactions from two tabs at nearly the same instant
// (Promise.all over two page.evaluate calls). Each writes 5000 bytes to the
// same file at offset 0, which requires two 4096-byte blocks.
//
// IDB serialises readwrite transactions per database, so the two writes run
// sequentially, not concurrently. The second write's blocks and inode
// completely overwrite the first's. The result must be uniform: either every
// byte is 0x41 (first writer won) or every byte is 0x42 (second writer won).
// A torn result (first half 0x41, second half 0x42, or vice versa) would
// indicate that block writes from different transactions interleaved, which
// IDB guarantees cannot happen.
//
// This test documents the guarantee rather than asserting it will fail.
// If IDB transaction serialisation were broken, this test would catch it.

test("simultaneous multi-block write produces no torn data", async () =>
{
    // Create file.

    await evalExpect(page_a!, async () => {
        const { O } = window.tinyfs;
        const fd   = await tfs.open("/simul", O.CREATE | O.READ_WRITE);
        tfs.close(fd);
        return null;
    }, "create /simul");

    // Both pages write 5000 bytes (2 blocks) in parallel.

    const [rA, rB] = await Promise.all([
         page_a!.evaluate(async () => {
            const { O } = window.tinyfs;

            const fd   = await tfs.open("/simul", O.READ_WRITE);
            const data = new Uint8Array(5000).fill(0x41);
            const nw   = await tfs.write(fd, data, 5000);

            tfs.close(fd);
            return nw;
        }),
        page_b!.evaluate(async () => {
            const { O } = window.tinyfs;

            const fd   = await tfs.open("/simul", O.READ_WRITE);
            const data = new Uint8Array(5000).fill(0x42);
            const nw   = await tfs.write(fd, data, 5000);

            tfs.close(fd);
            return nw;
        }),
    ]);

    expect(rA).toBe(5000);
    expect(rB).toBe(5000);

    // Read back: every byte must be 0x41 or every byte 0x42.

    const bytes = await page_a!.evaluate(async () => {
        const { O } = window.tinyfs;
        const fd  = await tfs.open("/simul", O.READ);
        const buf = new Uint8Array(5000);
        const nr  = await tfs.read(fd, buf, 5000);

        tfs.close(fd);
        return Array.from(buf.slice(0, nr));
    });

    const allA : boolean = bytes.every(b => b === 0x41);
    const allB : boolean = bytes.every(b => b === 0x42);

    expect(allA || allB).toBe(true);
});

// Test 3: Stale fd after cross-tab unlink.
//
// Page A opens /shared and keeps the fd open. Page B unlinks /shared.
// tinyfs's unlink deletes the inode and blocks from IDB when nlink reaches 0
// (src/tfs.ts:649-653), regardless of whether any fd in any tab still
// references it. This differs from Unix semantics (open fd keeps inode alive)
// but is the current implementation.
//
// Page A then seeks and reads on the stale fd. The read() finds the fd slot
// in fd_table, but getInode returns null (the inode was deleted), so read()
// returns -1.
//
// Page A closes the stale fd (frees the local fd_table slot). A subsequent
// stat by path returns -1 because the root directory no longer has an entry
// for /shared.

test("stale fd returns -1 after unlink from another tab", async () => {
    // Page A opens /shared, writes data, keeps fd open.

    const fd : number = await page_a!.evaluate(async () => {
        const { O } = window.tinyfs;
        const f = await tfs.open("/shared", O.CREATE | O.READ_WRITE);
        await tfs.write(f, new Uint8Array([65, 66, 67]), 3);
        return f;
    });

    // Page B unlinks /shared.

    await evalExpect(page_b!, async () => {
        const ret = await tfs.unlink("/shared");
        if (ret !== 0)
            return "unlink returned " + ret;
        return null;
    }, "pageB unlink");

    // Page A seeks and reads on stale fd -> -1 (inode gone).

    const nr : number = await page_a!.evaluate(async (f : number) => {
        const { O } = window.tinyfs;
        await tfs.lseek(f, 0, O.SET);
        const buf = new Uint8Array(10);
        return await tfs.read(f, buf, 10);
    }, fd);

    expect(nr).toBe(-1);

    // Page A closes stale fd -> 0 (fd slot freed in local table).

    const closeRet : number = await page_a!.evaluate(async (f : number) => {
        return tfs.close(f);
    }, fd);

    expect(closeRet).toBe(0);

    // Check that file is gone.

    await evalExpect(page_a!, async () => {
        const sb  = { size: 0, mode: 0, nlink: 0 };
        const ret = await tfs.stat("/shared", sb);

        if (ret !== -1)
            return "stat should return -1 got " + ret;

        return null;
    }, "stat /shared gone");
});

// Test 4: Concurrent mkdir: only one succeeds.
//
// Both tabs fire mkdir("/con_race") at nearly the same instant via
// Promise.all. Each mkdir opens its own readwrite transaction. IDB
// serialises the two write transactions.
//
// The first transaction to run reads the root inode (no "con_race" entry),
// creates a new inode, and writes the root entry. The second transaction
// then reads the root inode -- now with "con_race" present -- and returns -1
// (EEXIST). Exactly one tab gets 0, the other gets -1.
//
// If IDB serialisation were absent or broken, both transactions could read
// the root inode before either writes, and both would "succeed", creating a
// corrupted directory structure. The stat at the end confirms the directory
// exists and is of type TYPE_DIR.

test("concurrent mkdir race -- exactly one succeeds", async () => {
    const [rA, rB] = await Promise.all([
        page_a!.evaluate(async () => await tfs.mkdir("/con_race")),
        page_b!.evaluate(async () => await tfs.mkdir("/con_race")),
    ]);

    // One must succeed, the other must fail.

    expect(rA === 0 || rA === -1).toBe(true);
    expect(rB === 0 || rB === -1).toBe(true);
    expect(rA).not.toBe(rB);

    // Verify the directory exists (stat succeeds).

    await evalExpect(page_a!, async () => {
        const { O } = window.tinyfs;

        const sb  = { size: 0, mode: 0, nlink: 0 };
        const ret = await tfs.stat("/con_race", sb);

        if (ret !== 0)
            return "stat returned " + ret;

        if ((sb.mode & O.TYPE_MASK) !== O.TYPE_DIR)
            return "not a directory";

        return null;
    }, "stat /con_race");
});

// Test 5: FD slot reuse within a single tab.
//
// Page A creates /orig with multi-block data, opens it with APPEND|WRITE,
// and starts an in-flight write.  Before the write finishes, Page A closes
// the fd and opens /other which reuses the same fd_table slot.  The
// original write's continuation then runs with a stale f_obj reference,
// potentially using /other's offset or flags instead of /orig's.
//
// Scenario: /orig has 10 000 bytes of 0xAA.  The APPEND write should add
// 50 000 bytes of 0xBB starting at offset 10 000.  If the reuse race
// fires, the APPEND flag check at line 979 reads f_obj.flags from the
// reassigned slot (which has no APPEND flag), so file_offset stays at 0
// and the write overwrites /orig's start instead of appending.
// Subsequently, /orig's size check at line 964 uses the wrong offset too,
// so inode.size is underreported.
//
// The race window: open() needs ~5 async IDB hops before reaching fd
// allocation.  write() has 13 block operations (50 KB = 13 blocks).
// With real IDB (macrotask-based events), open's fd allocation can
// interleave between write's block writes.

test("fd slot reuse during append write corrupts data", async () => {
    // Set up /orig with 10 000 bytes of 0xAA.

    await evalExpect(page_a!, async () => {
        const { O } = window.tinyfs;
        const fd = await tfs.open("/orig", O.CREATE | O.READ_WRITE);
        await tfs.write(fd, new Uint8Array(10000).fill(0xAA), 10000);
        tfs.close(fd);
        return null;
    }, "create /orig");

    // Run the race.
    // Each iteration creates fresh /other (unique suffix) so previous runs
    // don't carry state.  /orig always starts at ~10 000 (setup).  After the
    // race it should be 60 000.  If APPEND was lost due to fd slot reuse,
    // the write overwrote from offset 0 and the size is wrong.

    for (let iter = 0; iter < 10; iter++)
    {
        const suffix : string = iter.toString();

        const result : string | null = await page_a!.evaluate(async (s : string) => {
            const { O } = window.tinyfs;

            // Ensure /orig is at its baseline 10 000 bytes.
            // (Recreate it if a prior iteration left it larger.)

            const checkSb = { size: 0, mode: 0, nlink: 0 };
            await tfs.stat("/orig", checkSb);

            if (checkSb.size !== 10000)
            {
                // Previous iteration corrupted /orig recreate.

                await tfs.unlink("/orig");
                const reFd = await tfs.open("/orig", O.CREATE | O.READ_WRITE);
                await tfs.write(reFd, new Uint8Array(10000).fill(0xAA), 10000);
                tfs.close(reFd);
            }

            const fd = await tfs.open("/orig", O.APPEND | O.WRITE);

            const appendSize = 50000;
            const appendData = new Uint8Array(appendSize);
            for (let i = 0; i < appendSize; i++)
                appendData[i] = (i * 197 + 53) & 0xFF;

            const writePromise = tfs.write(fd, appendData, appendSize);

            tfs.close(fd);
            const fd2 = await tfs.open("/other_" + s, O.CREATE | O.READ_WRITE);
            await tfs.write(fd2, new Uint8Array([0xFF]), 1);

            await writePromise;

            // /orig should be 60 000.

            const sb = { size: 0, mode: 0, nlink: 0 };
            await tfs.stat("/orig", sb);

            if (sb.size !== 60000)
                return "size: expected 60000 got " + sb.size
                    + " iter=" + s
                    + " slot=" + JSON.stringify(tfs.fd_table[fd2]!);

            // /other should be intact.

            const otherFd = await tfs.open("/other_" + s, O.READ);
            const otherBuf = new Uint8Array(1);
            await tfs.read(otherFd, otherBuf, 1);
            tfs.close(otherFd);

            if (otherBuf[0] !== 0xFF)
                return "/other: expected 0xFF got " + otherBuf[0];

            return null;
        }, suffix);

        if (result !== null)
        {
            expect(result).toBeNull();
            return;
        }
    }
});

