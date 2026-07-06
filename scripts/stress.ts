import os from "node:os";
import puppeteer, { Browser, Page } from "puppeteer-core";

// tinyfs browser stress test harness
//
// Launches headless Chrome, serves bench/stress.html which loads the
// tinyfs UMD and bench UMD bundles, runs latency and throughput benchmarks
// inside IndexedDB, and writes the formatted report to stdout.
//
// Usage:  bun run scripts/stress.ts
// Option: CHROME_PATH=/custom/path bun run scripts/stress.ts

const HARNESS_HTML = "bench/stress.html";

async function main () : Promise<void>
{
    const cpus    = os.cpus();
    const cpuInfo = cpus.length > 0 ? `${cpus[0]!.model.trim()} (${cpus.length} cores)` : "unknown";

    // Serve the bench HTML at / and /dist/* files from the project root.

    const harness_html : string = await Bun.file(HARNESS_HTML).text();

    const server = Bun.serve({
        port: 0,
        async fetch (req : Request) : Promise<Response>
        {
            const url = new URL(req.url);

            if (url.pathname === "/")
            {
                return new Response(
                    harness_html,
                    { headers: { "Content-Type": "text/html" } },
                );
            }

            const file = Bun.file("." + url.pathname);

            if (!await file.exists())
                return new Response("not found", { status: 404 });

            return new Response(file);
        },
    });

    const url : string = `http://localhost:${server.port}/`;

    const launchOpts : any = {
        headless: !process.env.NO_HEADLESS,
        args:     ["--no-sandbox", "--disable-web-security"],
    };

    if (process.env.CHROME_PATH)
        launchOpts.executablePath = process.env.CHROME_PATH;
    else
        launchOpts.channel = "chrome";

    const browser : Browser = await puppeteer.launch(launchOpts);

    try
    {
        const page : Page = await browser.newPage();

        await page.goto(url);
        await page.waitForFunction("typeof window.__DONE__ !== 'undefined'", { timeout: 180000 });

        const chromeVersion : string = await browser.version();
        const chromeLabel  : string = browser.process()?.spawnfile
            ?? process.env.CHROME_PATH
            ?? "auto";

        // Read rendered output from the page.

        const { output_text, summary_text } = await page.evaluate(() => ({
            output_text  : document.getElementById("output")!.textContent,
            summary_text : document.getElementById("summary")!.textContent,
        }));

        console.log("tinyfs stress test\n");
        console.log(`chrome:      ${chromeLabel}`);
        console.log(`cpu:         ${cpuInfo}`);
        console.log(`time:        ${new Date().toISOString()}`);
        console.log(`runtime:     ${chromeVersion}`);
        console.log("database:    IndexedDB");
        console.log("");
        console.log(output_text);
        console.log(summary_text);
    }
    finally
    {
        await browser.close();
        server.stop();
    }
}

main().catch((err) => {
    console.error("stress test failed:", err);
    process.exit(1);
});
