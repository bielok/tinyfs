var tfs = null;


// Within a single IDB transaction. By injecting a transaction abort after a
// specific mutation, we simulate a browser crash mid-operation. IDB's atomicity
// guarantee ensures all prior mutations in the transaction are rolled back.
//
// The patching: IDBObjectStore.prototype.{put, add, delete} are wrapped to
// count mutations. __atomicity.abortAfter(N) sets the counter so that after
// mutation N completes, the enclosing transaction is aborted via queueMicrotask.
// The abort fires before the next IDB event (microtasks run before macrotasks),
// causing the pending IDBRequest to error and the _idbRequest promise to
// reject. tinyfs's async function receives the rejection, and the transaction's
// undo log restores all preceding mutations.
//
// Each test:
//   1. Sets up known filesystem state.
//   2. Takes a snapshot (stat/read).
//   3. __atomicity.abortAfter(0) -- arms the abort on the first mutation.
//   4. Runs the syscall, then fails because the transaction is aborted.
//   5. __atomicity.reset() disarms the abort.
//   6. Verifies the database state matches the pre-op snapshot (new transaction).

(function () {
    let originalPut    = IDBObjectStore.prototype.put;
    let originalAdd    = IDBObjectStore.prototype.add;
    let originalDelete = IDBObjectStore.prototype.delete;

    let mutationCount = 0;
    let abortTarget   = -1;

    function wrap (method)
    {
        return function () {
            let idx    = mutationCount++;
            let result = method.apply(this, arguments);

            // If this mutation is at or past the target, abort the transaction
            // via queueMicrotask so _idbRequest has attached its handlers first.

            if (abortTarget >= 0 && idx >= abortTarget)
            {
                let tx = this.transaction;
                queueMicrotask(function () { tx.abort(); });
            }

            return result;
        };
    }

    IDBObjectStore.prototype.put    = wrap(originalPut);
    IDBObjectStore.prototype.add    = wrap(originalAdd);
    IDBObjectStore.prototype.delete = wrap(originalDelete);

    let tests = {};

    function test (name, fn)
    {
        tests[name] = async function () {
            mutationCount = 0;
            abortTarget   = -1;

            for (let i = 0; i < tfs.max_fd; i++)
            {
                if (tfs.fd_table[i].used)
                    tfs.close(i);
            }

            tfs._dcache.clear();

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

    window.__atomicity = {
        // Resets the abort counter so subsequent IDB operations run normally.

        reset: function () {
            mutationCount = 0; abortTarget = -1;
        },

        // Arms the abort: the next N mutations complete, then the Nth+1 mutation
        // triggers queueMicrotask(abort), rolling back mutations 0..N.

        tests: tests,

        abortAfter: function (n) {
            mutationCount = 0; abortTarget = n;
        },
    };

    // Test write atomicity:
    //
    // A write() transaction does: putBlock (data) then putInode (size update).
    // Aborting after the first putBlock rolls back the block write. The file
    // must retain its pre-write content and size.

    test("write rolls back on block put failure", async function () {
        let fd = await tfs.open("/tw", tfs.CREATE | tfs.READ_WRITE);
        await tfs.write(fd, new Uint8Array([72, 105]), 2);
        tfs.close(fd);

        let sb = { size: 0, mode: 0, nlink: 0 };

        await tfs.stat("/tw", sb);

        __atomicity.abortAfter(0);

        fd = await tfs.open("/tw", tfs.READ_WRITE);

        try
        {
            await tfs.write(fd, new Uint8Array(200).fill(0xBB), 200);
        } catch (e) {}

        tfs.close(fd);
        __atomicity.reset();

        let sb2 = { size: 0, mode: 0, nlink: 0 };

        await tfs.stat("/tw", sb2);

        if (sb2.size !== sb.size)
            return "size changed from " + sb.size + " to " + sb2.size;

        fd = await tfs.open("/tw", tfs.READ);

        let buf = new Uint8Array(10);
        let nr  = await tfs.read(fd, buf, 10);

        tfs.close(fd);

        if (nr !== 2 || buf[0] !== 72 || buf[1] !== 105)
            return "content corrupted";

        return null;
    });

    // Test mkdir atomicity.
    //
    // mkdir() does: store.add (inode) then putInode (parent entries).
    // Aborting after the add prevents the directory from appearing in the
    // parent. The directory must not exist on a subsequent stat.

    test("mkdir rolls back on add failure", async function () {
        __atomicity.abortAfter(0);

        try
        {
            await tfs.mkdir("/ta");
        } catch (e) {}

        __atomicity.reset();

        let sb  = { size: 0, mode: 0, nlink: 0 };
        let ret = await tfs.stat("/ta", sb);

        if (ret !== -1)
            return "dir exists after failed mkdir";

        return null;
    });

    // Test unlink atomicity.
    //
    // unlink() does: putInode (parent entry removed), possibly deleteInode
    // (child) and deleteBlocks (data). Aborting after the first putInode
    // rolls back the parent entry removal. The file must still exist with
    // its original size and content.

    test("unlink rolls back on parent update failure", async function () {
        let fd = await tfs.open("/tu", tfs.CREATE | tfs.READ_WRITE);

        await tfs.write(fd, new Uint8Array([65, 66, 67]), 3);

        tfs.close(fd);

        let sb = { size: 0, mode: 0, nlink: 0 };

        await tfs.stat("/tu", sb);

        __atomicity.abortAfter(0);

        try
        {
            await tfs.unlink("/tu");
        } catch (e) {}

        __atomicity.reset();

        let sb2 = { size: 0, mode: 0, nlink: 0 };
        let ret = await tfs.stat("/tu", sb2);

        if (ret !== 0)
            return "file missing after failed unlink";

        if (sb2.size !== sb.size)
            return "size changed after failed unlink";

        fd = await tfs.open("/tu", tfs.READ);

        let buf = new Uint8Array(10);
        let nr  = await tfs.read(fd, buf, 10);

        tfs.close(fd);

        if (nr !== 3 || buf[0] !== 65 || buf[1] !== 66 || buf[2] !== 67)
            return "content corrupted after failed unlink";

        return null;
    });

    // Test rename atomicity.
    //
    // rename() does up to three putInode calls (old inode nlink++, new parent
    // entry, old parent entry removal). Aborting after the first putInode
    // rolls back all of them. The source must still exist and the target
    // must not.

    test("rename rolls back on first mutation failure", async function () {
        let fd = await tfs.open("/tr_old", tfs.CREATE | tfs.READ_WRITE);

        await tfs.write(fd, new Uint8Array([1, 2, 3]), 3);
        tfs.close(fd);

        __atomicity.abortAfter(0);

        try
        {
            await tfs.rename("/tr_old", "/tr_new");
        } catch (e) {}

        __atomicity.reset();

        let sb  = { size: 0, mode: 0, nlink: 0 };
        let ret = await tfs.stat("/tr_old", sb);

        if (ret !== 0)
            return "old path missing after failed rename";

        ret = await tfs.stat("/tr_new", sb);

        if (ret !== -1)
            return "new path exists after failed rename";

        return null;
    });

    // Test TRUNCATE atomicity.
    //
    // open(TRUNCATE) does: putInode(size=0) then deleteBlocks(range).
    // Aborting after the first putInode rolls back the size update and
    // the block deletion never runs. The file must retain its original
    // size and all data.

    test("TRUNCATE rolls back on size update failure", async function () {
        let fd = await tfs.open("/tt", tfs.CREATE | tfs.READ_WRITE);

        await tfs.write(fd, new Uint8Array(8192).fill(0xAA), 8192);

        tfs.close(fd);

        let sb     = { size: 0, mode: 0, nlink: 0 };
        let origSz = (await tfs.stat("/tt", sb), sb.size);

        __atomicity.abortAfter(0);

        try
        {
            let fd2 = await tfs.open("/tt", tfs.TRUNCATE | tfs.READ_WRITE);
            tfs.close(fd2);
        } catch (e) {}

        __atomicity.reset();

        let sb2 = { size: 0, mode: 0, nlink: 0 };

        await tfs.stat("/tt", sb2);

        if (sb2.size !== origSz)
            return "size changed from " + origSz + " to " + sb2.size;

        fd = await tfs.open("/tt", tfs.READ);

        let buf = new Uint8Array(100);
        let nr  = await tfs.read(fd, buf, 100);

        tfs.close(fd);

        if (nr !== 100)
            return "read returned " + nr;

        for (let i = 0; i < nr; i++)
        {
            if (buf[i] !== 0xAA)
                return "byte " + i + " corrupted";
        }

        return null;
    });
})();
