import { TinyFS, O } from "@bielok/tinyfs";

const tfs = await TinyFS.create("my-db");

const fd = await tfs.open("/hello", O.CREATE | O.READ_WRITE);
await tfs.write(fd, new TextEncoder().encode("hello"), 5);
await tfs.lseek(fd, 0, O.SET);

const buf = new Uint8Array(5);
const nr = await tfs.read(fd, buf, 5);
console.log(new TextDecoder().decode(buf.subarray(0, nr)));

const sb = { size: 0, mode: 0, nlink: 0 };
await tfs.stat("/hello", sb);
console.log("is dir?", (sb.mode & O.TYPE_MASK) === O.TYPE_DIR);

tfs.close(fd);
tfs.shutdown();
