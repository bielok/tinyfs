import { existsSync } from "node:fs";
import { basename }  from "node:path";

interface Variant
{
    format      : "esm" | "cjs" | "iife";
    minify      : boolean;
    isUMD       : boolean;
    outfile     : string;
    entrypoint  : string;
    globalName  : string;
}

const VARIANTS : Variant[] = [
    { format: "esm",  minify: false, isUMD: false, outfile: "dist/tinyfs.esm.js",      entrypoint: "src/tinyfs.ts",     globalName: "tinyfs" },
    { format: "esm",  minify: true,  isUMD: false, outfile: "dist/tinyfs.esm.min.js",  entrypoint: "src/tinyfs.ts",     globalName: "tinyfs" },
    { format: "cjs",  minify: false, isUMD: false, outfile: "dist/tinyfs.cjs",          entrypoint: "src/tinyfs.ts",     globalName: "tinyfs" },
    { format: "cjs",  minify: true,  isUMD: false, outfile: "dist/tinyfs.cjs.min.js",   entrypoint: "src/tinyfs.ts",     globalName: "tinyfs" },
    { format: "esm",  minify: false, isUMD: true,  outfile: "dist/tinyfs.umd.js",      entrypoint: "src/tinyfs.ts",     globalName: "tinyfs" },
    { format: "esm",  minify: true,  isUMD: true,  outfile: "dist/tinyfs.umd.min.js",  entrypoint: "src/tinyfs.ts",     globalName: "tinyfs" },

    // bench bundle: pure-TS shared benchmark logic, reused by both the
    // headless runner (scripts/bench.ts) and the in-browser page (bench.html).
    { format: "esm",  minify: false, isUMD: true,  outfile: "dist/bench.umd.js",     entrypoint: "bench/bench.ts", globalName: "bench"  },
    { format: "esm",  minify: true,  isUMD: true,  outfile: "dist/bench.umd.min.js", entrypoint: "bench/bench.ts", globalName: "bench"  },
];

function umdWrap (
    body       : string,
    globalName : string
) : string
{
    return `(function(root, factory) {
  if (typeof define === "function" && define.amd)
    define([], factory);
  else if (typeof exports === "object")
    module.exports = factory();
  else
    root.${globalName} = factory();
})(typeof self !== "undefined" ? self : this, function() {
${body}
});
`;
}

async function buildVariant (
    v : Variant
) : Promise<void>
{
    const sourcemap : "external" | undefined = v.minify ? undefined : "external";

    const result = await Bun.build({
        entrypoints: [v.entrypoint],
        format:      v.format,
        minify:      v.minify,
        sourcemap:   sourcemap,
        target:      v.isUMD ? "browser" : (v.format === "cjs" ? "node" : "browser"),
    });

    if (result.success === false)
    {
        console.error(`build failed for ${v.outfile}:`);
        console.error(result.logs.join("\n"));
        process.exit(1);
    }

    let code    : string = "";
    let mapCode : string = "";

    for (const out of result.outputs)
    {
        if (out.kind === "entry-point")
            code = await out.text();
        else if (out.kind === "sourcemap")
            mapCode = await out.text();
    }

    if (code.length === 0)
    {
        console.error(`no entry-point output for ${v.outfile}`);
        process.exit(1);
    }

    // For UMD: convert the trailing "export { ... };" into "return { ... };".

    if (v.isUMD)
    {
        const exportIdx : number = code.lastIndexOf("export {");

        if (exportIdx >= 0)
        {
            code = code.substring(0, exportIdx) +
                   code.substring(exportIdx).replace(/^export\s+/, "return ");

            // Convert "export { x as default }" output from tsc into a valid
            // JS return statement with a quoted "default" key.

            code = code.replace(/(\w+)\s+as\s+default\b/g, '"default": $1');
        }

        code = umdWrap(code, v.globalName);
    }

    if (v.minify === false)
    {
        // Fix sourcemap reference -- Bun emits debugId, not sourceMappingURL.

        const mapFile: string = v.outfile + ".map";
        const mapRef : string = `//# sourceMappingURL=${basename(mapFile)}`;

        code = code.replace(/\/\/# debugId=.*/, `$&\n${mapRef}`);
    }

    await Bun.write(v.outfile, code);

    if (mapCode.length > 0)
        await Bun.write(v.outfile + ".map", mapCode);
}

async function buildTypes () : Promise<void>
{
    const proc = Bun.spawnSync([
        "bunx", "tsc", "src/tinyfs.ts",
        "--declaration", "--emitDeclarationOnly",
        "--outDir", "dist",
        "--skipLibCheck",
        "--moduleResolution", "bundler",
        "--allowImportingTsExtensions",
        "--lib", "DOM,ESNext",
        "--target", "ESNext",
        "--module", "Preserve",
        "--moduleDetection", "force",
        "--strict",
        "--noFallthroughCasesInSwitch",
        "--noUncheckedIndexedAccess",
        "--noImplicitOverride",
    ]);

    if (proc.exitCode !== 0)
    {
        console.error(proc.stderr.toString());
        process.exit(1);
    }
}

async function main () : Promise<void>
{
    if (!existsSync("dist"))
        await Bun.spawnSync(["mkdir", "-p", "dist"]);

    for (const v of VARIANTS)
    {
        process.stdout.write(`building ${v.outfile} ... `);
        await buildVariant(v);
        process.stdout.write("ok\n");
    }

    process.stdout.write("building types ... ");
    await buildTypes();
    process.stdout.write("ok\n");
}

await main();
