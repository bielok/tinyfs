import "fake-indexeddb/auto";
import { TinyFS, O } from "@bielok/tinyfs";

const tfs = await TinyFS.create("my-db");

const fd = await tfs.open("/hello", O.CREATE | O.READ_WRITE);
await tfs.write(fd, new TextEncoder().encode("hello"), 5);
await tfs.lseek(fd, 0, O.SET);

const buf = new Uint8Array(5);
await tfs.read(fd, buf, 5);

tfs.close(fd);
tfs.shutdown();
