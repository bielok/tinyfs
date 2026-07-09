type int   = number;
type uint  = number;

export
interface INode
{
    id      : int | undefined;
    mode    : int;
    nlink   : uint;
    size    : uint;
    entries : Record<string, int> | undefined;
}

export
interface FileBlock
{
    inode_id    : int;
    block_index : uint;
    data        : Uint8Array;
}

export
interface FileDescriptor
{
    inode_id : int;
    offset   : int;
    flags    : int;
    used     : boolean;
}

export
interface DirEnt
{
    id   : int;
    name : string;
}

interface FdLockEntry
{
    resolve : () => void;
    promise : Promise<void>;
}

export
interface StatBuf
{
    size  : uint;
    mode  : int;
    nlink : uint;
}

export
interface PathResolution
{
    id   : int;
    name : string;
}

export
interface TinyFSOptions
{
    block_size? : uint;
    max_fd?     : int;
}

export
const READ : int = 0x00;

export
const WRITE : int = 0x01;

export
const READ_WRITE : int = 0x02;

export
const ACCESS_MODE : int = 0x03;

export
const CREATE : int = 0x40;

export
const EXCLUSIVE : int = 0x80;

export
const TRUNCATE : int = 0x200;

export
const APPEND : int = 0x400;

export
const SET : int = 0;

export
const CURRENT : int = 1;

export
const END : int = 2;

export
const TYPE_MASK : int = 0o170000;

export
const TYPE_DIR : int = 0o040000;

export
const TYPE_FILE : int = 0o100000;

export
const BLOCK_SIZE : uint = 4096;

export
const MAX_FD: int = 256;

export
const ROOT_INODE : IDBValidKey = 1;

export
const DB_VERSION : uint = 1;

export
const STORE_INODES : string = "inodes";

export
const STORE_BLOCKS : string = "blocks";

const TX_READ_WRITE : IDBTransactionMode = "readwrite";
const TX_READ_ONLY  : IDBTransactionMode = "readonly";

export
type INodeID = uint;

/**
 * Wraps an IDBRequest into a Promise.
 * Resolves with req.result on success, rejects with req.error on failure.
 */

function _idbRequest<T> (
    req : IDBRequest<T>
) : Promise<T>
{
    function handler (
        resolve : (value: T)     => void,
        reject  : (reason?: any) => void
    ) : void
    {
        req.onsuccess = function () : void
        {
            resolve(req.result);
        }

        req.onerror = function () : void
        {
            reject(req.error);
        }
    }

    return new Promise<T>(handler);
}

export
class TinyFS
{
    static readonly MAGIC       : Uint8Array = new TextEncoder().encode("_TINYFS_");
    static readonly HEADER_SIZE : uint       = 8 + 4 + 4 + 4; // magic + version + inode_ct + block_ct.

    readonly block_size : uint        = BLOCK_SIZE;
    readonly max_fd     : int         = MAX_FD;
    readonly encoder    : TextEncoder = new TextEncoder();
    readonly decoder    : TextDecoder = new TextDecoder();

    fs_db    : IDBDatabase | null            = null;
    dcache   : Map<string, int>              = new Map();
    fd_table : FileDescriptor[]              = [];
    fd_mutex : (FdLockEntry[] | undefined)[] = [];

    private constructor (
        opts? : TinyFSOptions
    )
    {
        this.block_size = opts?.block_size ?? BLOCK_SIZE;
        this.max_fd     = opts?.max_fd     ?? MAX_FD;
        this.fd_table   = new Array(this.max_fd);

        for (let i = 0; i < this.max_fd; i++)
            this.fd_table[i] = { inode_id: 0, offset: -1, flags: 0, used: false };
    }

    async lockFd (
        fd : int
    ) : Promise<() => void>
    {
        const queue : FdLockEntry[] = this.fd_mutex[fd] || (this.fd_mutex[fd] = []);

        let resolve: () => void;

        const promise = new Promise<void>(r => { resolve = r; });

        if (queue.length === 0)
        {
            queue.push({ resolve: () => {}, promise: new Promise(() => {}) });
            queue.push({ resolve: resolve!, promise });

            return () => this.unlockFd(fd);
        }

        queue.push({ resolve: resolve!, promise });

        await queue[queue.length - 2]!.promise;

        return () => this.unlockFd(fd);
    }

    unlockFd (fd : int) : void
    {
        const queue = this.fd_mutex[fd];

        if (queue === undefined || queue.length === 0)
            return;

        queue.shift();

        if (queue.length > 0)
            queue[0]!.resolve();
        else
            this.fd_mutex[fd] = undefined;
    }

    /**
     * Opens or creates an IndexedDB database and ensures a root directory
     * exists.
     *
     * The caller supplies the database name as the first argument, so multiple
     * filesystem instances (or test isolation) use independent databases.
     *
     * Must be called once before any other filesystem operation.
     * Calling again after a successful init is safe and returns 0.
     *
     * @param db_name  Name of the IndexedDB database to open / create.
     *
     * @returns 0 on success, -1 on failure.
     */

    static async create (
        db_name : string,
        opts?   : TinyFSOptions
    ) : Promise<TinyFS>
    {
        const fs = new TinyFS(opts);

        await new Promise<int>((resolve, reject) => {
            function handleUpgrade (
                e : IDBVersionChangeEvent
            ) : void
            {
                const db : IDBDatabase = (e.target as IDBOpenDBRequest).result;

                if (e.oldVersion < 1)
                {
                    db.createObjectStore(STORE_INODES, { keyPath: "id", autoIncrement: true });
                    db.createObjectStore(STORE_BLOCKS, { keyPath: [ "inode_id", "block_index" ] });
                }
            }

            function handleSuccess (
                e : Event
            ) : void
            {
                fs.fs_db = (e.target as IDBOpenDBRequest).result;

                const tx       : IDBTransaction                = fs.fs_db.transaction([STORE_INODES], TX_READ_WRITE);
                const store    : IDBObjectStore                = tx.objectStore(STORE_INODES);
                const root_req : IDBRequest<INode | undefined> = store.get(ROOT_INODE);

                root_req.onsuccess = handleRootSuccess;
                root_req.onerror   = handleError;

                function handleRootSuccess () : void
                {
                    if (root_req.result === undefined)
                    {
                        const root_inode =  {
                              mode:    TYPE_DIR | 0o755,
                              nlink:   1,
                              size:    0,
                              entries: {}
                        };

                        const add_req           = store.add(root_inode) as IDBRequest<IDBValidKey>;
                              add_req.onsuccess = () : void => resolve(0);
                              add_req.onerror   = handleError;
                    }
                    else
                    {
                        resolve(0);
                    }
                }
            }

            function handleError() : void
            {
                reject(-1);
            }

            const req                 = indexedDB.open(db_name, DB_VERSION);
                  req.onupgradeneeded = handleUpgrade;
                  req.onsuccess       = handleSuccess;
                  req.onerror         = handleError;
                  req.onblocked       = handleError;
        });

        return fs;
    }

    /**
     * Reads an inode by ID.
     *
     * @returns The inode, or null if it does not exist.
     */

    async _getInode (
        tx : IDBTransaction,
        id : int
    ) : Promise<INode | null>
    {
        const store : IDBObjectStore    = tx.objectStore(STORE_INODES);
        const inode : INode | undefined = await _idbRequest<INode | undefined>(store.get(id));

        return inode === undefined ? null : inode;
    }

    /**
     * Writes an inode to the store. Replaces an existing inode with
     * the same id or creates a new entry.
     *
     * @returns The inode id.
     */

    _putInode (
        tx    : IDBTransaction,
        inode : INode
    ) : Promise<INodeID>
    {
        const store : IDBObjectStore = tx.objectStore(STORE_INODES);
        return _idbRequest(store.put(inode)) as Promise<INodeID>;
    }

    /**
     * Deletes an inode by id.
     */

    _deleteInode (
        tx : IDBTransaction,
        id : INodeID
    ) : Promise<void>
    {
        const store : IDBObjectStore = tx.objectStore(STORE_INODES);
        return _idbRequest(store.delete(id));
    }

    /**
     * Creates a new inode in the store.
     *
     * The id is assigned by IndexedDB's autoIncrement generator. Directories
     * receive an empty entries map; regular files get entries set to undefined.
     *
     * @returns The newly created inode with its assigned id populated.
     */

    async _createInode (
        tx   : IDBTransaction,
        mode : int
    ) : Promise<INode>
    {
        const inode : Partial<INode> = {
            mode:  mode,
            nlink: 1,
            size:  0,
        };

        if ((mode & TYPE_MASK) === TYPE_DIR)
            inode.entries = {};

        const store : IDBObjectStore = tx.objectStore(STORE_INODES);

        inode.id = await _idbRequest(store.add(inode)) as int;

        return inode as INode;
    }

    /**
     * Reads a data block for a file.
     *
     * @returns The block data, or null if no block exists at that index.
     */

    async _getBlock (
        tx          : IDBTransaction,
        inode_id    : int,
        block_index : uint
    ) : Promise<Uint8Array | null>
    {
        const store : IDBObjectStore = tx.objectStore(STORE_BLOCKS);
        const d     : any = await _idbRequest(store.get([inode_id, block_index]));

        return d ? d.data : null;
    }

    /**
     * Writes a data block to the store. Replaces an existing block at the same
     * (inode_id, block_index) or creates a new entry.
     */

    _putBlock (
        tx          : IDBTransaction,
        inode_id    : int,
        block_index : uint,
        data        : Uint8Array
    ) : Promise<IDBValidKey>
    {
        const store : IDBObjectStore = tx.objectStore(STORE_BLOCKS);

        const block : FileBlock = {
            inode_id:    inode_id,
            block_index: block_index,
            data:        data,
        };

        return _idbRequest(store.put(block));
    }

    /**
     * Deletes all data blocks belonging to an inode.
     */

    _deleteBlocks (
        tx       : IDBTransaction,
        inode_id : int
    ) : Promise<void>
    {
        const store : IDBObjectStore = tx.objectStore(STORE_BLOCKS);
        const range : IDBKeyRange    = IDBKeyRange.bound([inode_id, 0], [inode_id, Number.MAX_SAFE_INTEGER]);

        return _idbRequest(store.delete(range));
    }

    /**
     * Resolves a path string to an inode id.
     *
     * Paths are normalised via the URL API, which handles ".", "..", and
     * multiple consecutive slashes. An in-memory directory cache is checked
     * first to avoid redundant database lookups; newly resolved segments are
     * written back to the cache.
     *
     * When parent_only is true, the last path component is not resolved and is
     * returned in the PathResolution name instead.
     *
     * @returns A PathResolution with id = -1 if the path could not be resolved.
     */

    _resolvePath (
        tx          : IDBTransaction,
        path        : string,
        parent_only : boolean
    ) : Promise<PathResolution>
    {
        const result : PathResolution = { id: 0, name: "" };

        let normalized_path: string = "";

        try
        {
            const url : URL = new URL(path, "file:///");
            normalized_path = url.href.slice(7); // For "file://".
        }
        catch
        {
            return Promise.resolve(result);
        }

        if (normalized_path === "/")
        {
            result.id   = 1;
            result.name = "";

            return Promise.resolve(result);
        }

        const parts : string[] = normalized_path.split('/').slice(1);

        let target_parts: string[] = [];

        if (parent_only === true)
            target_parts = parts.slice(0, -1);
        else
            target_parts = parts;

        const last_name = parts[parts.length - 1];

        let current_id   : int     = 1;
        let current_path : string  = "";
        let match_idx    : int     = -1;

        for (let i : uint = target_parts.length - 1; i >= 0; i--)
        {
            const test_path = "/" + target_parts.slice(0, i + 1).join("/");

            if (this.dcache.has(test_path))
            {
                current_id   = this.dcache.get(test_path)!;
                current_path = test_path;
                match_idx    = i;
                break;
            }
        }

        const walker = async () : Promise<PathResolution> =>
        {
            for (let i : int = match_idx + 1; i < target_parts.length; i++)
            {
                const comp  : string       = target_parts[i]!;
                const inode : INode | null = await this._getInode(tx, current_id);

                if (inode === null || (inode.mode & TYPE_MASK) !== TYPE_DIR || !inode.entries)
                {
                    result.id = -1;
                    return result;
                }

                const next_id = inode.entries[comp];
                if (next_id === undefined)
                {
                    result.id = -1;
                    return result;
                }

                current_id = next_id;
                current_path = current_path === "/" ? "/" + comp : current_path + "/" + comp;

                this.dcache.set(current_path, current_id);
            }

            result.id = current_id;

            if (parent_only === true && last_name !== undefined)
                result.name = last_name;

            if (!parent_only && match_idx === target_parts.length - 1 && current_id > 0)
            {
                const verify : INode | null = await this._getInode(tx, current_id);

                if (verify === null)
                {
                    this.dcache.delete(current_path);
                    return this._resolvePath(tx, path, parent_only);
                }
            }

            return result;
        };

        return walker();
    }

    /**
     * Returns metadata for the file or directory at `path`.
     *
     * On success fills `stat_buf` with the inode's size, mode, and link count,
     *
     * @returns 0 on success; -1 if the path does not exist or if an ancestor
     * is not a directory.
     */

    async stat (
        path     : string,
        stat_buf : StatBuf
    ) : Promise<int>
    {
        try
        {
            const tx  : IDBTransaction = this.fs_db!.transaction([STORE_INODES], TX_READ_ONLY);
            const res : PathResolution = await this._resolvePath(tx, path, false);

            if (res.id < 0)
                return -1;

            const inode : INode | null = await this._getInode(tx, res.id);

            if (inode === null)
                return -1;

            stat_buf.size  = inode.size;
            stat_buf.mode  = inode.mode;
            stat_buf.nlink = inode.nlink;

            return 0;
        }
        catch
        {
            return -1;
        }
    }

    /**
     * Creates a hard link `newpath` pointing to the same inode as `oldpath`.
     *
     * The old path must be a regular file. The new path must not already exist.
     *
     * @returns 0 on success, -1 on failure.
     */

    async link (
        oldpath : string,
        newpath : string
    ) : Promise<int>
    {
        try
        {
            const tx      : IDBTransaction = this.fs_db!.transaction([STORE_INODES], TX_READ_WRITE);
            const old_res : PathResolution = await this._resolvePath(tx, oldpath, false);

            if (old_res.id < 0)
                return -1;

            const new_res : PathResolution = await this._resolvePath(tx, newpath, true);

            if (new_res.id < 0 || new_res.name === "")
                return -1;

            const parent_inode : INode | null = await this._getInode(tx, new_res.id);

            if (parent_inode === null || (parent_inode.mode & TYPE_MASK) !== TYPE_DIR || parent_inode.entries === undefined)
                return -1;

            if (parent_inode.entries[new_res.name] !== undefined)
                return -1;

            const old_inode : INode | null = await this._getInode(tx, old_res.id);

            if (old_inode === null || (old_inode.mode & TYPE_MASK) === TYPE_DIR)
                return -1;

            old_inode.nlink++;
            parent_inode.entries[new_res.name] = old_res.id;

            await this._putInode(tx, old_inode);
            await this._putInode(tx, parent_inode);

            this.dcache.clear();
            return 0;
        }
        catch
        {
            return -1;
        }
    }

    /**
     * Removes a name from the filesystem.
     *
     * The path must refer to a regular file. If the link count drops to 0, then
     * the inode and all associated data blocks are deleted.
     *
     * Directories must be removed with rmdir, not unlink.
     *
     * @returns 0 on success, -1 on failure.
     */

    async unlink (
        path : string
    ) : Promise<int>
    {
        try
        {
            const tx  : IDBTransaction = this.fs_db!.transaction([STORE_INODES, STORE_BLOCKS], TX_READ_WRITE);
            const res : PathResolution = await this._resolvePath(tx, path, true);

            if (res.id < 0 || res.name === "")
                return -1;

            const parent_inode : INode | null = await this._getInode(tx, res.id);

            if (parent_inode === null || (parent_inode.mode & TYPE_MASK) !== TYPE_DIR || parent_inode.entries === undefined)
                return -1;

            const child_id : int | undefined = parent_inode.entries[res.name];

            if (child_id === undefined)
                return -1;

            const child_inode : INode | null = await this._getInode(tx, child_id);

            if (child_inode === null || (child_inode.mode & TYPE_MASK) === TYPE_DIR)
                return -1;

            delete parent_inode.entries[res.name];
            child_inode.nlink--;

            await this._putInode(tx, parent_inode);

            if (child_inode.nlink <= 0)
            {
                await this._deleteInode(tx, child_id);
                await this._deleteBlocks(tx, child_id);
            }
            else
            {
                await this._putInode(tx, child_inode);
            }

            this.dcache.clear();
            return 0;
        }
        catch
        {
            return -1;
        }
    }

    /**
     * Removes an empty directory.
     *
     * @returns 0 on success, -1 if the path is not a directory, is not empty,
     * or does not exist.
     */

    async rmdir (
        path : string
    ) : Promise<int>
    {
        try
        {
            const tx  : IDBTransaction = this.fs_db!.transaction([STORE_INODES], TX_READ_WRITE);
            const res : PathResolution = await this._resolvePath(tx, path, true);

            if (res.id < 0 || res.name === "")
                return -1;

            const parent_inode : INode | null = await this._getInode(tx, res.id);

            if (parent_inode === null || (parent_inode.mode & TYPE_MASK) !== TYPE_DIR || parent_inode.entries === undefined)
                return -1;

            const child_id : int | undefined = parent_inode.entries[res.name];

            if (child_id === undefined)
                return -1;

            const child_inode : INode | null = await this._getInode(tx, child_id);

            if (child_inode === null || (child_inode.mode & TYPE_MASK) !== TYPE_DIR || child_inode.entries === undefined)
                return -1;

            if (Object.keys(child_inode.entries).length > 0)
                return -1;

            delete parent_inode.entries[res.name];

            await this._putInode(tx, parent_inode);
            await this._deleteInode(tx, child_id);

            this.dcache.clear();
            return 0;
        }
        catch
        {
            return -1;
        }
    }

    /**
     * Creates a directory at `path`.
     *
     * The parent directory must exist.
     *
     * @returns 0 on success, -1 if the path already exists or the parent
     * cannot be resolved.
     */

    async mkdir (
        path : string
    ) : Promise<int>
    {
        try
        {
            const tx  : IDBTransaction = this.fs_db!.transaction([STORE_INODES], TX_READ_WRITE);
            const res : PathResolution = await this._resolvePath(tx, path, true);

            if (res.id < 0 || res.name === "")
                return -1;

            const parent_inode : INode | null = await this._getInode(tx, res.id);

            if (parent_inode === null || (parent_inode.mode & TYPE_MASK) !== TYPE_DIR || parent_inode.entries === undefined)
                return -1;

            if (parent_inode.entries[res.name] !== undefined)
                return -1;

            const child_inode : INode = await this._createInode(tx, TYPE_DIR | 0o755);

            parent_inode.entries[res.name] = child_inode.id!;

            await this._putInode(tx, parent_inode);

            this.dcache.clear();
            return 0;
        }
        catch
        {
            return -1;
        }
    }

    /**
     * Opens or creates a file and returns a file descriptor.
     *
     * The behaviour depends on `flags`:
     * - CREATE: create the file if it does not exist.
     * - EXCLUSIVE:  fail if CREATE is set and the file exists.
     * - TRUNCATE: truncate the file to length 0 on open.
     * - APPEND: all writes are appended to the end.
     *
     * The access mode (READ, WRITE, READ_WRITE) selects read, write, or both.
     * Directories can only be opened for reading.
     *
     * @returns A non-negative fd on success, or -1 on failure.
     */

    async open (
        path  : string,
        flags : int
    ) : Promise<int>
    {
        try
        {
            const acc       : int            = flags & ACCESS_MODE;
            const read_only : boolean        = acc === READ && !(flags & CREATE) && !(flags & TRUNCATE);
            const stores    : string[]       = (flags & TRUNCATE) ? [STORE_INODES, STORE_BLOCKS] : [STORE_INODES];
            const tx        : IDBTransaction = this.fs_db!.transaction(stores, read_only ? TX_READ_ONLY : TX_READ_WRITE);
            const res       : PathResolution = await this._resolvePath(tx, path, false);

            let target_id : int = res.id;

            if (target_id < 0)
            {
                if (flags & CREATE)
                {
                    const parent_res : PathResolution = await this._resolvePath(tx, path, true);

                    if (parent_res.id < 0 || parent_res.name === "")
                        return -1;

                    const parent_inode : INode | null = await this._getInode(tx, parent_res.id);

                    if (parent_inode === null || (parent_inode.mode & TYPE_MASK) !== TYPE_DIR || parent_inode.entries === undefined)
                        return -1;

                    const new_inode : INode = await this._createInode(tx, TYPE_FILE | 0o644);

                    parent_inode.entries[parent_res.name] = new_inode.id!;

                    await this._putInode(tx, parent_inode);

                    target_id = new_inode.id!;

                    this.dcache.clear();
                }
                else
                {
                    return -1;
                }
            }
            else if ((flags & CREATE) && (flags & EXCLUSIVE))
            {
                return -1;
            }

            const inode : INode | null = await this._getInode(tx, target_id);

            if (inode === null)
                return -1;

            if ((inode.mode & TYPE_MASK) === TYPE_DIR && ((flags & ACCESS_MODE) === WRITE || (flags & ACCESS_MODE) === READ_WRITE))
                return -1;

            if ((flags & TRUNCATE) && ((flags & ACCESS_MODE) === WRITE || (flags & ACCESS_MODE) === READ_WRITE))
            {
                inode.size = 0;

                await this._putInode(tx, inode);
                await this._deleteBlocks(tx, inode.id!);
            }

            for (let i : int = 0; i < this.max_fd; i++)
            {
                if (this.fd_table[i]!.used === false)
                {
                    this.fd_table[i]!.used     = true;
                    this.fd_table[i]!.inode_id = target_id;
                    this.fd_table[i]!.offset   = (flags & APPEND) ? inode.size : 0;
                    this.fd_table[i]!.flags    = flags;

                    return i;
                }
            }

            return -1;
        }
        catch
        {
            return -1;
        }
    }

    /**
     * Closes a file descriptor.
     *
     * @returns 0 on success, -1 if the fd is out of range or not in use.
     */

    close (
        fd : int
    ) : int
    {
        if (fd < 0 || fd >= this.max_fd || this.fd_table[fd]!.used === false)
            return -1;

        this.fd_table[fd]!.used = false;

        return 0;
    }

    /**
     * Reads up to `length` bytes from the open file descriptor `fd` into
     * `buffer`.
     *
     * The read starts at the current file offset, which is advanced by the
     * number of bytes read.
     *
     * @returns The number of bytes read, 0 at EOF, or -1 on error.
     */

    async read (
        fd     : int,
        buffer : Uint8Array,
        length : uint
    ) : Promise<int>
    {
        if (fd < 0 || fd >= this.max_fd || !this.fd_table[fd]!.used)
            return -1;

        const f_obj    : FileDescriptor = this.fd_table[fd]!;
        const flags    : int            = f_obj.flags;
        const inode_id : int            = f_obj.inode_id;

        if ((flags & ACCESS_MODE) === WRITE)
            return -1;

        const release : () => void = await this.lockFd(fd);

        try
        {
            const tx    : IDBTransaction = this.fs_db!.transaction([STORE_INODES, STORE_BLOCKS], TX_READ_ONLY);
            const inode : INode | null   = await this._getInode(tx, inode_id);

            if (inode === null)
                return -1;

            if ((inode.mode & TYPE_MASK) === TYPE_DIR)
                return -1;

            let file_offset : int = f_obj.offset;

            if (file_offset >= inode.size)
                return 0;

            const available  : uint = inode.size - file_offset;
            const to_read    : uint = Math.min(length, available);
            let   bytes_read : uint = 0;

            while (bytes_read < to_read)
            {
                const current_offset : int  = file_offset + bytes_read;
                const block_index    : uint = Math.floor(current_offset / this.block_size);
                const block_offset   : int  = current_offset % this.block_size;
                const chunk_size     : uint = Math.min(this.block_size - block_offset, to_read - bytes_read);

                const block : Uint8Array | null = await this._getBlock(tx, inode.id!, block_index);

                if (block !== null)
                    buffer.set(block.subarray(block_offset, block_offset + chunk_size), bytes_read);
                else
                    buffer.fill(0, bytes_read, bytes_read + chunk_size);

                bytes_read += chunk_size;
            }

            if (f_obj.inode_id === inode_id)
                f_obj.offset = file_offset + bytes_read;

            return bytes_read;
        }
        catch
        {
            return -1;
        }
        finally
        {
            release();
        }
    }

    /**
     * Writes up to `length` bytes from `buffer` to the file descriptor `fd`.
     * The file descriptor must be open.
     *
     * The write starts at the current file offset, which is advanced by the
     * number of bytes written. If APPEND is set on the fd, the offset is first
     * moved to the end of the file.
     *
     * If the write extends past the end of the file, the file size is updated.
     *
     * @returns The number of bytes written, or -1 on error.
     */

    async write (
        fd     : int,
        buffer : Uint8Array,
        length : uint
    ) : Promise<int>
    {
        if (fd < 0 || fd >= this.max_fd || this.fd_table[fd]!.used === false)
            return -1;

        const f_obj    : FileDescriptor = this.fd_table[fd]!;
        const flags    : int            = f_obj.flags;
        const inode_id : int            = f_obj.inode_id;

        if ((flags & ACCESS_MODE) === READ)
            return -1;

        const release : () => void = await this.lockFd(fd);

        try
        {
            const tx    : IDBTransaction = this.fs_db!.transaction([STORE_INODES, STORE_BLOCKS], TX_READ_WRITE);
            const inode : INode | null   = await this._getInode(tx, inode_id);

            if (inode === null)
                return -1;

            let file_offset : int = f_obj.offset;

            if (flags & APPEND)
                file_offset = inode.size;

            let bytes_written : uint = 0;

            while (bytes_written < length)
            {
                const current_offset : int  = file_offset + bytes_written;
                const block_index    : uint = Math.floor(current_offset / this.block_size);
                const block_offset   : int  = current_offset % this.block_size;
                const chunk_size     : uint = Math.min(this.block_size - block_offset, length - bytes_written);

                let block_data : Uint8Array;

                if (chunk_size === this.block_size)
                {
                    block_data = new Uint8Array(this.block_size);
                }
                else
                {
                    const existing_block : Uint8Array | null = await this._getBlock(tx, inode.id!, block_index);

                    if (existing_block !== null)
                        block_data = existing_block;
                    else
                        block_data = new Uint8Array(this.block_size);
                }

                block_data.set(buffer.subarray(bytes_written, bytes_written + chunk_size), block_offset);
                await this._putBlock(tx, inode.id!, block_index, block_data);

                bytes_written += chunk_size;
            }

            const final_offset : int = file_offset + bytes_written;

            if (f_obj.inode_id === inode_id)
                f_obj.offset = final_offset;

            if (final_offset > inode.size)
            {
                inode.size = final_offset;
                await this._putInode(tx, inode);
            }

            return bytes_written;
        }
        catch
        {
            return -1;
        }
        finally
        {
            release();
        }
    }

    /**
     * Repositions the file offset for the open file descriptor `fd`.
     *
     * Whence values:
     *   - SET: offset from the beginning of the file.
     *   - CURRENT: offset relative to the current position.
     *   - END: offset relative to the end of the file (requires a
     *     database read to obtain the file size).
     *
     * @returns The new offset on success, or -1 if the fd is invalid
     *          or whence is unrecognised.
     */

    async lseek (
        fd     : int,
        offset : int,
        whence : int
    ) : Promise<int>
    {
        try
        {
            if (fd < 0 || fd >= this.max_fd || this.fd_table[fd]!.used === false)
                return -1;

            const f_obj    : FileDescriptor = this.fd_table[fd]!;
            const inode_id : int            = f_obj.inode_id;

            let new_offset : int = 0;

            if (whence === SET)
            {
                new_offset = offset;
            }
            else if (whence === CURRENT)
            {
                new_offset = f_obj.offset + offset;
            }
            else if (whence === END)
            {
                const tx    : IDBTransaction = this.fs_db!.transaction([STORE_INODES], TX_READ_ONLY);
                const inode : INode | null   = await this._getInode(tx, inode_id);

                if (inode === null)
                    return -1;

                new_offset = inode.size + offset;
            }
            else
                return -1;

            if (f_obj.inode_id === inode_id)
                f_obj.offset = new_offset;

            return new_offset;
        }
        catch
        {
            return -1;
        }
    }

    /**
     * Lists the entries in a directory.
     *
     * @returns An array of DirEnt on success, or -1 if the path does
     *          not exist or is not a directory.
     */

    async readdir (
        path : string
    ) : Promise<DirEnt[] | int>
    {
        try
        {
            const tx  : IDBTransaction = this.fs_db!.transaction([STORE_INODES], TX_READ_ONLY);
            const res : PathResolution = await this._resolvePath(tx, path, false);

            if (res.id < 0)
                return -1;

            const inode : INode | null = await this._getInode(tx, res.id);

            if (inode === null || (inode.mode & TYPE_MASK) !== TYPE_DIR || inode.entries === undefined)
                return -1;

            const names : string[] = Object.keys(inode.entries);
            const out   : DirEnt[] = [];

            for (const name of names)
            {
                const child_id : int = inode.entries[name]!;

                out.push({ id: child_id, name: name });
            }

            return out;
        }
        catch
        {
            return -1;
        }
    }

    /**
     * Renames a file from oldpath to newpath.
     *
     * If newpath already exists it is removed first. Directories cannot be
     * renamed.
     *
     * @returns 0 on success, or -1 on error.
     */

    async rename (
        oldpath : string,
        newpath : string
    ) : Promise<int>
    {
        try
        {
            const tx      : IDBTransaction = this.fs_db!.transaction([STORE_INODES, STORE_BLOCKS], TX_READ_WRITE);
            const old_res : PathResolution = await this._resolvePath(tx, oldpath, false);

            if (old_res.id < 0)
                return -1;

            const old_inode : INode | null = await this._getInode(tx, old_res.id);

            if (old_inode === null || (old_inode.mode & TYPE_MASK) === TYPE_DIR)
                return -1;

            const new_res : PathResolution = await this._resolvePath(tx, newpath, true);

            if (new_res.id < 0 || new_res.name === "")
                return -1;

            const new_parent : INode | null = await this._getInode(tx, new_res.id);

            if (new_parent === null || (new_parent.mode & TYPE_MASK) !== TYPE_DIR || new_parent.entries === undefined)
                return -1;

            const existing_id : int | undefined = new_parent.entries[new_res.name];

            if (existing_id !== undefined)
            {
                const existing_inode : INode | null = await this._getInode(tx, existing_id);

                if (existing_inode === null || (existing_inode.mode & TYPE_MASK) === TYPE_DIR)
                    return -1;

                delete new_parent.entries[new_res.name];
                existing_inode.nlink--;

                if (existing_inode.nlink <= 0)
                {
                    await this._deleteInode(tx, existing_id);
                    await this._deleteBlocks(tx, existing_id);
                }
                else
                {
                    await this._putInode(tx, existing_inode);
                }
            }

            const old_parent_res : PathResolution = await this._resolvePath(tx, oldpath, true);

            if (old_parent_res.id < 0 || old_parent_res.name === "")
                return -1;

            let old_parent: INode = await this._getInode(tx, old_parent_res.id) as INode;

            if (old_parent_res.id === new_res.id)
                old_parent = new_parent;

            if ((old_parent.mode & TYPE_MASK) !== TYPE_DIR || old_parent.entries === undefined)
                return -1;

            old_inode.nlink++;
            new_parent.entries[new_res.name] = old_res.id;
            delete old_parent.entries[old_parent_res.name];
            old_inode.nlink--;

            await this._putInode(tx, old_inode);

            if (old_parent_res.id !== new_res.id)
                await this._putInode(tx, new_parent);

            await this._putInode(tx, old_parent);

            this.dcache.clear();

            return 0;
        }
        catch
        {
            return -1;
        }
    }

    /**
     * Closes the IndexedDB connection and releases resources.
     *
     * Call this before deleting the database or when the filesystem is no longer
     * needed. After shutdown() the filesystem must be re-initialized with init()
     * before further operations.
     */

    shutdown () : void
    {
        if (this.fs_db !== null)
        {
            this.fs_db.close();
            this.fs_db = null;
        }
    }

    /**
     * Serializes the entire filesystem into an ArrayBuffer for backup or
     * transfer. The filesystem remains usable during export.
     *
     * @returns An ArrayBuffer containing the serialized filesystem.
     */

    async export () : Promise<ArrayBuffer>
    {
        const tx     : IDBTransaction = this.fs_db!.transaction([STORE_INODES, STORE_BLOCKS], TX_READ_ONLY);
        const is     : IDBObjectStore = tx.objectStore(STORE_INODES);
        const bs     : IDBObjectStore = tx.objectStore(STORE_BLOCKS);
        const inodes : INode[]        = await _idbRequest<INode[]>(is.getAll());
        const blocks : FileBlock[]    = await _idbRequest<FileBlock[]>(bs.getAll());

        let size : uint = TinyFS.HEADER_SIZE;

        for (const inode of inodes)
        {
            size += 18;

            if (inode.entries !== undefined)
            {
                for (const name of Object.keys(inode.entries))
                    size += 2 + this.encoder.encode(name).length + 4;
            }
        }

        for (const block of blocks)
            size += 12 + block.data.length;

        const buf    : ArrayBuffer = new ArrayBuffer(size);
        const view   : DataView    = new DataView(buf);
        let   offset : uint        = 0;

        for (let i = 0; i < 8; i++)
            view.setUint8(offset++, TinyFS.MAGIC[i]!);

        view.setUint32(offset, DB_VERSION, true);
        offset += 4;

        view.setUint32(offset, inodes.length, true);
        offset += 4;

        view.setUint32(offset, blocks.length, true);
        offset += 4;

        for (const inode of inodes)
        {
            view.setInt32(offset, inode.id!, true);
            offset += 4;

            view.setInt32(offset, inode.mode, true);
            offset += 4;

            view.setUint32(offset, inode.nlink, true);
            offset += 4;

            view.setUint32(offset, inode.size, true);
            offset += 4;

            const names = inode.entries !== undefined ? Object.keys(inode.entries) : [];
            view.setUint16(offset, names.length, true);
            offset += 2;

            for (const name of names)
            {
                const bytes : Uint8Array = this.encoder.encode(name);

                view.setUint16(offset, bytes.length, true);
                offset += 2;

                for (let i = 0; i < bytes.length; i++)
                    view.setUint8(offset++, bytes[i]!);

                view.setInt32(offset, inode.entries![name]!, true);
                offset += 4;
            }
        }

        for (const block of blocks)
        {
            view.setInt32(offset, block.inode_id, true);
            offset += 4;

            view.setUint32(offset, block.block_index, true);
            offset += 4;

            view.setUint32(offset, block.data.length, true);
            offset += 4;

            for (let i = 0; i < block.data.length; i++)
                view.setUint8(offset++, block.data[i]!);
        }

        return buf;
    }

    private static migrate (
        data    : { inodes : INode[]; blocks : FileBlock[] },
        fromVer : uint,
        toVer   : uint
    ) : void
    {
        // Stub: v1 is the initial version, no migration needed.
    }

    /**
     * Creates a TinyFS filesystem from a previously exported ArrayBuffer.
     * Any existing data in the database is replaced.
     *
     * @returns A new TinyFS instance populated from the serialized data.
     */

    static async import (
        db_name : string,
        data    : ArrayBuffer,
        opts?   : TinyFSOptions
    ) : Promise<TinyFS>
    {
        const view   : DataView = new DataView(data);
        let   offset : uint     = 0;

        for (let i = 0; i < 8; i++)
        {
            if (new Uint8Array(data, i, 1)[0] !== TinyFS.MAGIC[i])
                throw new Error("Not a TinyFS blob");
        }

        offset += 8;

        const version : uint = view.getUint32(offset, true);
        offset += 4;

        const inode_count : uint = view.getUint32(offset, true);
        offset += 4;

        const block_count : uint = view.getUint32(offset, true);
        offset += 4;

        const inodes : INode[] = [];

        for (let i = 0; i < inode_count; i++)
        {
            const id : int = view.getInt32(offset, true);
            offset += 4;

            const mode : int = view.getInt32(offset, true);
            offset += 4;

            const nlink : uint = view.getUint32(offset, true);
            offset += 4;

            const size : uint = view.getUint32(offset, true);
            offset += 4;

            const ecount : uint = view.getUint16(offset, true);
            offset += 2;

            let entries : Record<string, int> | undefined;

            if (ecount > 0)
            {
                entries = {};

                for (let j = 0; j < ecount; j++)
                {
                    const nlen : uint = view.getUint16(offset, true);
                    offset += 2;

                    const nbytes : Uint8Array = new Uint8Array(data, offset, nlen);
                    offset += nlen;

                    const name    : string = new TextDecoder().decode(nbytes);
                    const childId : int    = view.getInt32(offset, true);
                    offset += 4;

                    entries[name] = childId;
                }
            }

            inodes.push({ id, mode, nlink, size, entries });
        }

        const blocks : FileBlock[] = [];

        for (let i = 0; i < block_count; i++)
        {
            const inode_id : int  = view.getInt32(offset, true);
            offset += 4;

            const block_index : uint = view.getUint32(offset, true);
            offset += 4;

            const dlen : uint = view.getUint32(offset, true);
            offset += 4;

            const data_arr : Uint8Array = new Uint8Array(data, offset, dlen);
            offset += dlen;

            blocks.push({ inode_id, block_index, data: data_arr });
        }

        if (version < DB_VERSION)
            TinyFS.migrate({ inodes, blocks }, version, DB_VERSION);

        const fs = new TinyFS(opts);

        await new Promise<void>((resolve, reject) => {
            const req : IDBOpenDBRequest = indexedDB.open(db_name, DB_VERSION);

            req.onupgradeneeded = (e : IDBVersionChangeEvent) : void => {
                const db : IDBDatabase = (e.target as IDBOpenDBRequest).result;

                if (e.oldVersion < 1)
                {
                    db.createObjectStore(STORE_INODES, { keyPath: "id", autoIncrement: true });
                    db.createObjectStore(STORE_BLOCKS, { keyPath: [ "inode_id", "block_index" ] });
                }
            }

            req.onsuccess = (e : Event) : void => {
                fs.fs_db = (e.target as IDBOpenDBRequest).result;

                const tx : IDBTransaction = fs.fs_db.transaction([STORE_INODES, STORE_BLOCKS], TX_READ_WRITE);

                tx.objectStore(STORE_INODES).clear();
                tx.objectStore(STORE_BLOCKS).clear();

                const is : IDBObjectStore = tx.objectStore(STORE_INODES);
                for (const inode of inodes)
                    is.add(inode);

                const bs : IDBObjectStore = tx.objectStore(STORE_BLOCKS);
                for (const block of blocks)
                    bs.add(block);

                tx.oncomplete = () : void => resolve();
                tx.onerror    = () : void => reject(-1);
            }

            req.onerror   = () : void => reject(-1);
            req.onblocked = () : void => reject(-1);
        });

        return fs;
    }
}
