import { copyFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(webRoot, "../fixtures");
const destination = path.resolve(webRoot, "public/fixtures");

await mkdir(destination, { recursive: true });
const files = (await readdir(source)).filter((file) => file.endsWith(".json"));
await Promise.all(
  files.map((file) => copyFile(path.join(source, file), path.join(destination, file))),
);
