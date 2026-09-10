import { build } from "esbuild";
import { mkdir, copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
await mkdir(resolve(root, "dist"), { recursive: true });
for (const name of await readdir(resolve(root, "public"))) {
  await copyFile(resolve(root, "public", name), resolve(root, "dist", name));
}
await copyFile(resolve(root, "src/graph.css"), resolve(root, "dist/graph.css"));
await copyFile(resolve(root, "LICENSE"), resolve(root, "dist/LICENSE"));
const fflate = JSON.parse(await readFile(resolve(root, "node_modules/fflate/package.json"), "utf8"));
const fflateLicense = await readFile(resolve(root, "node_modules/fflate/LICENSE"), "utf8");
await writeFile(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), `Third-party notices\n\nfflate ${fflate.version}\nhttps://github.com/101arrowz/fflate\n\n${fflateLicense}\n`);
await build({
  absWorkingDir: root,
  entryPoints: ["src/app.ts", "src/popup.ts", "src/background.ts"],
  bundle: true,
  outdir: "dist",
  format: "esm",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
});
