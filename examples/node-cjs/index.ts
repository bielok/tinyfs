import "fake-indexeddb/auto";
import { TinyFS, O } from "@bielok/tinyfs";

async function main() {
    const tfs = await TinyFS.create("my-db");
    const fd = await tfs.open("/f", O.CREATE | O.READ_WRITE);
    await tfs.write(fd, new Uint8Array([1, 2, 3]), 3);
    tfs.close(fd);
    tfs.shutdown();
}

main();
