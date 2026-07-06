import puppeteer, { Browser, Page } from "puppeteer-core";
import { test, expect, describe, beforeAll, afterAll } from "bun:test";

let browser : Browser | null = null;
let page    : Page | null    = null;
let server  : any            = null;

function findChrome () : string | null
{
    if (process.env.CHROME_PATH)
        return process.env.CHROME_PATH;

    const candidates : string[] = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ];

    for (const p of candidates)
    {
        try
        {
            const f = Bun.file(p);

            if (f.size > 0)
                return p;
        }
        catch {}
    }

    return null;
}

const chromePath : string | null = findChrome();

beforeAll(async () =>
{
    if (!chromePath)
    {
        console.warn("Chrome not found -- skipping atomicity tests. Set CHROME_PATH to specify a custom path.");
        return;
    }

    server = Bun.serve({
        port: 0,
        async fetch (req : Request) : Promise<Response>
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
        executablePath: chromePath,
        args: ["--no-sandbox", "--disable-web-security"],
    });

    page = await browser.newPage();
    await page.goto(`http://localhost:${server.port}/tests/browser-atomicity.html`);
    await page.waitForFunction("typeof window.__atomicity !== 'undefined'");
    await page.evaluate(async () =>
    {
        const { TinyFS } = (window as any).tinyfs;
        (window as any).tfs = await TinyFS.create("tinyfs");
    });
});

afterAll(async () =>
{
    if (browser)
        await browser.close();

    if (server)
        server.stop();
});

const it = chromePath ? test : test.skip;

describe("atomicity", () =>
{
    for (const name of [
        "write rolls back on block put failure",
        "mkdir rolls back on add failure",
        "unlink rolls back on parent update failure",
        "rename rolls back on first mutation failure",
        "TRUNCATE rolls back on size update failure",
    ])
    {
        it(name, async () =>
        {
            const result = await page!.evaluate(
                (n : string) => (window as any).__atomicity.tests[n](),
                name
            );

            expect(result).toBeNull();
        });
    }
});
