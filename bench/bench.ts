// tinyfs browser bench benchmark shared implementation.
//
// Pure TS, no DOM, no Node built-ins: runnable in the browser (via the
// bench.umd.js bundle) or orchestrated headless from scripts/bench.ts.

import {
    CREATE,
    READ,
    READ_WRITE,
    SET,
    CURRENT,
    END,
} from "../src/tinyfs.ts";

import type {
    BenchResult,
    CleanupHooks,
    SizeConfig,
    Stats,
    ThroughputResult,
    TinyFS,
} from "./types.ts";

// stats

export
function computeStats (
    values : number[]
) : Stats
{
    const sorted : number[] = [...values].sort((a, b) => a - b);
    const n      : number   = sorted.length;
    const sum    : number   = values.reduce((a, b) => a + b, 0);

    const idx = (pct : number) : number => Math.min(Math.floor(n * pct), n - 1);

    return {
        mean: sum / n,
        min:  sorted[0]!,
        p50:  sorted[idx(0.50)]!,
        p95:  sorted[idx(0.95)]!,
        p99:  sorted[idx(0.99)]!,
        max:  sorted[n - 1]!,
    };
}

// formatters

// Build a table row from pre-formatted column strings, joining with a single
// space. The divider always matches the header width.

export
function joinRow (
    ...cols : string[]
) : string
{
    return cols.join(" ");
}

export
function pad (
    s : string,
    w : number
) : string
{
    return s.length >= w ? s : s + " ".repeat(w - s.length);
}

export
function lpad (
    v : number,
    w : number
) : string
{
    return v.toFixed(1).padStart(w);
}

export
function fmtOps (
    v : number
) : string
{
    return Math.round(v).toString().padStart(10);
}

export
function fmtMBs (
    bytes   : number,
    mean_us : number
) : string
{
    const mbs : number = bytes / mean_us;
    return mbs.toFixed(2).padStart(8);
}

export
function fmtSize (bytes : number) : string
{
    if (bytes < 1000)
        return bytes + "B";

    if (bytes < 1000_000)
        return (bytes / 1000).toFixed(0) + "KB";

    return (bytes / 1000_000).toFixed(2) + "MB";
}

// latency benchmarks

export
async function runLatencyBenchmarks (
    fs : TinyFS
) : Promise<BenchResult[]>
{
    const sb : { size : number; mode : number; nlink : number } = {
        size: 0, mode: 0, nlink: 0,
    };

    // Setup: create persistent file used by stat/read test files.

    const fd_setup  : number     = await fs.open("/__bench_file", CREATE | READ_WRITE);
    const file_data : Uint8Array = new Uint8Array(1000).fill(0x41);

    await fs.write(fd_setup, file_data, 1000);

    fs.close(fd_setup);

    const ITERATIONS : number = 500;
    const WARMUP     : number = 100;
    const results    : BenchResult[] = [];

    async function run (
        name : string,
        fn   : () => Promise<void>
    ) : Promise<void>
    {
        for (let i = 0; i < WARMUP; i++)
            await fn();

        const lats : number[] = [];

        for (let i = 0; i < ITERATIONS; i++)
        {
            const t0 : number = performance.now();
            await fn();
            lats.push((performance.now() - t0) * 1000); // ms -> us
        }

        results.push({
            name:         name,
            warmup:       WARMUP,
            iterations:   ITERATIONS,
            latencies_us: lats,
        });
    }

    // Benchmark stat.

    await run('stat("/")', async () => { await fs.stat("/", sb); });

    await run("stat(file)", async () => {
        await fs.stat("/__bench_file", sb);
    });

    // Benchmark open + close existing file (READ).

    await run("open+close", async () => {
        const f : number = await fs.open("/__bench_file", READ);

        fs.close(f);
    });

    // Benchmark open + write 100 bytes + close.

    await run("write 100B", async () => {
        const f   : number     = await fs.open("/__bench_file", READ_WRITE);
        const buf : Uint8Array = new Uint8Array(100).fill(0x42);

        await fs.write(f, buf, 100);

        fs.close(f);
    });

    // Benchmark open + read 100 bytes + close.

    await run("read 100B", async () => {
        const f   : number     = await fs.open("/__bench_file", READ);
        const buf : Uint8Array = new Uint8Array(100);

        await fs.lseek(f, 0, SET);
        await fs.read(f, buf, 100);

        fs.close(f);
    });

    // Benchmark mkdir + stat + rmdir.

    await run("mkdir+rmdir", async () => {
        await fs.mkdir("/__bench_mkdir");
        await fs.stat("/__bench_mkdir", sb);
        await fs.rmdir("/__bench_mkdir");
    });

    // Benchmark create + write + close + unlink.

    await run("create+unlink", async () =>
    {
        const f : number = await fs.open("/__bench_create", CREATE | READ_WRITE);

        await fs.write(f, new Uint8Array(10).fill(0x43), 10);

        fs.close(f);

        await fs.unlink("/__bench_create");
    });

    // Benchmark readdir("/").

    await run('readdir("/")', async () => {
        await fs.readdir("/");
    });

    // Benchmark link + unlink.

    await run("link+unlink", async () => {
        await fs.link("/__bench_file", "/__bench_link");

        const sb_link : { size : number; mode : number; nlink : number } =
            { size: 0, mode: 0, nlink: 0 };

        await fs.stat("/__bench_link", sb_link);
        await fs.unlink("/__bench_link");
    });

    // Benchmark seek: three lseek calls per iteration.

    await run("seek", async () => {
        const f : number = await fs.open("/__bench_file", READ);

        await fs.lseek(f, 0,  SET);
        await fs.lseek(f, 10, CURRENT);
        await fs.lseek(f, 0,  END);
        fs.close(f);
    });

    // Benchmark rename.

    await run("rename", async () => {
        const f : number = await fs.open("/__bench_rename_a", CREATE | READ_WRITE);

        fs.close(f);

        await fs.rename("/__bench_rename_a", "/__bench_rename_b");
        await fs.stat("/__bench_rename_b", sb);
        await fs.unlink("/__bench_rename_b");
    });

    return results;
}

// throughput benchmarks

const DEFAULT_SIZE_CONFIGS : SizeConfig[] = [
    { size: 100,         warmup: 100, iter: 1000 },
    { size: 1000,        warmup: 100, iter: 1000 },
    { size: 10000,       warmup: 50,  iter: 500  },
    { size: 100000,      warmup: 25,  iter: 200  },
    { size: 1000_000,    warmup: 10,  iter: 50   },
    { size: 10_000_000,  warmup: 5,   iter: 10   },
];

export
async function runThroughputBenchmarks (
    fs     : TinyFS,
    configs : SizeConfig[] = DEFAULT_SIZE_CONFIGS
) : Promise<ThroughputResult[]>
{
    const results : ThroughputResult[] = [];

    for (const cfg of configs)
    {
        const size   : number = cfg.size;
        const WARMUP : number = cfg.warmup;
        const ITER   : number = cfg.iter;

        for (let i = 0; i < WARMUP; i++)
        {
            const fd : number = await fs.open("/__bench_tp", CREATE | READ_WRITE);

            await fs.write(fd, new Uint8Array(size).fill(0x41), size);

            fs.close(fd);
            await fs.unlink("/__bench_tp");
        }

        const write_latencies : number[] = [];

        for (let i = 0; i < ITER; i++)
        {
            const t0 : number = performance.now();
            const fd : number = await fs.open("/__bench_tp", CREATE | READ_WRITE);

            await fs.write(fd, new Uint8Array(size).fill(0x41), size);

            fs.close(fd);

            await fs.unlink("/__bench_tp");

            write_latencies.push((performance.now() - t0) * 1000);
        }

        results.push({
            size_bytes:   size,
            op:           "write",
            iterations:   ITER,
            warmup:       WARMUP,
            latencies_us: write_latencies,
        });

        // Read throughput.
        // Create a persistent file of this size for reads.

        const fd_create : number = await fs.open("/__bench_tp_read", CREATE | READ_WRITE);

        await fs.write(fd_create, new Uint8Array(size).fill(0x42), size);

        fs.close(fd_create);

        for (let i = 0; i < WARMUP; i++)
        {
            const fdr : number = await fs.open("/__bench_tp_read", READ);

            await fs.read(fdr, new Uint8Array(size), size);

            fs.close(fdr);
        }

        const read_latencies : number[] = [];

        for (let i = 0; i < ITER; i++)
        {
            const t0  : number = performance.now();
            const fdr : number = await fs.open("/__bench_tp_read", READ);

            await fs.read(fdr, new Uint8Array(size), size);

            fs.close(fdr);

            read_latencies.push((performance.now() - t0) * 1000);
        }

        results.push({
            size_bytes:   size,
            op:           "read",
            iterations:   ITER,
            warmup:       WARMUP,
            latencies_us: read_latencies,
        });

        // Cleanup read file.

        await fs.unlink("/__bench_tp_read");
    }

    return results;
}

// printing (returns newline-joined lines; callers route to stdout / DOM)

export
function printLatencyTable (
    results : BenchResult[]
) : string
{
    const lines : string[] = [ "", "Single-operation latency:" ];

    const hdr : string = joinRow(
        pad("op", 18),
        "mean/us".padStart(9),
        "min/us".padStart(9),
        "p50/us".padStart(9),
        "p95/us".padStart(9),
        "p99/us".padStart(9),
        "max/us".padStart(9),
        "ops/sec".padStart(10),
    );

    lines.push(hdr);
    lines.push("-".repeat(hdr.length));

    for (const r of results)
    {
        const s : Stats = computeStats(r.latencies_us);

        lines.push(joinRow(
            pad(r.name.slice(0, 17), 18),
            lpad(s.mean, 9),
            lpad(s.min, 9),
            lpad(s.p50, 9),
            lpad(s.p95, 9),
            lpad(s.p99, 9),
            lpad(s.max, 9),
            fmtOps(1_000_000 / s.mean),
        ));
    }

    return lines.join("\n");
}

export
function printThroughputTable (
    results : ThroughputResult[]
) : string
{
    const lines : string[] = [ "", "Throughput by file size:" ];

    const hdr : string = joinRow(
        pad("size", 8),
        pad("op", 7),
        "n".padStart(6),
        "mean/us".padStart(9),
        "p95/us".padStart(9),
        "MB/s".padStart(8),
        "ops/sec".padStart(10),
    );

    lines.push(hdr);
    lines.push("-".repeat(hdr.length));

    for (const r of results)
    {
        const s : Stats = computeStats(r.latencies_us);

        lines.push(joinRow(
            pad(fmtSize(r.size_bytes), 8),
            pad(r.op, 7),
            String(r.iterations).padStart(6),
            lpad(s.mean, 9),
            lpad(s.p95, 9),
            fmtMBs(r.size_bytes, s.mean),
            fmtOps(1_000_000 / s.mean),
        ));
    }

    return lines.join("\n");
}

export
function printSummary (
    latency    : BenchResult[],
    throughput : ThroughputResult[]
) : string
{
    const total_ops    : number = latency.reduce((s, r) => s + r.iterations, 0);
    const min_mean     : number = Math.min(...latency.map(r => computeStats(r.latencies_us).mean));
    const total_tp_ops : number = throughput.reduce((s, r) => s + r.iterations, 0);
    const total_bytes  : number = throughput.reduce((s, r) => s + r.size_bytes * r.iterations, 0);

    const fastest : BenchResult | undefined = latency.find(
        r => computeStats(r.latencies_us).mean === min_mean,
    );

    const lines : string[] = [
        "",
        "Summary:",
        `latency benchmarks:  ${total_ops} operations across ${latency.length} benchmarks`,
        `throughput benches:  ${total_tp_ops} operations, ${fmtSize(total_bytes)} total`,
        `fastest operation:   ${min_mean} us mean  (${fastest?.name})`,
        "",
    ];

    return lines.join("\n");
}

// cleanup

export
async function cleanup (
    fs      : TinyFS,
    hooks   : CleanupHooks,
    db_name : string
) : Promise<void>
{
    const sb : { size : number; mode : number; nlink : number } = {
        size: 0, mode: 0, nlink: 0,
    };

    // Remove the persistent bench file if it still exists.

    const ret : number = await fs.stat("/__bench_file", sb);

    if (ret === 0)
        await fs.unlink("/__bench_file");

    // Wipe the IndexedDB database so no state leaks across runs.

    await hooks.deleteDatabase(db_name);
}
