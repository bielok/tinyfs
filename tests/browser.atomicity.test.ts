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
        channel:  'chrome',
        args:     [ "--no-sandbox", "--disable-web-security" ],
    });

    page = await browser.newPage();
    await page.goto(`http://localhost:${server.port}/tests/browser-atomicity.html`);
    await page.waitForFunction("typeof window.__atomicity !== 'undefined'");
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

describe("atomicity", () => {
    for (const name of [
        "write rolls back on block put failure",
        "mkdir rolls back on add failure",
        "unlink rolls back on parent update failure",
        "rename rolls back on first mutation failure",
        "TRUNCATE rolls back on size update failure",
    ])
    {
        test(name, async () => {
            const result = await page!.evaluate(
                (n : string) => window.__atomicity.tests[n]!(),
                name
            );

            expect(result).toBeNull();
        });
    }
});
