import type { TinyFS, StatBuf, DirEnt } from "../src/tinyfs.ts";

export type { TinyFS, StatBuf, DirEnt };

export
type Stats = {
    mean : number;
    min  : number;
    p50  : number;
    p95  : number;
    p99  : number;
    max  : number;
};

export
type BenchResult = {
    name         : string;
    warmup       : number;
    iterations   : number;
    latencies_us : number[];
};

export
type ThroughputResult = {
    size_bytes   : number;
    op           : string;
    iterations   : number;
    warmup       : number;
    latencies_us : number[];
};

export
type SizeConfig = { size : number; warmup : number; iter : number };

export
interface CleanupHooks
{
    deleteDatabase (name : string) : Promise<void>;
}
