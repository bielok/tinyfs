import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import "fake-indexeddb/auto";
import { TinyFS } from "../src/tinyfs.ts";
import type { StatBuf, DirEnt } from "../src/tinyfs.ts";

let tfs : TinyFS;

beforeAll(async () => {
    tfs = await TinyFS.create("tinyfs");
});

beforeEach(() => {
    for (let i = 0; i < tfs.max_fd; i++)
    {
        if (tfs.fd_table[i]!.used)
            tfs.close(i);
    }

    tfs._dcache.clear();
});

describe("stat", () => {
    test("should stat root directory", async () => {
        const buf : StatBuf = { size: 0, mode: 0, nlink: 0 };
        const ret : number  = await tfs.stat("/", buf);

        expect(ret).toBe(0);
        expect(buf.mode & tfs.TYPE_MASK).toBe(tfs.TYPE_DIR);
        expect(buf.nlink).toBe(1);
    });

    test("should return -1 for nonexistent path", async () => {
        const buf : StatBuf = { size: 0, mode: 0, nlink: 0 };
        const ret               = await tfs.stat("/nonexistent", buf);

        expect(ret).toBe(-1);
    });

    test("should stat a newly created directory", async () => {
        await tfs.mkdir("/mydir");

        const buf : StatBuf = { size: 0, mode: 0, nlink: 0 };
        const ret               = await tfs.stat("/mydir", buf);

        expect(ret).toBe(0);
        expect(buf.mode & tfs.TYPE_MASK).toBe(tfs.TYPE_DIR);
    });
});

describe("mkdir / rmdir", () => {
    test("should create and remove a directory", async () => {
        let ret : number = await tfs.mkdir("/d");
        expect(ret).toBe(0);

        ret = await tfs.rmdir("/d");
        expect(ret).toBe(0);
    });

    test("should fail to remove non-empty directory", async () => {
        await tfs.mkdir("/d");
        await tfs.mkdir("/d/e");

        const ret : number = await tfs.rmdir("/d");
        expect(ret).toBe(-1);
    });

    test("should fail to remove nonexistent directory", async () => {
        const ret : number = await tfs.rmdir("/nope");
        expect(ret).toBe(-1);
    });
});

describe("open / close", () => {
    test("should open a file with CREATE", async () => {
        const fd : number = await tfs.open("/f", tfs.CREATE | tfs.READ_WRITE);
        expect(fd).not.toBe(-1);
        expect(fd).toBeGreaterThanOrEqual(0);
        expect(tfs.fd_table[fd]!.used).toBe(true);

        const ret : number = tfs.close(fd);
        expect(ret).toBe(0);
    });

    test("should return -1 for close on invalid fd", () => {
        expect(tfs.close(-1)).toBe(-1);
        expect(tfs.close(999)).toBe(-1);
        expect(tfs.close(tfs.max_fd)).toBe(-1);
    });

    test("CREATE | EXCLUSIVE should fail on existing file", async () => {
        const fd_1 : number = await tfs.open("/f", tfs.CREATE | tfs.READ_WRITE);
        tfs.close(fd_1);

        const fd_2 : number = await tfs.open("/f", tfs.CREATE | tfs.EXCLUSIVE | tfs.READ_WRITE);
        expect(fd_2).toBe(-1);
    });

    test("should fail to open a directory with WRONLY", async () => {
        await tfs.mkdir("/d");

        const fd : number = await tfs.open("/d", tfs.WRITE);
        expect(fd).toBe(-1);
    });

    test("should exhaust fd table gracefully", async () => {
        const fds : number[] = [];

        for (let i = 0; i < tfs.max_fd; i++)
        {
            const fd : number = await tfs.open(`/f${i}`, tfs.CREATE | tfs.READ_WRITE);

            if (fd < 0)
                break;

            fds.push(fd);
        }

        expect(fds.length).toBe(tfs.max_fd);

        const fd : number = await tfs.open("/extra", tfs.CREATE | tfs.READ_WRITE);
        expect(fd).toBe(-1);

        for (const f of fds)
            tfs.close(f);
    });
});

describe("write / read", () => {
    test("should write and read back", async () => {
        const fd   : number     = await tfs.open("/hellofile", tfs.CREATE | tfs.READ_WRITE);
        const data : Uint8Array = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
        const nw   : number     = await tfs.write(fd, data, data.length);

        expect(nw).toBe(data.length);

        await tfs.lseek(fd, 0, tfs.SET);

        const buf : Uint8Array = new Uint8Array(64);
        const nr  : number     = await tfs.read(fd, buf, 64);

        expect(nr).toBe(data.length);
        expect([...buf.slice(0, nr)]).toEqual([...data]);

        tfs.close(fd);
    });

    test("should handle partial read", async () => {
        const fd   : number     = await tfs.open("/partial", tfs.CREATE | tfs.READ_WRITE);
        const data : Uint8Array = new Uint8Array(100).fill(0xAB);

        await tfs.write(fd, data, 100);

        await tfs.lseek(fd, 0, tfs.SET);

        const buf : Uint8Array = new Uint8Array(30);
        const nr  : number     = await tfs.read(fd, buf, 30);

        expect(nr).toBe(30);
        expect(buf).toEqual(new Uint8Array(30).fill(0xAB));

        const remain : number     = 70;
        const buf2   : Uint8Array = new Uint8Array(remain);
        const nr2    : number     = await tfs.read(fd, buf2, remain);

        expect(nr2).toBe(remain);
        expect(buf2).toEqual(new Uint8Array(remain).fill(0xAB));

        tfs.close(fd);
    });

    test("should read 0 bytes at EOF on fresh file", async () => {
        const fd  : number     = await tfs.open("/empty", tfs.CREATE | tfs.READ_WRITE);
        const buf : Uint8Array = new Uint8Array(10);
        const nr  : number     = await tfs.read(fd, buf, 10);

        expect(nr).toBe(0);

        tfs.close(fd);
    });

    test("should write across block boundaries", async () => {
        const fd   : number     = await tfs.open("/big", tfs.CREATE | tfs.READ_WRITE);
        const data : Uint8Array = new Uint8Array(tfs.block_size + 100).fill(0x42);
        const nw   : number     = await tfs.write(fd, data, data.length);

        expect(nw).toBe(data.length);

        await tfs.lseek(fd, 0, tfs.SET);

        const buf : Uint8Array = new Uint8Array(data.length);
        const nr  : number     = await tfs.read(fd, buf, data.length);

        expect(nr).toBe(data.length);
        expect(buf).toEqual(data);

        tfs.close(fd);
    });

    test("should overwrite at offset after seek", async () => {
        const fd : number     = await tfs.open("/rw", tfs.CREATE | tfs.READ_WRITE);
        const a  : Uint8Array = new Uint8Array([1, 2, 3]);
        const b  : Uint8Array = new Uint8Array([4, 5, 6]);

        await tfs.write(fd, a, 3);
        await tfs.lseek(fd, 0, tfs.SET);
        await tfs.write(fd, b, 3);

        // File size is 3 (overwrite, no extension)

        await tfs.lseek(fd, 0, tfs.SET);

        const buf : Uint8Array = new Uint8Array(6);
        const nr  : number     = await tfs.read(fd, buf, 6);

        expect(nr).toBe(3);
        expect(buf.slice(0, 3)).toEqual(new Uint8Array([4, 5, 6]));

        tfs.close(fd);
    });
});

describe("lseek", () => {
    test("should seek with SET, CURRENT, END", async () => {
        const fd   : number     = await tfs.open("/seekfile", tfs.CREATE | tfs.READ_WRITE);
        const data : Uint8Array = new Uint8Array(100).fill(0xFF);

        await tfs.write(fd, data, 100);

        const off_1 : number = await tfs.lseek(fd, 10, tfs.SET);
        expect(off_1).toBe(10);

        const off_2 : number = await tfs.lseek(fd, 5, tfs.CURRENT);
        expect(off_2).toBe(15);

        const off_3 : number = await tfs.lseek(fd, 0, tfs.END);
        expect(off_3).toBe(100);

        tfs.close(fd);
    });

    test("should return -1 for invalid whence", async () => {
        const fd  : number = await tfs.open("/seekfile", tfs.CREATE | tfs.READ_WRITE);
        const ret : number = await tfs.lseek(fd, 0, 99);

        expect(ret).toBe(-1);

        tfs.close(fd);
    });
});

describe("link / unlink", () => {
    test("should hard link and preserve data", async () => {
        const fd   : number     = await tfs.open("/a", tfs.CREATE | tfs.READ_WRITE);
        const data : Uint8Array = new Uint8Array([1, 2, 3]);

        await tfs.write(fd, data, 3);
        tfs.close(fd);

        let ret : number = await tfs.link("/a", "/b");

        expect(ret).toBe(0);

        const fd2 : number     = await tfs.open("/b", tfs.READ_WRITE);
        const buf : Uint8Array = new Uint8Array(3);

        await tfs.read(fd2, buf, 3);
        expect(buf).toEqual(data);

        tfs.close(fd2);
    });

    test("should decrement nlink on unlink", async () => {
        const fd : number = await tfs.open("/a", tfs.CREATE | tfs.READ_WRITE);

        tfs.close(fd);
        await tfs.link("/a", "/b");

        const buf : StatBuf = { size: 0, mode: 0, nlink: 0 };

        await tfs.stat("/a", buf);
        expect(buf.nlink).toBe(2);

        await tfs.unlink("/b");
        await tfs.stat("/a", buf);
        expect(buf.nlink).toBe(1);

        await tfs.unlink("/a");
    });

    test("should fail to link a directory", async () => {
        await tfs.mkdir("/d");

        const ret : number = await tfs.link("/d", "/e");
        expect(ret).toBe(-1);
    });

    test("should fail to unlink a directory", async () => {
        await tfs.mkdir("/d");

        const ret : number = await tfs.unlink("/d");
        expect(ret).toBe(-1);
    });
});

describe("TRUNCATE", () => {
    test("should clear file on open with TRUNCATE", async () => {
        const fd : number = await tfs.open("/f", tfs.CREATE | tfs.READ_WRITE);

        await tfs.write(fd, new Uint8Array(100).fill(0xAA), 100);
        tfs.close(fd);

        const fd2 : number  = await tfs.open("/f", tfs.TRUNCATE | tfs.READ_WRITE);
        const buf : StatBuf = { size: 0, mode: 0, nlink: 0 };

        await tfs.stat("/f", buf);
        expect(buf.size).toBe(0);

        tfs.close(fd2);
    });
});

describe("nested directories", () => {
    test("should create and stat deeply nested dirs", async () => {
        await tfs.mkdir("/a");
        await tfs.mkdir("/a/b");
        await tfs.mkdir("/a/b/c");

        const buf : StatBuf = { size: 0, mode: 0, nlink: 0 };
        let   ret : number  = await tfs.stat("/a/b/c", buf);

        expect(ret).toBe(0);
        expect(buf.mode & tfs.TYPE_MASK).toBe(tfs.TYPE_DIR);
    });
});

describe("path resolution with .. and .", () => {
    test("should normalize paths via URL API", async () => {
        await tfs.mkdir("/a");
        await tfs.mkdir("/a/b");

        const buf : StatBuf = { size: 0, mode: 0, nlink: 0 };
        let ret   : number  = await tfs.stat("/a/b/../b", buf);

        expect(ret).toBe(0);
        expect(buf.mode & tfs.TYPE_MASK).toBe(tfs.TYPE_DIR);
    });
});

describe("stat a regular file", () => {
    test("should stat a file after write", async () => {
        const fd   : number     = await tfs.open("/statfile", tfs.CREATE | tfs.READ_WRITE);
        const data : Uint8Array = new Uint8Array([1, 2, 3, 4, 5]);

        await tfs.write(fd, data, 5);

        tfs.close(fd);

        const buf : StatBuf = { size: 0, mode: 0, nlink: 0 };
        const ret : number  = await tfs.stat("/statfile", buf);

        expect(ret).toBe(0);
        expect(buf.mode & tfs.TYPE_MASK).toBe(tfs.TYPE_FILE);
        expect(buf.size).toBe(5);
        expect(buf.nlink).toBe(1);
    });
});

describe("mkdir error cases", () => {
    test("should fail on existing directory", async () => {
        await tfs.mkdir("/exist");
        const ret : number = await tfs.mkdir("/exist");
        expect(ret).toBe(-1);
    });

    test("should fail when parent does not exist", async () => {
        const ret : number = await tfs.mkdir("/a/b/c");
        expect(ret).toBe(-1);
    });
});

describe("rmdir error cases", () => {
    test("should fail on root directory", async () => {
        const ret : number = await tfs.rmdir("/");
        expect(ret).toBe(-1);
    });

    test("should fail on a regular file", async () => {
        const fd : number = await tfs.open("/file", tfs.CREATE | tfs.READ_WRITE);
        tfs.close(fd);

        const ret : number = await tfs.rmdir("/file");
        expect(ret).toBe(-1);
    });
});

describe("open error cases", () => {
    test("should fail without CREATE on nonexistent file", async () => {
        const fd : number = await tfs.open("/nope", tfs.READ_WRITE);
        expect(fd).toBe(-1);
    });

    test("READ should reject writes", async () => {
        const fd   : number     = await tfs.open("/roadonly", tfs.CREATE | tfs.READ);
        const data : Uint8Array = new Uint8Array([1]);
        const nw   : number     = await tfs.write(fd, data, 1);

        expect(nw).toBe(-1);
        tfs.close(fd);
    });

    test("WRITE should reject reads", async () => {
        const fd  : number     = await tfs.open("/writeonly", tfs.CREATE | tfs.WRITE);
        const buf : Uint8Array = new Uint8Array(1);
        const nr  : number     = await tfs.read(fd, buf, 1);

        expect(nr).toBe(-1);
        tfs.close(fd);
    });
});

describe("write edge cases", () => {
    test("should write 0 bytes and return 0", async () => {
        const fd   : number     = await tfs.open("/zero", tfs.CREATE | tfs.READ_WRITE);
        const data : Uint8Array = new Uint8Array(0);
        const nw   : number     = await tfs.write(fd, data, 0);

        expect(nw).toBe(0);
        tfs.close(fd);
    });

    test("should fail on a directory fd", async () => {
        await tfs.mkdir("/writedir");

        const fd   : number     = await tfs.open("/writedir", tfs.READ);
        const data : Uint8Array = new Uint8Array([1]);
        const nw   : number     = await tfs.write(fd, data, 1);

        expect(nw).toBe(-1);
        tfs.close(fd);
    });
});

describe("read edge cases", () => {
    test("should read 0 bytes and return 0", async () => {
        const fd  : number     = await tfs.open("/r0", tfs.CREATE | tfs.READ_WRITE);
        const buf : Uint8Array = new Uint8Array(0);
        const nr  : number     = await tfs.read(fd, buf, 0);

        expect(nr).toBe(0);
        tfs.close(fd);
    });

    test("should fail on a directory fd", async () => {
        await tfs.mkdir("/readdir");

        const fd  : number     = await tfs.open("/readdir", tfs.READ);
        const buf : Uint8Array = new Uint8Array(1);
        const nr  : number     = await tfs.read(fd, buf, 1);

        expect(nr).toBe(-1);
        tfs.close(fd);
    });
});

describe("lseek edge cases", () => {
    test("should fail on invalid fd", async () => {
        const ret : number = await tfs.lseek(-1, 0, tfs.SET);
        expect(ret).toBe(-1);
    });
});



describe("link error cases", () => {
    test("should fail on nonexistent source", async () => {
        const ret : number = await tfs.link("/nonexistent", "/b");
        expect(ret).toBe(-1);
    });

    test("should fail when target already exists", async () => {
        const fd_a : number = await tfs.open("/a", tfs.CREATE | tfs.READ_WRITE);
        tfs.close(fd_a);
        const fd_b : number = await tfs.open("/b", tfs.CREATE | tfs.READ_WRITE);
        tfs.close(fd_b);

        const ret : number = await tfs.link("/a", "/b");
        expect(ret).toBe(-1);
    });
});

describe("unlink error cases", () => {
    test("should fail on nonexistent path", async () => {
        const ret : number = await tfs.unlink("/nope");
        expect(ret).toBe(-1);
    });

    test("should fail on root", async () => {
        const ret : number = await tfs.unlink("/");
        expect(ret).toBe(-1);
    });
});

describe("TRUNCATE edge cases", () => {
    test("should no-op on empty file", async () => {
        const fd_1 : number = await tfs.open("/trunc0", tfs.CREATE | tfs.READ_WRITE);
        tfs.close(fd_1);

        const fd_2 : number = await tfs.open("/trunc0", tfs.TRUNCATE | tfs.READ_WRITE);

        const buf : StatBuf = { size: 0, mode: 0, nlink: 0 };
        await tfs.stat("/trunc0", buf);
        expect(buf.size).toBe(0);

        tfs.close(fd_2);
    });

    test("should fail without CREATE on nonexistent file", async () => {
        const fd : number = await tfs.open("/nonexistent_trunc", tfs.TRUNCATE | tfs.READ_WRITE);
        expect(fd).toBe(-1);
    });
});

describe("APPEND", () => {
    test("should append writes regardless of seek position", async () => {
        const fd   : number     = await tfs.open("/appendfile", tfs.CREATE | tfs.READ_WRITE | tfs.APPEND);
        const a    : Uint8Array = new Uint8Array([65, 66]);         // "AB"
        const b    : Uint8Array = new Uint8Array([67, 68]);         // "CD"
        const abcd : Uint8Array = new Uint8Array([65, 66, 67, 68]); // "ABCD"

        const nw_1 : number = await tfs.write(fd, a, 2);
        expect(nw_1).toBe(2);

        // Seek back to 0 - write should still go to end.

        await tfs.lseek(fd, 0, tfs.SET);

        const nw_2 : number = await tfs.write(fd, b, 2);
        expect(nw_2).toBe(2);

        await tfs.lseek(fd, 0, tfs.SET);

        const buf : Uint8Array = new Uint8Array(4);
        const nr  : number     = await tfs.read(fd, buf, 4);

        expect(nr).toBe(4);
        expect(buf).toEqual(abcd);

        tfs.close(fd);
    });
});

describe("multi-fd operations", () => {
    test("two fds to the same file: write via one, read via the other", async () => {
        const fd_1 : number = await tfs.open("/shared", tfs.CREATE | tfs.READ_WRITE);
        const fd_2 : number = await tfs.open("/shared", tfs.READ_WRITE);

        const data : Uint8Array = new Uint8Array([10, 20, 30]);
        const nw   : number    = await tfs.write(fd_1, data, 3);

        expect(nw).toBe(3);

        const buf : Uint8Array = new Uint8Array(3);
        const nr  : number     = await tfs.read(fd_2, buf, 3);

        expect(nr).toBe(3);
        expect(buf).toEqual(data);

        tfs.close(fd_1);
        tfs.close(fd_2);
    });
});

describe("interleaved operations", () => {
    test("open -> unlink -> close: close succeeds after unlink", async () => {
        const fd : number = await tfs.open("/unlinkme", tfs.CREATE | tfs.READ_WRITE);

        await tfs.write(fd, new Uint8Array([1, 2, 3]), 3);

        const ul_ret : number = await tfs.unlink("/unlinkme");
        expect(ul_ret).toBe(0);

        // Check inode was deleted, fd is stale, read returns -1.

        const buf : Uint8Array = new Uint8Array(3);
        await tfs.lseek(fd, 0, tfs.SET);

        const nr : number = await tfs.read(fd, buf, 3);
        expect(nr).toBe(-1);

        // Check close still succeeds.

        const c_ret : number = tfs.close(fd);
        expect(c_ret).toBe(0);

        // Check file is gone.

        const sb  : StatBuf = { size: 0, mode: 0, nlink: 0 };
        const ret               = await tfs.stat("/unlinkme", sb);
        expect(ret).toBe(-1);
    });
});

describe("block-boundary writes", () => {
    test("should write exactly BLOCK_SIZE bytes", async () => {
        const fd   : number     = await tfs.open("/exactb", tfs.CREATE | tfs.READ_WRITE);
        const data : Uint8Array = new Uint8Array(tfs.block_size).fill(0xAA);
        const nw   : number     = await tfs.write(fd, data, tfs.block_size);

        expect(nw).toBe(tfs.block_size);

        await tfs.lseek(fd, 0, tfs.SET);

        const buf : Uint8Array = new Uint8Array(tfs.block_size);
        const nr  : number     = await tfs.read(fd, buf, tfs.block_size);

        expect(nr).toBe(tfs.block_size);
        expect(buf).toEqual(data);

        tfs.close(fd);
    });

    test("should write BLOCK_SIZE + 1 bytes (cross one boundary)", async () => {
        const fd   : number     = await tfs.open("/crossb", tfs.CREATE | tfs.READ_WRITE);
        const data : Uint8Array = new Uint8Array(tfs.block_size + 1).fill(0xBB);
        const nw   : number     = await tfs.write(fd, data, tfs.block_size + 1);

        expect(nw).toBe(tfs.block_size + 1);

        await tfs.lseek(fd, 0, tfs.SET);

        const buf : Uint8Array = new Uint8Array(tfs.block_size + 1);
        const nr  : number     = await tfs.read(fd, buf, tfs.block_size + 1);

        expect(nr).toBe(tfs.block_size + 1);
        expect(buf).toEqual(data);

        tfs.close(fd);
    });

    test("should write 2 * BLOCK_SIZE bytes (two full blocks)", async () => {
        const fd   : number     = await tfs.open("/twofull", tfs.CREATE | tfs.READ_WRITE);
        const data : Uint8Array = new Uint8Array(tfs.block_size * 2).fill(0xCC);
        const nw   : number     = await tfs.write(fd, data, tfs.block_size * 2);

        expect(nw).toBe(tfs.block_size * 2);

        await tfs.lseek(fd, 0, tfs.SET);

        const buf : Uint8Array = new Uint8Array(tfs.block_size * 2);
        const nr  : number     = await tfs.read(fd, buf, tfs.block_size * 2);

        expect(nr).toBe(tfs.block_size * 2);
        expect(buf).toEqual(data);

        tfs.close(fd);
    });
});

describe("hard-link nlink lifecycle", () => {
    test("unlink one link preserves data via the other", async () => {
        const fd   : number     = await tfs.open("/orig", tfs.CREATE | tfs.READ_WRITE);
        const data : Uint8Array = new Uint8Array([10, 20, 30]);

        await tfs.write(fd, data, 3);
        tfs.close(fd);

        let ret : number = await tfs.link("/orig", "/link");
        expect(ret).toBe(0);

        ret = await tfs.unlink("/orig");
        expect(ret).toBe(0);

        // Data should still be accessible via /link.

        const fd2  : number     = await tfs.open("/link", tfs.READ_WRITE);
        const buf  : Uint8Array = new Uint8Array(3);
        const nr   : number     = await tfs.read(fd2, buf, 3);

        expect(nr).toBe(3);
        expect(buf).toEqual(data);

        tfs.close(fd2);

        await tfs.unlink("/link");
    });

    test("unlink all links deletes file", async () =>
    {
        const fd : number = await tfs.open("/hapath", tfs.CREATE | tfs.READ_WRITE);

        tfs.close(fd);

        await tfs.link("/hapath", "/hbpath");
        await tfs.unlink("/hapath");

        // Check /hbpath still exists (nlink=1).

        const sb  : StatBuf = { size: 0, mode: 0, nlink: 0 };
        let   ret : number  = await tfs.stat("/hbpath", sb);

        expect(ret).toBe(0);

        await tfs.unlink("/hbpath");

        // Check nlink drops to 0, inode and blocks deleted.

        ret = await tfs.stat("/hbpath", sb);
        expect(ret).toBe(-1);
    });
});

describe("sparse file", () => {
    test("seek past EOF, write, read back with zero-filled gap", async () => {
        const fd       : number     = await tfs.open("/sparse", tfs.CREATE | tfs.READ_WRITE);
        const gap      : number     = 1000;
        const data     : Uint8Array = new Uint8Array([0xDE, 0xAD]);
        const expected : Uint8Array = new Uint8Array(gap + data.length);

        // First gap bytes stay zero, then the data.

        expected.set(data, gap);

        await tfs.lseek(fd, gap, tfs.SET);

        const nw : number = await tfs.write(fd, data, data.length);
        expect(nw).toBe(data.length);

        await tfs.lseek(fd, 0, tfs.SET);

        const buf : Uint8Array = new Uint8Array(expected.length);
        const nr  : number     = await tfs.read(fd, buf, expected.length);

        expect(nr).toBe(expected.length);
        expect(buf).toEqual(expected);

        tfs.close(fd);
    });
});

describe("APPEND with two fds", () => {
    test("writes via two append fds both land at end", async () => {
        const fd_a : number = await tfs.open("/dualapp", tfs.CREATE | tfs.READ_WRITE | tfs.APPEND);
        const fd_b : number = await tfs.open("/dualapp", tfs.READ_WRITE | tfs.APPEND);

        const a  : Uint8Array = new Uint8Array([65]); // "A"
        const b  : Uint8Array = new Uint8Array([66]); // "B"
        const ab : Uint8Array = new Uint8Array([65, 66]);

        const nw_a : number = await tfs.write(fd_a, a, 1);
        expect(nw_a).toBe(1);

        const nw_b : number = await tfs.write(fd_b, b, 1);
        expect(nw_b).toBe(1);

        await tfs.lseek(fd_a, 0, tfs.SET);

        const buf : Uint8Array = new Uint8Array(2);
        const nr  : number     = await tfs.read(fd_a, buf, 2);

        expect(nr).toBe(2);
        expect(buf).toEqual(ab);

        tfs.close(fd_a);
        tfs.close(fd_b);
    });
});

describe("fd slot reuse", () => {
    test("should reuse closed fd slot", async () => {
        const fds : number[] = [];

        for (let i = 0; i < tfs.max_fd; i++)
        {
            const fd : number = await tfs.open(`/reuse_${i}`, tfs.CREATE | tfs.READ_WRITE);
            expect(fd).toBeGreaterThanOrEqual(0);
            fds.push(fd);
        }

        // Close slot 0.

        tfs.close(fds[0]!);

        // Next open should reuse slot 0.

        const new_fd : number = await tfs.open("/reuse_new", tfs.CREATE | tfs.READ_WRITE);
        expect(new_fd).toBe(fds[0]!);

        for (let i = 1; i < tfs.max_fd; i++)
            tfs.close(fds[i]!);

        tfs.close(new_fd);
    });
});

describe("read count clamping", () => {
    test("should read fewer bytes than requested when near EOF", async () => {
        const fd   : number    = await tfs.open("/small", tfs.CREATE | tfs.READ_WRITE);
        const data : Uint8Array = new Uint8Array([1, 2, 3, 4, 5]);

        await tfs.write(fd, data, 5);
        await tfs.lseek(fd, 3, tfs.SET);

        const buf : Uint8Array = new Uint8Array(10);
        const nr  : number     = await tfs.read(fd, buf, 10);

        // Check that only 2 bytes remain.

        expect(nr).toBe(2);
        expect([...buf.slice(0, nr)]).toEqual([4, 5]);

        tfs.close(fd);
    });
});

describe("readdir", () => {
    test("should list entries in a directory", async () => {
        await tfs.mkdir("/rd_parent");
        await tfs.mkdir("/rd_parent/a");
        await tfs.mkdir("/rd_parent/b");

        const entries = await tfs.readdir("/rd_parent");

        expect(Array.isArray(entries)).toBe(true);
        expect((entries as DirEnt[]).length).toBe(2);
    });

    test("should return empty array for empty directory", async () => {
        await tfs.mkdir("/rd_empty");

        const entries = await tfs.readdir("/rd_empty");
        expect(Array.isArray(entries)).toBe(true);
        expect((entries as DirEnt[]).length).toBe(0);
    });

    test("should return -1 for nonexistent path", async () => {
        const ret = await tfs.readdir("/rd_nope");
        expect(ret).toBe(-1);
    });

    test("should return -1 for a regular file", async () => {
        const fd : number = await tfs.open("/rd_filepath", tfs.CREATE | tfs.READ_WRITE);
        tfs.close(fd);

        const ret = await tfs.readdir("/rd_filepath");
        expect(ret).toBe(-1);
    });
});

describe("rename", () => {
    test("should rename a file preserving data", async () => {
        const fd   : number    = await tfs.open("/oldname", tfs.CREATE | tfs.READ_WRITE);
        const data : Uint8Array = new Uint8Array([65, 66, 67]);

        await tfs.write(fd, data, 3);
        tfs.close(fd);

        const ret : number = await tfs.rename("/oldname", "/newname");
        expect(ret).toBe(0);

        // Check that old name is gone.

        const sb   : StatBuf = { size: 0, mode: 0, nlink: 0 };
        let   sret : number  = await tfs.stat("/oldname", sb);

        expect(sret).toBe(-1);

        // New name has the data.

        const fd2 : number     = await tfs.open("/newname", tfs.READ_WRITE);
        const buf : Uint8Array = new Uint8Array(3);
        const nr  : number     = await tfs.read(fd2, buf, 3);

        expect(nr).toBe(3);
        expect(buf).toEqual(data);

        tfs.close(fd2);
    });

    test("should overwrite existing target", async () => {
        const fd_a : number     = await tfs.open("/ren_a", tfs.CREATE | tfs.READ_WRITE);
        const d_a  : Uint8Array = new Uint8Array([1, 2, 3]);

        await tfs.write(fd_a, d_a, 3);
        tfs.close(fd_a);

        const fd_b : number     = await tfs.open("/ren_b", tfs.CREATE | tfs.READ_WRITE);
        const d_b  : Uint8Array = new Uint8Array([4, 5, 6]);

        await tfs.write(fd_b, d_b, 3);
        tfs.close(fd_b);

        const ret : number = await tfs.rename("/ren_a", "/ren_b");
        expect(ret).toBe(0);

        // CHeck that /ren_b now has /ren_a's data.

        const fd   : number     = await tfs.open("/ren_b", tfs.READ_WRITE);
        const buf  : Uint8Array = new Uint8Array(3);
        const nr   : number     = await tfs.read(fd, buf, 3);

        expect(nr).toBe(3);
        expect(buf).toEqual(d_a);
        tfs.close(fd);

        // Check that /ren_a is gone.

        const sb  : StatBuf = { size: 0, mode: 0, nlink: 0 };
        const sret              = await tfs.stat("/ren_a", sb);

        expect(sret).toBe(-1);
    });

    test("should fail on nonexistent source", async () => {
        const ret : number = await tfs.rename("/nope", "/b");
        expect(ret).toBe(-1);
    });

    test("should fail on directory source", async () => {
        await tfs.mkdir("/dirsrc");

        const ret : number = await tfs.rename("/dirsrc", "/dirdst");
        expect(ret).toBe(-1);
    });

    test("should fail when target parent does not exist", async () => {
        const fd : number = await tfs.open("/rename_me", tfs.CREATE | tfs.READ_WRITE);
        tfs.close(fd);

        const ret : number = await tfs.rename("/rename_me", "/nope/b");
        expect(ret).toBe(-1);
    });
});


