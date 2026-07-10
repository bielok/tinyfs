import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import "fake-indexeddb/auto";
import { O, FORMAT_VERSION, TinyFS } from "../src/tinyfs.ts";
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

    tfs.dcache.clear();
});

describe("stat", () => {
    test("should stat root directory", async () => {
        const buf : StatBuf = { size: 0, mode: 0, nlink: 0 };
        const ret : number  = await tfs.stat("/", buf);

        expect(ret).toBe(0);
        expect(buf.mode & O.TYPE_MASK).toBe(O.TYPE_DIR);
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
        expect(buf.mode & O.TYPE_MASK).toBe(O.TYPE_DIR);
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
    test("should open a file with O.CREATE", async () => {
        const fd : number = await tfs.open("/f", O.CREATE | O.READ_WRITE);
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

    test("O.CREATE | O.EXCLUSIVE should fail on existing file", async () => {
        const fd_1 : number = await tfs.open("/f", O.CREATE | O.READ_WRITE);
        tfs.close(fd_1);

        const fd_2 : number = await tfs.open("/f", O.CREATE | O.EXCLUSIVE | O.READ_WRITE);
        expect(fd_2).toBe(-1);
    });

    test("should fail to open a directory with WRONLY", async () => {
        await tfs.mkdir("/d");

        const fd : number = await tfs.open("/d", O.WRITE);
        expect(fd).toBe(-1);
    });

    test("should exhaust fd table gracefully", async () => {
        const fds : number[] = [];

        for (let i = 0; i < tfs.max_fd; i++)
        {
            const fd : number = await tfs.open(`/f${i}`, O.CREATE | O.READ_WRITE);

            if (fd < 0)
                break;

            fds.push(fd);
        }

        expect(fds.length).toBe(tfs.max_fd);

        const fd : number = await tfs.open("/extra", O.CREATE | O.READ_WRITE);
        expect(fd).toBe(-1);

        for (const f of fds)
            tfs.close(f);
    });
});

describe("write / read", () => {
    test("should write and read back", async () => {
        const fd   : number     = await tfs.open("/hellofile", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
        const nw   : number     = await tfs.write(fd, data, data.length);

        expect(nw).toBe(data.length);

        await tfs.lseek(fd, 0, O.SET);

        const buf : Uint8Array = new Uint8Array(64);
        const nr  : number     = await tfs.read(fd, buf, 64);

        expect(nr).toBe(data.length);
        expect([...buf.slice(0, nr)]).toEqual([...data]);

        tfs.close(fd);
    });

    test("should handle partial read", async () => {
        const fd   : number     = await tfs.open("/partial", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array(100).fill(0xAB);

        await tfs.write(fd, data, 100);

        await tfs.lseek(fd, 0, O.SET);

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
        const fd  : number     = await tfs.open("/empty", O.CREATE | O.READ_WRITE);
        const buf : Uint8Array = new Uint8Array(10);
        const nr  : number     = await tfs.read(fd, buf, 10);

        expect(nr).toBe(0);

        tfs.close(fd);
    });

    test("should write across block boundaries", async () => {
        const fd   : number     = await tfs.open("/big", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array(tfs.block_size + 100).fill(0x42);
        const nw   : number     = await tfs.write(fd, data, data.length);

        expect(nw).toBe(data.length);

        await tfs.lseek(fd, 0, O.SET);

        const buf : Uint8Array = new Uint8Array(data.length);
        const nr  : number     = await tfs.read(fd, buf, data.length);

        expect(nr).toBe(data.length);
        expect(buf).toEqual(data);

        tfs.close(fd);
    });

    test("should overwrite at offset after seek", async () => {
        const fd : number     = await tfs.open("/rw", O.CREATE | O.READ_WRITE);
        const a  : Uint8Array = new Uint8Array([1, 2, 3]);
        const b  : Uint8Array = new Uint8Array([4, 5, 6]);

        await tfs.write(fd, a, 3);
        await tfs.lseek(fd, 0, O.SET);
        await tfs.write(fd, b, 3);

        // File size is 3 (overwrite, no extension)

        await tfs.lseek(fd, 0, O.SET);

        const buf : Uint8Array = new Uint8Array(6);
        const nr  : number     = await tfs.read(fd, buf, 6);

        expect(nr).toBe(3);
        expect(buf.slice(0, 3)).toEqual(new Uint8Array([4, 5, 6]));

        tfs.close(fd);
    });
});

describe("lseek", () => {
    test("should seek with O.SET, O.CURRENT, O.END", async () => {
        const fd   : number     = await tfs.open("/seekfile", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array(100).fill(0xFF);

        await tfs.write(fd, data, 100);

        const off_1 : number = await tfs.lseek(fd, 10, O.SET);
        expect(off_1).toBe(10);

        const off_2 : number = await tfs.lseek(fd, 5, O.CURRENT);
        expect(off_2).toBe(15);

        const off_3 : number = await tfs.lseek(fd, 0, O.END);
        expect(off_3).toBe(100);

        tfs.close(fd);
    });

    test("should return -1 for invalid whence", async () => {
        const fd  : number = await tfs.open("/seekfile", O.CREATE | O.READ_WRITE);
        const ret : number = await tfs.lseek(fd, 0, 99);

        expect(ret).toBe(-1);

        tfs.close(fd);
    });
});

describe("link / unlink", () => {
    test("should hard link and preserve data", async () => {
        const fd   : number     = await tfs.open("/a", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array([1, 2, 3]);

        await tfs.write(fd, data, 3);
        tfs.close(fd);

        let ret : number = await tfs.link("/a", "/b");

        expect(ret).toBe(0);

        const fd2 : number     = await tfs.open("/b", O.READ_WRITE);
        const buf : Uint8Array = new Uint8Array(3);

        await tfs.read(fd2, buf, 3);
        expect(buf).toEqual(data);

        tfs.close(fd2);
    });

    test("should decrement nlink on unlink", async () => {
        const fd : number = await tfs.open("/a", O.CREATE | O.READ_WRITE);

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

describe("O.TRUNCATE", () => {
    test("should clear file on open with O.TRUNCATE", async () => {
        const fd : number = await tfs.open("/f", O.CREATE | O.READ_WRITE);

        await tfs.write(fd, new Uint8Array(100).fill(0xAA), 100);
        tfs.close(fd);

        const fd2 : number  = await tfs.open("/f", O.TRUNCATE | O.READ_WRITE);
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
        expect(buf.mode & O.TYPE_MASK).toBe(O.TYPE_DIR);
    });
});

describe("path resolution with .. and .", () => {
    test("should normalize paths via URL API", async () => {
        await tfs.mkdir("/a");
        await tfs.mkdir("/a/b");

        const buf : StatBuf = { size: 0, mode: 0, nlink: 0 };
        let ret   : number  = await tfs.stat("/a/b/../b", buf);

        expect(ret).toBe(0);
        expect(buf.mode & O.TYPE_MASK).toBe(O.TYPE_DIR);
    });
});

describe("stat a regular file", () => {
    test("should stat a file after write", async () => {
        const fd   : number     = await tfs.open("/statfile", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array([1, 2, 3, 4, 5]);

        await tfs.write(fd, data, 5);

        tfs.close(fd);

        const buf : StatBuf = { size: 0, mode: 0, nlink: 0 };
        const ret : number  = await tfs.stat("/statfile", buf);

        expect(ret).toBe(0);
        expect(buf.mode & O.TYPE_MASK).toBe(O.TYPE_FILE);
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
        const fd : number = await tfs.open("/file", O.CREATE | O.READ_WRITE);
        tfs.close(fd);

        const ret : number = await tfs.rmdir("/file");
        expect(ret).toBe(-1);
    });
});

describe("open error cases", () => {
    test("should fail without O.CREATE on nonexistent file", async () => {
        const fd : number = await tfs.open("/nope", O.READ_WRITE);
        expect(fd).toBe(-1);
    });

    test("O.READ should reject writes", async () => {
        const fd   : number     = await tfs.open("/roadonly", O.CREATE | O.READ);
        const data : Uint8Array = new Uint8Array([1]);
        const nw   : number     = await tfs.write(fd, data, 1);

        expect(nw).toBe(-1);
        tfs.close(fd);
    });

    test("O.WRITE should reject reads", async () => {
        const fd  : number     = await tfs.open("/writeonly", O.CREATE | O.WRITE);
        const buf : Uint8Array = new Uint8Array(1);
        const nr  : number     = await tfs.read(fd, buf, 1);

        expect(nr).toBe(-1);
        tfs.close(fd);
    });
});

describe("write edge cases", () => {
    test("should write 0 bytes and return 0", async () => {
        const fd   : number     = await tfs.open("/zero", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array(0);
        const nw   : number     = await tfs.write(fd, data, 0);

        expect(nw).toBe(0);
        tfs.close(fd);
    });

    test("should fail on a directory fd", async () => {
        await tfs.mkdir("/writedir");

        const fd   : number     = await tfs.open("/writedir", O.READ);
        const data : Uint8Array = new Uint8Array([1]);
        const nw   : number     = await tfs.write(fd, data, 1);

        expect(nw).toBe(-1);
        tfs.close(fd);
    });
});

describe("read edge cases", () => {
    test("should read 0 bytes and return 0", async () => {
        const fd  : number     = await tfs.open("/r0", O.CREATE | O.READ_WRITE);
        const buf : Uint8Array = new Uint8Array(0);
        const nr  : number     = await tfs.read(fd, buf, 0);

        expect(nr).toBe(0);
        tfs.close(fd);
    });

    test("should fail on a directory fd", async () => {
        await tfs.mkdir("/readdir");

        const fd  : number     = await tfs.open("/readdir", O.READ);
        const buf : Uint8Array = new Uint8Array(1);
        const nr  : number     = await tfs.read(fd, buf, 1);

        expect(nr).toBe(-1);
        tfs.close(fd);
    });
});

describe("lseek edge cases", () => {
    test("should fail on invalid fd", async () => {
        const ret : number = await tfs.lseek(-1, 0, O.SET);
        expect(ret).toBe(-1);
    });
});



describe("link error cases", () => {
    test("should fail on nonexistent source", async () => {
        const ret : number = await tfs.link("/nonexistent", "/b");
        expect(ret).toBe(-1);
    });

    test("should fail when target already exists", async () => {
        const fd_a : number = await tfs.open("/a", O.CREATE | O.READ_WRITE);
        tfs.close(fd_a);

        const fd_b : number = await tfs.open("/b", O.CREATE | O.READ_WRITE);
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

describe("O.TRUNCATE edge cases", () => {
    test("should no-op on empty file", async () => {
        const fd_1 : number = await tfs.open("/trunc0", O.CREATE | O.READ_WRITE);
        tfs.close(fd_1);

        const fd_2 : number = await tfs.open("/trunc0", O.TRUNCATE | O.READ_WRITE);

        const buf : StatBuf = { size: 0, mode: 0, nlink: 0 };
        await tfs.stat("/trunc0", buf);
        expect(buf.size).toBe(0);

        tfs.close(fd_2);
    });

    test("should fail without O.CREATE on nonexistent file", async () => {
        const fd : number = await tfs.open("/nonexistent_trunc", O.TRUNCATE | O.READ_WRITE);
        expect(fd).toBe(-1);
    });
});

describe("APPEND", () => {
    test("should append writes regardless of seek position", async () => {
        const fd   : number     = await tfs.open("/appendfile", O.CREATE | O.READ_WRITE | O.APPEND);
        const a    : Uint8Array = new Uint8Array([65, 66]);         // "AB"
        const b    : Uint8Array = new Uint8Array([67, 68]);         // "CD"
        const abcd : Uint8Array = new Uint8Array([65, 66, 67, 68]); // "ABCD"

        const nw_1 : number = await tfs.write(fd, a, 2);
        expect(nw_1).toBe(2);

        // Seek back to 0 - write should still go to end.

        await tfs.lseek(fd, 0, O.SET);

        const nw_2 : number = await tfs.write(fd, b, 2);
        expect(nw_2).toBe(2);

        await tfs.lseek(fd, 0, O.SET);

        const buf : Uint8Array = new Uint8Array(4);
        const nr  : number     = await tfs.read(fd, buf, 4);

        expect(nr).toBe(4);
        expect(buf).toEqual(abcd);

        tfs.close(fd);
    });
});

describe("multi-fd operations", () => {
    test("two fds to the same file: write via one, read via the other", async () => {
        const fd_1 : number = await tfs.open("/shared", O.CREATE | O.READ_WRITE);
        const fd_2 : number = await tfs.open("/shared", O.READ_WRITE);

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
        const fd : number = await tfs.open("/unlinkme", O.CREATE | O.READ_WRITE);

        await tfs.write(fd, new Uint8Array([1, 2, 3]), 3);

        const ul_ret : number = await tfs.unlink("/unlinkme");
        expect(ul_ret).toBe(0);

        // Check inode was deleted, fd is stale, read returns -1.

        const buf : Uint8Array = new Uint8Array(3);
        await tfs.lseek(fd, 0, O.SET);

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
        const fd   : number     = await tfs.open("/exactb", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array(tfs.block_size).fill(0xAA);
        const nw   : number     = await tfs.write(fd, data, tfs.block_size);

        expect(nw).toBe(tfs.block_size);

        await tfs.lseek(fd, 0, O.SET);

        const buf : Uint8Array = new Uint8Array(tfs.block_size);
        const nr  : number     = await tfs.read(fd, buf, tfs.block_size);

        expect(nr).toBe(tfs.block_size);
        expect(buf).toEqual(data);

        tfs.close(fd);
    });

    test("should write BLOCK_SIZE + 1 bytes (cross one boundary)", async () => {
        const fd   : number     = await tfs.open("/crossb", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array(tfs.block_size + 1).fill(0xBB);
        const nw   : number     = await tfs.write(fd, data, tfs.block_size + 1);

        expect(nw).toBe(tfs.block_size + 1);

        await tfs.lseek(fd, 0, O.SET);

        const buf : Uint8Array = new Uint8Array(tfs.block_size + 1);
        const nr  : number     = await tfs.read(fd, buf, tfs.block_size + 1);

        expect(nr).toBe(tfs.block_size + 1);
        expect(buf).toEqual(data);

        tfs.close(fd);
    });

    test("should write 2 * BLOCK_SIZE bytes (two full blocks)", async () => {
        const fd   : number     = await tfs.open("/twofull", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array(tfs.block_size * 2).fill(0xCC);
        const nw   : number     = await tfs.write(fd, data, tfs.block_size * 2);

        expect(nw).toBe(tfs.block_size * 2);

        await tfs.lseek(fd, 0, O.SET);

        const buf : Uint8Array = new Uint8Array(tfs.block_size * 2);
        const nr  : number     = await tfs.read(fd, buf, tfs.block_size * 2);

        expect(nr).toBe(tfs.block_size * 2);
        expect(buf).toEqual(data);

        tfs.close(fd);
    });
});

describe("hard-link nlink lifecycle", () => {
    test("unlink one link preserves data via the other", async () => {
        const fd   : number     = await tfs.open("/orig", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array([10, 20, 30]);

        await tfs.write(fd, data, 3);
        tfs.close(fd);

        let ret : number = await tfs.link("/orig", "/link");
        expect(ret).toBe(0);

        ret = await tfs.unlink("/orig");
        expect(ret).toBe(0);

        // Data should still be accessible via /link.

        const fd2  : number     = await tfs.open("/link", O.READ_WRITE);
        const buf  : Uint8Array = new Uint8Array(3);
        const nr   : number     = await tfs.read(fd2, buf, 3);

        expect(nr).toBe(3);
        expect(buf).toEqual(data);

        tfs.close(fd2);

        await tfs.unlink("/link");
    });

    test("unlink all links deletes file", async () =>
    {
        const fd : number = await tfs.open("/hapath", O.CREATE | O.READ_WRITE);

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
        const fd       : number     = await tfs.open("/sparse", O.CREATE | O.READ_WRITE);
        const gap      : number     = 1000;
        const data     : Uint8Array = new Uint8Array([0xDE, 0xAD]);
        const expected : Uint8Array = new Uint8Array(gap + data.length);

        // First gap bytes stay zero, then the data.

        expected.set(data, gap);

        await tfs.lseek(fd, gap, O.SET);

        const nw : number = await tfs.write(fd, data, data.length);
        expect(nw).toBe(data.length);

        await tfs.lseek(fd, 0, O.SET);

        const buf : Uint8Array = new Uint8Array(expected.length);
        const nr  : number     = await tfs.read(fd, buf, expected.length);

        expect(nr).toBe(expected.length);
        expect(buf).toEqual(expected);

        tfs.close(fd);
    });
});

describe("APPEND with two fds", () => {
    test("writes via two append fds both land at end", async () => {
        const fd_a : number = await tfs.open("/dualapp", O.CREATE | O.READ_WRITE | O.APPEND);
        const fd_b : number = await tfs.open("/dualapp", O.READ_WRITE | O.APPEND);

        const a  : Uint8Array = new Uint8Array([65]); // "A"
        const b  : Uint8Array = new Uint8Array([66]); // "B"
        const ab : Uint8Array = new Uint8Array([65, 66]);

        const nw_a : number = await tfs.write(fd_a, a, 1);
        expect(nw_a).toBe(1);

        const nw_b : number = await tfs.write(fd_b, b, 1);
        expect(nw_b).toBe(1);

        await tfs.lseek(fd_a, 0, O.SET);

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
            const fd : number = await tfs.open(`/reuse_${i}`, O.CREATE | O.READ_WRITE);
            expect(fd).toBeGreaterThanOrEqual(0);
            fds.push(fd);
        }

        // Close slot 0.

        tfs.close(fds[0]!);

        // Next open should reuse slot 0.

        const new_fd : number = await tfs.open("/reuse_new", O.CREATE | O.READ_WRITE);
        expect(new_fd).toBe(fds[0]!);

        for (let i = 1; i < tfs.max_fd; i++)
            tfs.close(fds[i]!);

        tfs.close(new_fd);
    });
});

describe("read count clamping", () => {
    test("should read fewer bytes than requested when near EOF", async () => {
        const fd   : number    = await tfs.open("/small", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array([1, 2, 3, 4, 5]);

        await tfs.write(fd, data, 5);
        await tfs.lseek(fd, 3, O.SET);

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
        const fd : number = await tfs.open("/rd_filepath", O.CREATE | O.READ_WRITE);
        tfs.close(fd);

        const ret = await tfs.readdir("/rd_filepath");
        expect(ret).toBe(-1);
    });
});

describe("rename", () => {
    test("should rename a file preserving data", async () => {
        const fd   : number    = await tfs.open("/oldname", O.CREATE | O.READ_WRITE);
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

        const fd2 : number     = await tfs.open("/newname", O.READ_WRITE);
        const buf : Uint8Array = new Uint8Array(3);
        const nr  : number     = await tfs.read(fd2, buf, 3);

        expect(nr).toBe(3);
        expect(buf).toEqual(data);

        tfs.close(fd2);
    });

    test("should overwrite existing target", async () => {
        const fd_a : number     = await tfs.open("/ren_a", O.CREATE | O.READ_WRITE);
        const d_a  : Uint8Array = new Uint8Array([1, 2, 3]);

        await tfs.write(fd_a, d_a, 3);
        tfs.close(fd_a);

        const fd_b : number     = await tfs.open("/ren_b", O.CREATE | O.READ_WRITE);
        const d_b  : Uint8Array = new Uint8Array([4, 5, 6]);

        await tfs.write(fd_b, d_b, 3);
        tfs.close(fd_b);

        const ret : number = await tfs.rename("/ren_a", "/ren_b");
        expect(ret).toBe(0);

        // CHeck that /ren_b now has /ren_a's data.

        const fd   : number     = await tfs.open("/ren_b", O.READ_WRITE);
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
        const fd : number = await tfs.open("/rename_me", O.CREATE | O.READ_WRITE);
        tfs.close(fd);

        const ret : number = await tfs.rename("/rename_me", "/nope/b");
        expect(ret).toBe(-1);
    });
});

describe("path normalization (URL edge cases)", () => {
    test("fragment (#) in path is preserved, not stripped", async () => {
        // Create a file whose name contains #.
        const fd : number = await tfs.open("/safe#evil", O.CREATE | O.READ_WRITE);
        expect(fd).not.toBe(-1);
        tfs.close(fd);

        const sb  : StatBuf = { size: 0, mode: 0, nlink: 0 };
        const ret : number  = await tfs.stat("/safe#evil", sb);
        expect(ret).toBe(0);

        // A file without # should not alias it.
        const sb2  : StatBuf = { size: 0, mode: 0, nlink: 0 };
        const ret2 : number  = await tfs.stat("/safe", sb2);
        expect(ret2).toBe(-1);
    });

    test("query string (?) in path is preserved, not stripped", async () => {
        const fd : number = await tfs.open("/file?x=1", O.CREATE | O.READ_WRITE);
        expect(fd).not.toBe(-1);
        tfs.close(fd);

        const sb  : StatBuf = { size: 0, mode: 0, nlink: 0 };
        const ret : number  = await tfs.stat("/file?x=1", sb);
        expect(ret).toBe(0);
    });

    test("protocol-relative // is rejected", async () => {
        const sb  : StatBuf = { size: 0, mode: 0, nlink: 0 };
        const ret : number  = await tfs.stat("//a", sb);
        expect(ret).toBe(-1);
    });
});

describe("export / import", () => {
    test("should export and restore an empty filesystem", async () => {
        const blob : ArrayBuffer = await tfs.export();
        const view : DataView    = new DataView(blob);

        expect(view.getUint32(8, true)).toBe(FORMAT_VERSION);

        const restored : TinyFS  = await TinyFS.import("export_empty", blob);
        const sb       : StatBuf = { size: 0, mode: 0, nlink: 0 };
        const sret     : number  = await restored.stat("/", sb);

        expect(sret).toBe(0);
        expect((sb.mode & O.TYPE_MASK)).toBe(O.TYPE_DIR);

        restored.shutdown();
    });

    test("should export and restore files and directories", async () => {
        await tfs.mkdir("/export_a");
        await tfs.mkdir("/export_a/b");

        const fd   : number     = await tfs.open("/export_a/f", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array([1, 2, 3, 4, 5]);

        await tfs.write(fd, data, 5);
        tfs.close(fd);

        const blob      : ArrayBuffer = await tfs.export();
        const blob_view : DataView    = new DataView(blob);

        expect(blob_view.getUint32(8, true)).toBe(FORMAT_VERSION);

        const restored : TinyFS  = await TinyFS.import("export_fs", blob);
        const sb       : StatBuf = { size: 0, mode: 0, nlink: 0 };

        const sret_root : number = await restored.stat("/", sb);
        expect(sret_root).toBe(0);

        const sret_dir : number = await restored.stat("/export_a", sb);
        expect(sret_dir).toBe(0);
        expect((sb.mode & O.TYPE_MASK)).toBe(O.TYPE_DIR);

        const sret_sub : number = await restored.stat("/export_a/b", sb);
        expect(sret_sub).toBe(0);
        expect((sb.mode & O.TYPE_MASK)).toBe(O.TYPE_DIR);

        const fd2 : number     = await restored.open("/export_a/f", O.READ);
        const buf : Uint8Array = new Uint8Array(5);
        const nr  : number     = await restored.read(fd2, buf, 5);

        expect(nr).toBe(5);
        expect(buf).toEqual(data);

        restored.close(fd2);

        const entries = await restored.readdir("/export_a");
        expect(Array.isArray(entries)).toBe(true);
        expect((entries as DirEnt[]).length).toBe(2);

        restored.shutdown();
    });

    test("should export while filesystem is active", async () => {
        const fd   : number     = await tfs.open("/active_f", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array(100).fill(0xAB);

        await tfs.write(fd, data, 100);

        const blob : ArrayBuffer = await tfs.export();

        // Verify we can still use tfs after export.

        const sb_read : StatBuf = { size: 0, mode: 0, nlink: 0 };
        const sret    : number  = await tfs.stat("/active_f", sb_read);

        expect(sret).toBe(0);
        expect(sb_read.size).toBe(100);

        tfs.close(fd);

        // Restored copy has the data.

        const restored : TinyFS     = await TinyFS.import("export_active", blob);
        const fd2      : number     = await restored.open("/active_f", O.READ);
        const buf      : Uint8Array = new Uint8Array(100);
        const nr       : number     = await restored.read(fd2, buf, 100);

        expect(nr).toBe(100);
        expect(buf).toEqual(data);

        restored.close(fd2);
        restored.shutdown();
    });

    test("should export and restore multi-block data", async () => {
        const data : Uint8Array = new Uint8Array(tfs.block_size * 2 + 50).fill(0xCD);
        const fd   : number     = await tfs.open("/mb_data", O.CREATE | O.READ_WRITE);

        await tfs.write(fd, data, data.length);
        tfs.close(fd);

        const blob     : ArrayBuffer = await tfs.export();
        const restored : TinyFS      = await TinyFS.import("export_mb", blob);
        const fd2      : number      = await restored.open("/mb_data", O.READ);
        const buf      : Uint8Array  = new Uint8Array(data.length);
        const nr       : number      = await restored.read(fd2, buf, data.length);

        expect(nr).toBe(data.length);
        expect(buf).toEqual(data);

        restored.close(fd2);
        restored.shutdown();
    });

    test("should export and restore hard links", async () => {
        const fd   : number     = await tfs.open("/orig", O.CREATE | O.READ_WRITE);
        const data : Uint8Array = new Uint8Array([10, 20, 30]);

        await tfs.write(fd, data, 3);
        tfs.close(fd);

        await tfs.link("/orig", "/link1");
        await tfs.link("/orig", "/link2");

        const blob     : ArrayBuffer = await tfs.export();
        const restored : TinyFS      = await TinyFS.import("export_links", blob);

        const sb : StatBuf = { size: 0, mode: 0, nlink: 0 };

        await restored.stat("/orig", sb);
        expect(sb.nlink).toBe(3);

        for (const p of ["/orig", "/link1", "/link2"])
        {
            const fd2 : number     = await restored.open(p, O.READ);
            const buf : Uint8Array = new Uint8Array(3);
            const nr  : number     = await restored.read(fd2, buf, 3);

            expect(nr).toBe(3);
            expect(buf).toEqual(data);

            restored.close(fd2);
        }

        restored.shutdown();
    });

    test("should overwrite existing database on import", async () => {
        const fs1 : TinyFS = await TinyFS.create("export_overwrite");
        const fd1 : number = await fs1.open("/old", O.CREATE | O.READ_WRITE);

        await fs1.write(fd1, new Uint8Array([1, 2, 3]), 3);

        fs1.close(fd1);
        fs1.shutdown();

        const blob : ArrayBuffer = await tfs.export();
        const fs2  : TinyFS      = await TinyFS.import("export_overwrite", blob);

        const sb : StatBuf = { size: 0, mode: 0, nlink: 0 };

        expect(await fs2.stat("/old", sb)).toBe(-1);
        expect(await fs2.stat("/", sb)).toBe(0);

        fs2.shutdown();
    });

    test("should reject truncated blob", async () => {
        const truncated : ArrayBuffer = new Uint8Array(10).buffer;
        let threw = false;

        try
        {
            await TinyFS.import("export_trunc", truncated);
        }
        catch (e) { threw = true; }

        expect(threw).toBe(true);
    });

    test("should reject invalid blob", async () => {
        const garbage : ArrayBuffer = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer;

        let err : any;

        try
        {
            await TinyFS.import("export_bad", garbage);
        }
        catch (e) { err = e; }

        expect(err).toBeTruthy();
        expect((err as Error).message).toBe("Not a TinyFS blob");
    });
});


