import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
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

// Experiment results (T12): copy them and write an index, newest first.
const resultsSource = path.resolve(webRoot, "../experiments/results");
const resultsDestination = path.resolve(webRoot, "public/results");
await mkdir(resultsDestination, { recursive: true });
const results = (await readdir(resultsSource).catch(() => []))
  .filter((file) => file.endsWith(".json"))
  .sort()
  .reverse();
await Promise.all(
  results.map((file) => copyFile(path.join(resultsSource, file), path.join(resultsDestination, file))),
);
await writeFile(path.join(resultsDestination, "index.json"), JSON.stringify(results, null, 2) + "\n");
