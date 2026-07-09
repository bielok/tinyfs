import puppeteer, { Browser, Page } from "puppeteer-core";
import { test, expect, describe, beforeAll, afterAll } from "bun:test";

let browser : Browser | null = null;
let page    : Page | null    = null;
let server  : any            = null;

beforeAll(async () =>
{
    server = Bun.serve({
        port: 0,
        async fetch (
            req : Request
        ) : Promise<Response>
        {
            const url  = new URL(req.url);
            const file = Bun.file("." + url.pathname);

            if (!await file.exists())
                return new Response("not found", { status: 404 });

            return new Response(file);
        },
    });

    browser = await puppeteer.launch({
        headless: !process.env.NO_HEADLESS,
        channel: 'chrome',
        args: ["--no-sandbox", "--disable-web-security"],
    });

    page = await browser.newPage();
    await page.goto(`http://localhost:${server.port}/tests/browser-harness.html`);
    await page.waitForFunction("typeof window.__tests !== 'undefined'");
    await page.evaluate(async () => {
        const { TinyFS } = window.tinyfs;
        window.tfs = await TinyFS.create("tinyfs");
    });
});

afterAll(async () => {
    if (browser)
        await browser.close();

    if (server)
        server.stop();
});

describe("browser", () => {
    for (const name of [
        "stat root directory",
        "stat nonexistent path",
        "stat a new directory",
        "stat a regular file",
        "mkdir and rmdir basic",
        "rmdir non-empty directory",
        "mkdir existing returns -1",
        "mkdir missing parent returns -1",
        "rmdir on root returns -1",
        "rmdir on regular file returns -1",
        "open with CREATE succeeds",
        "close invalid fd returns -1",
        "EXCLUSIVE fails on existing file",
        "open dir with WRONLY returns -1",
        "open without CREATE on missing file returns -1",
        "write and read back",
        "read 0 bytes at EOF on fresh file",
        "write across block boundary",
        "READ rejects writes",
        "WRITE rejects reads",
        "write 0 bytes returns 0",
        "lseek SET CURRENT END",
        "lseek invalid whence returns -1",
        "hard link preserves data",
        "unlink directory returns -1",
        "TRUNCATE clears file",
        "APPEND appends regardless of seek",
        "readdir lists entries",
        "readdir on regular file returns -1",
        "rename preserves data",
        "rename nonexistent source returns -1",
        "rmdir nonexistent directory returns -1",
        "exhaust fd table gracefully",
        "handle partial read",
        "overwrite at offset after seek",
        "write on directory fd returns -1",
        "read 0 bytes returns 0",
        "read on directory fd returns -1",
        "lseek invalid fd returns -1",
        "decrement nlink on unlink",
        "link directory returns -1",
        "link nonexistent source returns -1",
        "link target exists returns -1",
        "unlink nonexistent path returns -1",
        "unlink root returns -1",
        "TRUNCATE no-op on empty file",
        "TRUNCATE fails without CREATE on nonexistent file",
        "create and stat deeply nested dirs",
        "path normalization with ..",
        "two fds to same file write via one read via the other",
        "open unlink close close succeeds after unlink",
        "write exactly BLOCK_SIZE bytes",
        "write BLOCK_SIZE + 1 bytes cross one boundary",
        "write 2 times BLOCK_SIZE bytes",
        "unlink one link preserves data via the other",
        "unlink all links deletes file",
        "sparse file seek past EOF write read back",
        "APPEND with two fds both append to end",
        "fd slot reuse after close",
        "read fewer bytes than requested near EOF",
        "readdir empty directory returns empty array",
        "readdir nonexistent path returns -1",
        "rename overwrite existing target",
        "rename directory source returns -1",
        "rename target parent missing returns -1",
    ])
    {
        test(name, async () => {
            const result = await page!.evaluate(
                (n : string) => window.__tests[n]!(),
                name
            );

            expect(result).toBeNull();
        });
    }
});
