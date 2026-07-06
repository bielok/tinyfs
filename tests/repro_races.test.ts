import { test, expect } from "bun:test";
import "fake-indexeddb/auto";
import { TinyFS } from "../src/tinyfs.ts";
import type { StatBuf } from "../src/tinyfs.ts";

test("Bug 2: stale _dcache returns -1 for file recreated by another tab", async () => {
    const dbName = `bug2_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const tfsA = await TinyFS.create(dbName);
    await tfsA.mkdir("/d");
    const fdA = await tfsA.open("/d/f", tfsA.CREATE | tfsA.READ_WRITE);
    await tfsA.write(fdA, new Uint8Array([1, 2, 3]), 3);
    tfsA.close(fdA);

    const sb1: StatBuf = { size: 0, mode: 0, nlink: 0 };
    expect(await tfsA.stat("/d/f", sb1)).toBe(0);

    const tfsB = await TinyFS.create(dbName);
    await tfsB.unlink("/d/f");
    const fdB = await tfsB.open("/d/f", tfsB.CREATE | tfsB.READ_WRITE);
    await tfsB.write(fdB, new Uint8Array([4, 5, 6]), 3);
    tfsB.close(fdB);

    const sb2: StatBuf = { size: 0, mode: 0, nlink: 0 };
    const ret = await tfsA.stat("/d/f", sb2);

    expect(ret).toBe(0); // BUG: returns -1 (stale cache entry)
});

test("Bug 3: concurrent read on same fd reads overlapping data", async () => {
    const dbName = `bug3_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const tfs = await TinyFS.create(dbName);

    const data = new Uint8Array(10);
    for (let i = 0; i < data.length; i++) data[i] = i + 1;

    const fd = await tfs.open("/f", tfs.CREATE | tfs.READ_WRITE);
    await tfs.write(fd, data, data.length);
    await tfs.lseek(fd, 0, tfs.SET);

    const buf1 = new Uint8Array(10);
    const buf2 = new Uint8Array(10);

    const [n1, n2] = await Promise.all([
        tfs.read(fd, buf1, 10),
        tfs.read(fd, buf2, 10),
    ]);

    expect(n1).toBe(10);
    expect(n2).toBe(0); // BUG: returns 10 (both read at offset 0)
});

// Bug 1 (fd slot reuse) requires real browser concurrency with separate event
// loops (tabs/workers) to trigger.  fake-indexeddb resolves all IDB operations
// in FIFO microtask order within a single event loop, so close+open always
// completes its path resolution and fd allocation AFTER any in-flight
// read/write has already finished.  The race is theoretically real — the
// shared fd_table object reference captured at line 854/917 is mutable across
// await points but it cannot be exercised under fake-indexeddb.
//
// Reproduction requires the existing browser-based concurrency tests:
//   tests/browser.concurrency.test.ts
//   tests/browser.atomicity.test.ts
