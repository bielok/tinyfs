/**
 * Options for configuring the fuzzer run.
 */
export
interface FuzzerOptions
{
    /**
     * The maximum length of the Uint8Array to generate.
     * @defaultValue 256
     */
    max_len? : number;

    /**
     * The maximum number of test cases to run.
     * @defaultValue 10000
     */
    num_tests? : number;

    /**
     * The maximum time in milliseconds the fuzzer is allowed to run.
     * @defaultValue 5000
     */
    time_ms? : number;

    /**
     * Seed for the pseudo-random number generator.
     * Can be a number or a string (which will be hashed).
     */
    seed? : number | string;
}

/**
 * The result of a fuzzing execution.
 */

export
interface FuzzResult
{
    /**
     * True if all tests passed, false if a counterexample was found.
     */
    ok : boolean;

    /**
     * The total number of tests run.
     */
    num_tests_run : number;

    /**
     * The execution duration in milliseconds.
     */
    duration_ms : number;

    /**
     * The resolved seed used for the pseudo-random number generator.
     */
    seed : number;

    /**
     * The original, unshrunk counterexample that triggered the failure, if found.
     */
    counterex? : Uint8Array;

    /**
     * The minimized/shrunk counterexample, if a failure was found.
     */
    shrunk_counterex? : Uint8Array;

    /**
     * The error message or string representation of the thrown value that triggered the failure.
     */
    error? : string;
}

/**
 * Internal structure to capture property check outcomes without allocations.
 */
interface CheckResult
{
    ok     : boolean;
    error? : string;
}

/**
 * Fallback static options object to avoid object literals on the hot path.
 */
const DEFAULT_OPTIONS: FuzzerOptions = {};

/**
 * A stateful pseudo-random number generator using the Mulberry32 algorithm.
 */

export
class Mulberry32
{
    state : number;

    /**
     * Initializes the generator with a 32-bit unsigned seed.
     * @param seed - The seed value.
     */

    constructor (
        seed : number
    ) {
        this.state = seed >>> 0;
    }

    /**
     * Generates a pseudo-random floating-point number in the range [0, 1).
     * @returns A random number between 0 (inclusive) and 1 (exclusive).
     */

    next() : number
    {
        this.state |= 0;
        this.state = (this.state + 0x6D2B79F5) | 0;
        let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}

/**
 * The hashString32 function hashes a string into a 32-bit unsigned integer
 * using an FNV-1a-like hash function.
 *
 * @param s - The input string to hash.
 *
 * @returns A 32-bit unsigned integer.
 */

export
function hashString32 (
    s : string
) : number
{
    let h : number = 2166136261 >>> 0;

    for (let i = 0; i < s.length; i++)
    {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }

    return h >>> 0;
}

/**
 * A pool of pre-allocated Uint8Array buffers to avoid allocation overhead during hot loops.
 */

export
class BufferPool
{
    cache: Map<number, Uint8Array> = new Map();

    /**
     * Warms up the pool by pre-allocating buffers of sizes up to the specified limit.
     *
     * @param max_len - The maximum buffer size to allocate.
     */

    warmup (
        max_len : number
    ) : void
    {
        const safeLimit : number = Math.min(max_len, 1024);

        for (let i = 0; i <= safeLimit; i++)
            this.cache.set(i, new Uint8Array(i));
    }

    /**
     * Retrieves a pre-allocated Uint8Array of the requested size.
     *
     * @param size - The desired buffer size.
     *
     * @returns A cached Uint8Array instance of the given size.
     */

    get (
        size: number
    ) : Uint8Array
    {
        let buf : Uint8Array<ArrayBufferLike> | undefined = this.cache.get(size);

        if (buf === undefined)
        {
            buf = new Uint8Array(size);
            this.cache.set(size, buf);
        }

        return buf;
    }
}

/**
 * runCheckInPlace runs the check function, updating a reused result object to
 * avoid allocations.
 *
 * @param check_fn  - The user-provided check.
 * @param input     - The byte array to validate.
 * @param outResult - The mutable result object to update.
 */

async function runCheckInPlace (
    check_fn  : (input: Uint8Array) => boolean | Promise<boolean>,
    input     : Uint8Array,
    outResult : CheckResult
) : Promise<void>
{
    try
    {
        const res : boolean = await check_fn(input);

        if (res === false)
        {
            outResult.ok = false;
            outResult.error = "Returned false";
        }
        else
        {
            outResult.ok = true;
            outResult.error = undefined;
        }
    }
    catch (e : unknown)
    {
        outResult.ok    = false;
        outResult.error = e instanceof Error ? e.message : String(e);
    }
}

/**
 * The runCheck function executes the provided check function with standard
 * object returns (used on cold paths like shrinking).
 *
 * @param check_fn - The user-provided check.
 * @param input    - The byte array to validate.
 *
 * @returns A fresh CheckResult object.
 */

async function runCheck (
    check_fn : (input: Uint8Array) => boolean | Promise<boolean>,
    input    : Uint8Array
) : Promise<CheckResult>
{
    try
    {
        const res : boolean = await check_fn(input);

        if (res === false)
            return { ok: false, error: "Returned false" };

        return { ok: true };
    }
    catch (e : unknown)
    {
        return {
            ok: false,
            error: e instanceof Error ? e.message : String(e)
        };
    }
}

/**
 * Compares two Uint8Arrays for equality.
 * @param a - First array.
 * @param b - Second array.
 * @returns True if arrays have identical length and elements.
 */
function arraysEqual (
    a : Uint8Array,
    b : Uint8Array
) : boolean
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

/**
 * Attempts to minimize a failing byte array by removing contiguous chunks.
 * @param bytes - The original failing bytes.
 * @param testFail - Function returning true if a candidate fails.
 * @returns A potentially smaller failing byte array.
 */
async function shrinkRemoveChunks (
    bytes    : Uint8Array,
    testFail : (candidate: Uint8Array) => Promise<boolean>
) : Promise<Uint8Array<ArrayBuffer>>
{
    let arr : Array<number> = Array.from(bytes);
    let n   : number        = arr.length;
    let k   : number        = 2;

    while (n >= 1)
    {
        const chunk_size : number  = Math.ceil(n / k);
        let   removed    : boolean = false;

        for (let i = 0; i < n; i += chunk_size)
        {
            const candidate = arr.slice(0, i).concat(arr.slice(Math.min(n, i + chunk_size)));

            if (candidate.length === arr.length)
                continue;

            const candidateU8 = new Uint8Array(candidate);
            if (await testFail(candidateU8))
            {
                arr     = candidate;
                n       = arr.length;
                k       = 2;
                removed = true;

                break;
            }
        }

        if (removed === false)
        {
            if (chunk_size === 1)
                break;

            k = Math.min(n || 1, k * 2);
        }
    }

    return new Uint8Array(arr);
}

/**
 * Attempts to minimize individual byte values of a failing array.
 * @param bytes - The original failing bytes.
 * @param testFail - Function returning true if a candidate fails.
 * @returns A potentially simplified byte array.
 */
async function shrinkByteValues (
    bytes    : Uint8Array,
    testFail : (candidate: Uint8Array) => Promise<boolean>
) : Promise<Uint8Array<ArrayBuffer>>
{
    const data : Uint8Array<ArrayBuffer> = new Uint8Array(bytes);

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
            const mid = (low + high) >>> 1;

            data[i] = mid;

            if (await testFail(data))
                high = mid;
            else
                low = mid;
        }

        data[i] = high;
    }

    return data;
}

/**
 * Entry point to shrink a counterexample using a combination of chunk removal and byte minimization.
 * @param initial_bytes - The original failing byte array.
 * @param check_fn - The user-provided property check.
 * @returns The minimized counterexample.
 */
async function shrinkCounterexample(
    initial_bytes : Uint8Array,
    check_fn      : (input: Uint8Array) => boolean | Promise<boolean>
) : Promise<Uint8Array>
{
    const testFail = async (candidate: Uint8Array) : Promise<boolean> => {
        return !(await runCheck(check_fn, candidate)).ok;
    };

    if (!(await testFail(initial_bytes)))
        return initial_bytes;

    let current : Uint8Array = new Uint8Array(initial_bytes);
    let changed : boolean    = true;
    let rounds  : number     = 0;

    while (changed && rounds < 8)
    {
        changed = false;
        rounds++;

        const afterChunks = await shrinkRemoveChunks(current, testFail);
        if (afterChunks.length < current.length)
        {
            current = afterChunks;
            changed = true;
        }

        const afterValues = await shrinkByteValues(current, testFail);
        if (!arraysEqual(afterValues, current))
        {
            current = afterValues;
            changed = true;
        }
    }

    return current;
}

/**
 * Platform-agnostic high-resolution timestamp fallback.
 *
 * @returns The current time in milliseconds.
 */

function now () : number
{
    if (typeof globalThis !== "undefined" && globalThis.performance && typeof globalThis.performance.now === "function")
        return globalThis.performance.now();

    return Date.now();
}

/**
 * Executes property-based fuzzing on a user-defined check function.
 * Generates pseudorandom Uint8Array inputs, checks the property, and
 * shrinks any failing inputs to find a minimal counterexample.
 *
 * Note: To achieve allocation-free hot paths, the check function receives
 * a pre-allocated internal buffer. The check function should not mutate the
 * input array or retain a reference to it beyond the function execution.
 *
 * @param check_fn - The property validation function. Should throw an error or return false on failure.
 * @param options  - Configuration options for the fuzzer.
 *
 * @returns A FuzzResult detailing the run status, total tests, and counterexamples.
 */

export async function fuzz (
    check_fn : (input: Uint8Array) => boolean | Promise<boolean>,
    options  : FuzzerOptions = DEFAULT_OPTIONS
) : Promise<FuzzResult>
{
    const max_len   = options.max_len !== undefined ? options.max_len : 256;
    const max_tests = options.num_tests !== undefined ? options.num_tests : Infinity;
    const time_ms   = options.time_ms !== undefined ? options.time_ms : 5000;

    let resolvedSeed = 0;
    if (options.seed !== undefined)
    {
        if (typeof options.seed === "string")
            resolvedSeed = hashString32(options.seed);
        else
            resolvedSeed = options.seed >>> 0;
    }
    else
    {
        resolvedSeed = (Math.random() * 0xFFFFFFFF) >>> 0;
    }

    const rng  : Mulberry32 = new Mulberry32(resolvedSeed);
    const pool : BufferPool = new BufferPool();

    pool.warmup(max_len);

    const result_holder : CheckResult = { ok: true, error: undefined };
    const start_time    : number      = now();

    let test_run  : number                 = 0;
    let counterex : Uint8Array | undefined = undefined;
    let errmsg    : string     | undefined = undefined;

    for (let i = 0; i < max_tests; i++)
    {
        if (time_ms > 0 && (now() - start_time) > time_ms)
            break;

        const r = rng.next();

        let len : number = 0;
        if (max_len <= 0)
            len = 0;
        else if (r < 0.8)
            len = Math.min(max_len, Math.floor(rng.next() * Math.min(max_len + 1, 32)));
        else
            len = Math.floor(rng.next() * (max_len + 1));

        const buf = pool.get(len);

        if (len >= 3 && rng.next() < 0.10)
        {
            const base : number = Math.floor(rng.next() * 253);
            const pos  : number = Math.floor(rng.next() * (len - 2));

            for (let j = 0; j < len; j++)
                buf[j] = (rng.next() * 256) | 0;

            buf[pos + 0] = base + 0;
            buf[pos + 1] = base + 1;
            buf[pos + 2] = base + 2;
        }
        else
        {
            for (let j = 0; j < len; j++)
                buf[j] = (rng.next() * 256) | 0;
        }

        test_run++;
        await runCheckInPlace(check_fn, buf, result_holder);

        if (result_holder.ok === false)
        {
            counterex = new Uint8Array(buf);
            errmsg    = result_holder.error;

            break;
        }
    }

    const end_time    : number = now();
    const duration_ms : number = end_time - start_time;

    if (counterex !== undefined)
    {
        const shrunk = await shrinkCounterexample(counterex, check_fn);
        return {
            ok: false,
            num_tests_run: test_run,
            duration_ms: duration_ms,
            seed: resolvedSeed,
            counterex: counterex,
            shrunk_counterex: shrunk,
            error: errmsg
        };
    }

    return {
        ok: true,
        num_tests_run: test_run,
        duration_ms: duration_ms,
        seed: resolvedSeed
    };
}