const { O } = window.tinyfs;

window.__tests = {};
var tfs = null;

function test(name, fn)
{
    window.__tests[name] = async function () {
        // Close all fds.

        for (let i = 0; i < tfs.max_fd; i++)
        {
            if (tfs.fd_table[i].used)
                tfs.close(i);
        }

        tfs.dcache.clear();

        try
        {
            let result = await fn();
            return result === undefined || result === null ? null : result;
        }
        catch (e)
        {
            return e.message || String(e);
        }
    };
}

function ok(a, b)
{
    if (a !== b)
        return "expected " + JSON.stringify(a) + " to equal " + JSON.stringify(b);

    return null;
}

function okBuf(actual, expected, len)
{
    for (let i = 0; i < len; i++)
    {
        if (actual[i] !== expected[i])
            return "byte mismatch at " + i + ": got " + actual[i] + " expected " + expected[i];
    }

    return null;
}

// Test stat operations.

test("stat root directory", async function () {
    let buf = { size: 0, mode: 0, nlink: 0 };
    let ret = await tfs.stat("/", buf);

    if (ret !== 0)
        return "stat returned " + ret;

    if ((buf.mode & O.TYPE_MASK) !== O.TYPE_DIR)
        return "not a directory";

    if (buf.nlink !== 1)
        return "nlink is " + buf.nlink + " expected 1";

    return null;
});

test("stat nonexistent path", async function () {
    let buf = { size: 0, mode: 0, nlink: 0 };
    let ret = await tfs.stat("/nonexistent", buf);

    return ok(ret, -1);
});

test("stat a new directory", async function () {
    await tfs.mkdir("/statdir");

    let buf = { size: 0, mode: 0, nlink: 0 };
    let ret = await tfs.stat("/statdir", buf);

    if (ret !== 0)
        return "stat returned " + ret;

    if ((buf.mode & O.TYPE_MASK) !== O.TYPE_DIR)
        return "not a directory";

    return null;
});

test("stat a regular file", async function () {
    let fd = await tfs.open("/statfile", O.CREATE | O.READ_WRITE);

    await tfs.write(fd, new Uint8Array([1, 2, 3, 4, 5]), 5);

    tfs.close(fd);

    let buf = { size: 0, mode: 0, nlink: 0 };
    let ret = await tfs.stat("/statfile", buf);

    if (ret !== 0)
        return "stat returned " + ret;

    if ((buf.mode & O.TYPE_MASK) !== O.TYPE_FILE)
        return "not a regular file";

    if (buf.size !== 5)
        return "size is " + buf.size + " expected 5";

    return null;
});

// Test mkdir / rmdir operations.

test("mkdir and rmdir basic", async function () {
    let ret = await tfs.mkdir("/d");

    if (ret !== 0)
        return "mkdir returned " + ret;

    ret = await tfs.rmdir("/d");

    if (ret !== 0)
        return "rmdir returned " + ret;

    return null;
});

test("rmdir non-empty directory", async function () {
    await tfs.mkdir("/d");
    await tfs.mkdir("/d/e");
    let ret = await tfs.rmdir("/d");
    return ok(ret, -1);
});

test("mkdir existing returns -1", async function () {
    await tfs.mkdir("/exist");
    let ret = await tfs.mkdir("/exist");
    return ok(ret, -1);
});

test("mkdir missing parent returns -1", async function () {
    let ret = await tfs.mkdir("/a/b/c");
    return ok(ret, -1);
});

test("rmdir on root returns -1", async function () {
    let ret = await tfs.rmdir("/");
    return ok(ret, -1);
});

test("rmdir on regular file returns -1", async function () {
    let fd = await tfs.open("/rmfile", O.CREATE | O.READ_WRITE);
    tfs.close(fd);
    let ret = await tfs.rmdir("/rmfile");
    return ok(ret, -1);
});

// Test open / close operations.

test("open with CREATE succeeds", async function () {
    let fd = await tfs.open("/f", O.CREATE | O.READ_WRITE);

    if (fd < 0)
        return "open returned " + fd;

    tfs.close(fd);
    return null;
});

test("close invalid fd returns -1", function () {
    if (tfs.close(-1) !== -1)
        return "close(-1) should be -1";

    if (tfs.close(999) !== -1)
        return "close(999) should be -1";

    return null;
});

test("EXCLUSIVE fails on existing file", async function () {
    let fd1 = await tfs.open("/exclf", O.CREATE | O.READ_WRITE);
    tfs.close(fd1);
    let fd2 = await tfs.open("/exclf", O.CREATE | O.EXCLUSIVE | O.READ_WRITE);
    return ok(fd2, -1);
});

test("open dir with WRONLY returns -1", async function () {
    await tfs.mkdir("/odir");
    let fd = await tfs.open("/odir", O.WRITE);
    return ok(fd, -1);
});

test("open without CREATE on missing file returns -1", async function () {
    let fd = await tfs.open("/nope", O.READ_WRITE);
    return ok(fd, -1);
});

// Test write / read operations.

test("write and read back", async function () {
    let fd   = await tfs.open("/hello", O.CREATE | O.READ_WRITE);
    let data = new Uint8Array([72, 101, 108, 108, 111]);
    let nw   = await tfs.write(fd, data, data.length);

    if (nw !== data.length)
        return "wrote " + nw + " expected " + data.length;

    await tfs.lseek(fd, 0, O.SET);

    let buf = new Uint8Array(64);
    let nr  = await tfs.read(fd, buf, 64);

    if (nr !== data.length)
        return "read " + nr + " expected " + data.length;

    return okBuf(buf, data, nr);
});

test("read 0 bytes at EOF on fresh file", async function () {
    let fd  = await tfs.open("/empty", O.CREATE | O.READ_WRITE);
    let buf = new Uint8Array(10);
    let nr  = await tfs.read(fd, buf, 10);

    if (nr !== 0)
        return "read returned " + nr + " expected 0";

    tfs.close(fd);
    return null;
});

test("write across block boundary", async function () {
    let fd   = await tfs.open("/big", O.CREATE | O.READ_WRITE);
    let data = new Uint8Array(tfs.block_size + 100).fill(0x42);
    let nw   = await tfs.write(fd, data, data.length);

    if (nw !== data.length)
        return "wrote " + nw + " expected " + data.length;

    await tfs.lseek(fd, 0, O.SET);

    let buf = new Uint8Array(data.length);
    let nr  = await tfs.read(fd, buf, data.length);

    if (nr !== data.length)
        return "read " + nr + " expected " + data.length;

    return okBuf(buf, data, data.length);
});

test("READ rejects writes", async function () {
    let fd = await tfs.open("/ro", O.CREATE | O.READ);
    let nw = await tfs.write(fd, new Uint8Array([1]), 1);

    if (nw !== -1)
        return "write should return -1 got " + nw;

    tfs.close(fd);
    return null;
});

test("WRITE rejects reads", async function () {
    let fd = await tfs.open("/wo", O.CREATE | O.WRITE);
    let nr = await tfs.read(fd, new Uint8Array(1), 1);

    if (nr !== -1)
        return "read should return -1 got " + nr;

    tfs.close(fd);
    return null;
});

test("write 0 bytes returns 0", async function () {
    let fd = await tfs.open("/zero", O.CREATE | O.READ_WRITE);
    let nw = await tfs.write(fd, new Uint8Array(0), 0);

    if (nw !== 0)
        return "write returned " + nw;

    tfs.close(fd);
    return null;
});

// Test lseek operations.

test("lseek SET CURRENT END", async function () {
    let fd = await tfs.open("/seek", O.CREATE | O.READ_WRITE);

    await tfs.write(fd, new Uint8Array(100).fill(0xFF), 100);

    let off1 = await tfs.lseek(fd, 10, O.SET);
    if (off1 !== 10)
        return "SET returned " + off1;

    let off2 = await tfs.lseek(fd, 5, O.CURRENT);
    if (off2 !== 15)
        return "CURRENT returned " + off2;

    let off3 = await tfs.lseek(fd, 0, O.END);
    if (off3 !== 100)
        return "END returned " + off3;

    tfs.close(fd);
    return null;
});

test("lseek invalid whence returns -1", async function () {
    let fd  = await tfs.open("/lseekbad", O.CREATE | O.READ_WRITE);
    let ret = await tfs.lseek(fd, 0, 99);

    if (ret !== -1)
        return "expected -1 got " + ret;

    tfs.close(fd);
    return null;
});

// Test link / unlink operations.

test("hard link preserves data", async function () {
    let fd   = await tfs.open("/a", O.CREATE | O.READ_WRITE);
    let data = new Uint8Array([1, 2, 3]);

    await tfs.write(fd, data, 3);
    tfs.close(fd);

    let ret = await tfs.link("/a", "/b");
    if (ret !== 0)
        return "link returned " + ret;

    let fd2 = await tfs.open("/b", O.READ_WRITE);
    let buf = new Uint8Array(3);

    await tfs.read(fd2, buf, 3);

    tfs.close(fd2);
    return okBuf(buf, data, 3);
});

test("unlink directory returns -1", async function () {
    await tfs.mkdir("/linkdir");
    let ret = await tfs.unlink("/linkdir");
    return ok(ret, -1);
});

// Test TRUNCATE operations.

test("TRUNCATE clears file", async function () {
    let fd = await tfs.open("/truncf", O.CREATE | O.READ_WRITE);

    await tfs.write(fd, new Uint8Array(100).fill(0xAA), 100);

    tfs.close(fd);

    let fd2 = await tfs.open("/truncf", O.TRUNCATE | O.READ_WRITE);
    let buf = { size: 0, mode: 0, nlink: 0 };

    await tfs.stat("/truncf", buf);

    if (buf.size !== 0)
        return "size is " + buf.size + " expected 0";

    tfs.close(fd2);

    return null;
});

// Test APPEND operations.

test("APPEND appends regardless of seek", async function () {
    let fd   = await tfs.open("/append", O.CREATE | O.READ_WRITE | O.APPEND);
    let a    = new Uint8Array([65, 66]);
    let b    = new Uint8Array([67, 68]);
    let abcd = new Uint8Array([65, 66, 67, 68]);

    let nw1 = await tfs.write(fd, a, 2);
    if (nw1 !== 2)
        return "first write returned " + nw1;

    await tfs.lseek(fd, 0, O.SET);

    let nw2 = await tfs.write(fd, b, 2);
    if (nw2 !== 2)
        return "second write returned " + nw2;

    await tfs.lseek(fd, 0, O.SET);

    let buf = new Uint8Array(4);
    let nr  = await tfs.read(fd, buf, 4);

    if (nr !== 4)
        return "read " + nr + " expected 4";

    tfs.close(fd);
    return okBuf(buf, abcd, 4);
});

// Test readdir operations.

test("readdir lists entries", async function () {
    await tfs.mkdir("/rdir");
    await tfs.mkdir("/rdir/a");
    await tfs.mkdir("/rdir/b");

    let entries = await tfs.readdir("/rdir");

    if (!Array.isArray(entries))
        return "readdir returned " + entries;

    if (entries.length !== 2)
        return "expected 2 entries got " + entries.length;
    return null;
});

test("readdir on regular file returns -1", async function () {
    let fd = await tfs.open("/rdirfile", O.CREATE | O.READ_WRITE);
    tfs.close(fd);

    let ret = await tfs.readdir("/rdirfile");
    return ok(ret, -1);
});

// Test rename operations.

test("rename preserves data", async function () {
    let fd   = await tfs.open("/old", O.CREATE | O.READ_WRITE);
    let data = new Uint8Array([65, 66, 67]);

    await tfs.write(fd, data, 3);

    tfs.close(fd);

    let ret = await tfs.rename("/old", "/new");
    if (ret !== 0)
        return "rename returned " + ret;

    let sb   = { size: 0, mode: 0, nlink: 0 };
    let sret = await tfs.stat("/old", sb);

    if (sret !== -1)
        return "old should be gone";

    let fd2 = await tfs.open("/new", O.READ_WRITE);
    let buf = new Uint8Array(3);

    await tfs.read(fd2, buf, 3);

    tfs.close(fd2);
    return okBuf(buf, data, 3);
});

test("rename nonexistent source returns -1", async function () {
    let ret = await tfs.rename("/nope", "/b");
    return ok(ret, -1);
});

// Test rmdir edge cases operations.

test("rmdir nonexistent directory returns -1", async function () {
    let ret = await tfs.rmdir("/nope");
    return ok(ret, -1);
});

// Test open/close edge cases operations.

test("exhaust fd table gracefully", async function () {
    let fds = [];

    for (let i = 0; i < tfs.max_fd; i++)
    {
        let fd = await tfs.open("/fde_" + i, O.CREATE | O.READ_WRITE);

        if (fd < 0)
            break;

        fds.push(fd);
    }

    if (fds.length !== tfs.max_fd)
        return "got " + fds.length + " fds expected " + tfs.max_fd;

    let extra = await tfs.open("/fde_extra", O.CREATE | O.READ_WRITE);
    if (extra !== -1)
        return "extra open should return -1 got " + extra;

    for (let j = 0; j < fds.length; j++)
        tfs.close(fds[j]);
});

// Test write/read edge cases operations.

test("handle partial read", async function () {
    let fd   = await tfs.open("/partial", O.CREATE | O.READ_WRITE);
    let data = new Uint8Array(100).fill(0xAB);

    await tfs.write(fd, data, 100);
    await tfs.lseek(fd, 0, O.SET);

    let buf = new Uint8Array(30);
    let nr  = await tfs.read(fd, buf, 30);

    if (nr !== 30)
        return "first read returned " + nr + " expected 30";

    let err = okBuf(buf, new Uint8Array(30).fill(0xAB), 30);
    if (err)
        return err;

    let buf2 = new Uint8Array(70);
    let nr2 = await tfs.read(fd, buf2, 70);

    if (nr2 !== 70)
        return "second read returned " + nr2 + " expected 70";

    tfs.close(fd);
    return okBuf(buf2, new Uint8Array(70).fill(0xAB), 70);
});

test("overwrite at offset after seek", async function () {
    let fd = await tfs.open("/rw", O.CREATE | O.READ_WRITE);
    let a  = new Uint8Array([1, 2, 3]);
    let b  = new Uint8Array([4, 5, 6]);

    await tfs.write(fd, a, 3);
    await tfs.lseek(fd, 0, O.SET);
    await tfs.write(fd, b, 3);

    await tfs.lseek(fd, 0, O.SET);

    let buf = new Uint8Array(6);
    let nr  = await tfs.read(fd, buf, 6);

    if (nr !== 3)
        return "read returned " + nr + " expected 3";

    tfs.close(fd);
    return okBuf(buf, new Uint8Array([4, 5, 6]), 3);
});

test("write on directory fd returns -1", async function () {
    await tfs.mkdir("/writedir");

    let fd = await tfs.open("/writedir", O.READ);
    let nw = await tfs.write(fd, new Uint8Array([1]), 1);

    tfs.close(fd);
    return ok(nw, -1);
});

test("read 0 bytes returns 0", async function () {
    let fd  = await tfs.open("/r0", O.CREATE | O.READ_WRITE);
    let buf = new Uint8Array(0);
    let nr  = await tfs.read(fd, buf, 0);

    tfs.close(fd);
    return ok(nr, 0);
});

test("read on directory fd returns -1", async function () {
    await tfs.mkdir("/readdirfd");

    let fd = await tfs.open("/readdirfd", O.READ);
    let nr = await tfs.read(fd, new Uint8Array(1), 1);

    tfs.close(fd);
    return ok(nr, -1);
});

// Test lseek edge cases operations.

test("lseek invalid fd returns -1", async function () {
    let ret = await tfs.lseek(-1, 0, O.SET);
    return ok(ret, -1);
});

// Test link / unlink more operations.

test("decrement nlink on unlink", async function () {
    let fd = await tfs.open("/nl_a", O.CREATE | O.READ_WRITE);
    tfs.close(fd);

    await tfs.link("/nl_a", "/nl_b");

    let buf = { size: 0, mode: 0, nlink: 0 };
    await tfs.stat("/nl_a", buf);

    if (buf.nlink !== 2)
        return "nlink after link is " + buf.nlink + " expected 2";

    await tfs.unlink("/nl_b");
    await tfs.stat("/nl_a", buf);

    if (buf.nlink !== 1)
        return "nlink after unlink is " + buf.nlink + " expected 1";

    await tfs.unlink("/nl_a");
    return null;
});

test("link directory returns -1", async function () {
    await tfs.mkdir("/ldir");
    let ret = await tfs.link("/ldir", "/le");
    return ok(ret, -1);
});

// Test link error cases operations.

test("link nonexistent source returns -1", async function () {
    let ret = await tfs.link("/nonexistent", "/b");
    return ok(ret, -1);
});

test("link target exists returns -1", async function () {
    let fd_a = await tfs.open("/tex_a", O.CREATE | O.READ_WRITE);
    tfs.close(fd_a);

    let fd_b = await tfs.open("/tex_b", O.CREATE | O.READ_WRITE);
    tfs.close(fd_b);

    let ret = await tfs.link("/tex_a", "/tex_b");
    return ok(ret, -1);
});

// Test unlink error cases operations.

test("unlink nonexistent path returns -1", async function () {
    let ret = await tfs.unlink("/unlnope");
    return ok(ret, -1);
});

test("unlink root returns -1", async function () {
    let ret = await tfs.unlink("/");
    return ok(ret, -1);
});

// Test TRUNCATE edge cases operations.

test("TRUNCATE no-op on empty file", async function () {
    let fd1 = await tfs.open("/trunc0", O.CREATE | O.READ_WRITE);

    tfs.close(fd1);

    let fd2 = await tfs.open("/trunc0", O.TRUNCATE | O.READ_WRITE);
    let buf = { size: 0, mode: 0, nlink: 0 };

    await tfs.stat("/trunc0", buf);

    if (buf.size !== 0)
        return "size is " + buf.size + " expected 0";

    tfs.close(fd2);
    return null;
});

test("TRUNCATE fails without CREATE on nonexistent file", async function () {
    let fd = await tfs.open("/nonexistent_trunc", O.TRUNCATE | O.READ_WRITE);
    return ok(fd, -1);
});

// Test nested directories operations.

test("create and stat deeply nested dirs", async function () {
    await tfs.mkdir("/nest_a");
    await tfs.mkdir("/nest_a/b");
    await tfs.mkdir("/nest_a/b/c");

    let buf = { size: 0, mode: 0, nlink: 0 };
    let ret = await tfs.stat("/nest_a/b/c", buf);

    if (ret !== 0)
        return "stat returned " + ret;

    if ((buf.mode & O.TYPE_MASK) !== O.TYPE_DIR)
        return "not a directory";

    return null;
});

// Test path resolution operations.

test("path normalization with ..", async function () {
    await tfs.mkdir("/pa");
    await tfs.mkdir("/pa/b");

    let buf = { size: 0, mode: 0, nlink: 0 };
    let ret = await tfs.stat("/pa/b/../b", buf);

    if (ret !== 0)
        return "stat returned " + ret;

    if ((buf.mode & O.TYPE_MASK) !== O.TYPE_DIR)
        return "not a directory";

    return null;
});

// Test multi-fd operations.

test("two fds to same file write via one read via the other", async function () {
    let fd1  = await tfs.open("/shared", O.CREATE | O.READ_WRITE);
    let fd2  = await tfs.open("/shared", O.READ_WRITE);
    let data = new Uint8Array([10, 20, 30]);
    let nw   = await tfs.write(fd1, data, 3);

    if (nw !== 3)
        return "write returned " + nw;

    let buf = new Uint8Array(3);
    let nr  = await tfs.read(fd2, buf, 3);

    tfs.close(fd1);
    tfs.close(fd2);

    if (nr !== 3)
        return "read returned " + nr;

    return okBuf(buf, data, 3);
});

// Test interleaved operations.

test("open unlink close close succeeds after unlink", async function () {
    let fd = await tfs.open("/unlinkme", O.CREATE | O.READ_WRITE);

    await tfs.write(fd, new Uint8Array([1, 2, 3]), 3);

    let ul_ret = await tfs.unlink("/unlinkme");
    if (ul_ret !== 0)
        return "unlink returned " + ul_ret;

    await tfs.lseek(fd, 0, O.SET);

    let buf = new Uint8Array(3);

    let nr = await tfs.read(fd, buf, 3);
    if (nr !== -1)
        return "read should return -1 got " + nr;

    let c_ret = tfs.close(fd);
    if (c_ret !== 0)
        return "close returned " + c_ret;

    let sb = { size: 0, mode: 0, nlink: 0 };

    let sret = await tfs.stat("/unlinkme", sb);
    if (sret !== -1)
        return "stat should return -1 got " + sret;

    return null;
});

// Test block-boundary writes operations.

test("write exactly BLOCK_SIZE bytes", async function () {
    let fd   = await tfs.open("/exactb", O.CREATE | O.READ_WRITE);
    let data = new Uint8Array(tfs.block_size).fill(0xAA);

    let nw = await tfs.write(fd, data, tfs.block_size);
    if (nw !== tfs.block_size)
        return "wrote " + nw;

    await tfs.lseek(fd, 0, O.SET);

    let buf = new Uint8Array(tfs.block_size);
    let nr  = await tfs.read(fd, buf, tfs.block_size);

    tfs.close(fd);

    if (nr !== tfs.block_size)
        return "read " + nr;

    return okBuf(buf, data, tfs.block_size);
});

test("write BLOCK_SIZE + 1 bytes cross one boundary", async function () {
    let fd   = await tfs.open("/crossb", O.CREATE | O.READ_WRITE);
    let data = new Uint8Array(tfs.block_size + 1).fill(0xBB);
    let nw   = await tfs.write(fd, data, tfs.block_size + 1);

    if (nw !== tfs.block_size + 1)
        return "wrote " + nw;

    await tfs.lseek(fd, 0, O.SET);

    let buf = new Uint8Array(tfs.block_size + 1);
    let nr  = await tfs.read(fd, buf, tfs.block_size + 1);

    tfs.close(fd);

    if (nr !== tfs.block_size + 1)
        return "read " + nr;

    return okBuf(buf, data, tfs.block_size + 1);
});

test("write 2 times BLOCK_SIZE bytes", async function () {
    let fd   = await tfs.open("/twofull", O.CREATE | O.READ_WRITE);
    let len  = tfs.block_size * 2;
    let data = new Uint8Array(len).fill(0xCC);
    let nw   = await tfs.write(fd, data, len);

    if (nw !== len)
        return "wrote " + nw;

    await tfs.lseek(fd, 0, O.SET);

    let buf = new Uint8Array(len);
    let nr  = await tfs.read(fd, buf, len);

    tfs.close(fd);

    if (nr !== len)
        return "read " + nr;

    return okBuf(buf, data, len);
});

// Test hard-link nlink lifecycle operations.

test("unlink one link preserves data via the other", async function () {
    let fd   = await tfs.open("/orig", O.CREATE | O.READ_WRITE);
    let data = new Uint8Array([10, 20, 30]);

    await tfs.write(fd, data, 3);
    tfs.close(fd);

    let ret = await tfs.link("/orig", "/link");
    if (ret !== 0)
        return "link returned " + ret;

    ret = await tfs.unlink("/orig");
    if (ret !== 0)
        return "unlink orig returned " + ret;

    let fd2 = await tfs.open("/link", O.READ_WRITE);
    let buf = new Uint8Array(3);
    let nr  = await tfs.read(fd2, buf, 3);

    tfs.close(fd2);

    if (nr !== 3)
        return "read " + nr;

    let err = okBuf(buf, data, 3);

    if (err)
        return err;

    await tfs.unlink("/link");

    return null;
});

test("unlink all links deletes file", async function () {
    let fd = await tfs.open("/hapath", O.CREATE | O.READ_WRITE);
    tfs.close(fd);

    await tfs.link("/hapath", "/hbpath");
    await tfs.unlink("/hapath");

    let sb  = { size: 0, mode: 0, nlink: 0 };
    let ret = await tfs.stat("/hbpath", sb);

    if (ret !== 0)
        return "stat /hbpath returned " + ret;

    await tfs.unlink("/hbpath");

    ret = await tfs.stat("/hbpath", sb);
    if (ret !== -1)
        return "stat after all unlinks should return -1 got " + ret;

    return null;
});

// Test sparse file operations.

test("sparse file seek past EOF write read back", async function () {
    let fd       = await tfs.open("/sparse", O.CREATE | O.READ_WRITE);
    let gap      = 1000;
    let data     = new Uint8Array([0xDE, 0xAD]);
    let expected = new Uint8Array(gap + data.length);

    expected.set(data, gap);

    await tfs.lseek(fd, gap, O.SET);

    let nw = await tfs.write(fd, data, data.length);

    if (nw !== data.length)
        return "wrote " + nw;

    await tfs.lseek(fd, 0, O.SET);

    let buf = new Uint8Array(expected.length);
    let nr  = await tfs.read(fd, buf, expected.length);

    tfs.close(fd);

    if (nr !== expected.length)
        return "read " + nr;

    return okBuf(buf, expected, expected.length);
});

// Test APPEND with two fds operations.

test("APPEND with two fds both append to end", async function () {
    let fd_a = await tfs.open("/dualapp", O.CREATE | O.READ_WRITE | O.APPEND);
    let fd_b = await tfs.open("/dualapp", O.READ_WRITE | O.APPEND);

    let nw_a = await tfs.write(fd_a, new Uint8Array([65]), 1);
    if (nw_a !== 1)
        return "first write returned " + nw_a;

    let nw_b = await tfs.write(fd_b, new Uint8Array([66]), 1);
    if (nw_b !== 1)
        return "second write returned " + nw_b;

    await tfs.lseek(fd_a, 0, O.SET);

    let buf = new Uint8Array(2);
    let nr  = await tfs.read(fd_a, buf, 2);

    tfs.close(fd_a);
    tfs.close(fd_b);

    if (nr !== 2)
        return "read " + nr;

    return okBuf(buf, new Uint8Array([65, 66]), 2);
});

// Test fd slot reuse operations.

test("fd slot reuse after close", async function () {
    let fds = [];

    for (let i = 0; i < tfs.max_fd; i++)
    {
        let fd = await tfs.open("/reuse_" + i, O.CREATE | O.READ_WRITE);

        if (fd < 0)
            return "open failed at " + i;

        fds.push(fd);
    }

    tfs.close(fds[0]);

    let new_fd = await tfs.open("/reuse_new", O.CREATE | O.READ_WRITE);
    if (new_fd !== fds[0])
        return "expected fd " + fds[0] + " got " + new_fd;

    for (let j = 1; j < tfs.max_fd; j++)
        tfs.close(fds[j]);

    tfs.close(new_fd);
    return null;
});

// Test read count clamping operations.

test("read fewer bytes than requested near EOF", async function () {
    let fd   = await tfs.open("/small", O.CREATE | O.READ_WRITE);
    let data = new Uint8Array([1, 2, 3, 4, 5]);

    await tfs.write(fd, data, 5);
    await tfs.lseek(fd, 3, O.SET);

    let buf = new Uint8Array(10);
    let nr  = await tfs.read(fd, buf, 10);

    tfs.close(fd);

    if (nr !== 2)
        return "read returned " + nr + " expected 2";

    if (buf[0] !== 4)
        return "byte 0 is " + buf[0] + " expected 4";

    if (buf[1] !== 5)
        return "byte 1 is " + buf[1] + " expected 5";

    return null;
});

// Test readdir more operations.

test("readdir empty directory returns empty array", async function () {
    await tfs.mkdir("/rd_empty");

    let entries = await tfs.readdir("/rd_empty");

    if (!Array.isArray(entries))
        return "readdir returned " + entries;

    if (entries.length !== 0)
        return "expected 0 entries got " + entries.length;

    return null;
});

test("readdir nonexistent path returns -1", async function () {
    let ret = await tfs.readdir("/rd_nope");
    return ok(ret, -1);
});

// Test rename more operations.

test("rename overwrite existing target", async function () {
    let fd_a = await tfs.open("/ren_a", O.CREATE | O.READ_WRITE);
    let d_a  = new Uint8Array([1, 2, 3]);

    await tfs.write(fd_a, d_a, 3);

    tfs.close(fd_a);

    let fd_b = await tfs.open("/ren_b", O.CREATE | O.READ_WRITE);
    let d_b  = new Uint8Array([4, 5, 6]);

    await tfs.write(fd_b, d_b, 3);
    tfs.close(fd_b);

    let ret = await tfs.rename("/ren_a", "/ren_b");
    if (ret !== 0)
        return "rename returned " + ret;

    let fd  = await tfs.open("/ren_b", O.READ_WRITE);
    let buf = new Uint8Array(3);

    await tfs.read(fd, buf, 3);

    tfs.close(fd);

    let err = okBuf(buf, d_a, 3);
    if (err)
        return err;

    let sb   = { size: 0, mode: 0, nlink: 0 };
    let sret = await tfs.stat("/ren_a", sb);

    if (sret !== -1)
        return "old should be gone";

    return null;
});

test("rename directory source returns -1", async function () {
    await tfs.mkdir("/dirsrc");
    let ret = await tfs.rename("/dirsrc", "/dirdst");
    return ok(ret, -1);
});

test("rename target parent missing returns -1", async function () {
    let fd = await tfs.open("/rename_me", O.CREATE | O.READ_WRITE);
    tfs.close(fd);

    let ret = await tfs.rename("/rename_me", "/nope/b");
    return ok(ret, -1);
});
