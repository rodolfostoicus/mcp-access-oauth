// Encode the four reviewed AHA vertical drafts for immutable public delivery.
// This performs transport conversion and a negligible 9:16 fit only; no redesign.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const [inputDir, outputDir] = process.argv.slice(2);
if (!inputDir || !outputDir) {
  throw new Error("Usage: node scripts/add-aha-vertical-assets.cjs INPUT_DIR OUTPUT_DIR");
}

const originals = [
  ["aha-acls-ritmo-stories-v1", "acls-ritmo-decisao-stories-v1.png"],
  ["aha-pals-avaliacao-stories-v1", "pals-avaliacao-stories-v1.png"],
  ["aha-acls-conheca-stories-v1", "acls-conheca-stories-v1.png"],
  ["aha-pals-conheca-stories-v1", "pals-conheca-stories-v1.png"],
];
const manifestPath = path.join(__dirname, "../src/creative-manifest.ts");
let manifest = fs.readFileSync(manifestPath, "utf8");
fs.mkdirSync(outputDir, { recursive: true });
const index = [];

for (const [label, original] of originals) {
  const source = path.join(inputDir, original);
  const intermediate = path.join(outputDir, label + ".jpg");
  execFileSync("convert", [
    source,
    "-resize", "1080x1920^",
    "-gravity", "center",
    "-extent", "1080x1920",
    "-strip",
    "-colorspace", "sRGB",
    "-sampling-factor", "4:4:4",
    "-quality", "90",
    intermediate,
  ]);
  const bytes = fs.readFileSync(intermediate);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const filename = `${label}-${digest.slice(0, 16)}.jpg`;
  const pathname = "/creative-assets/" + filename;
  const identifier = label.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  const moduleName = label + ".ts";
  const modulePath = path.join(__dirname, "../src/creative-data", moduleName);
  fs.writeFileSync(
    modulePath,
    `// Public AHA artwork, JPEG transport encoding. SHA256: ${digest}\nexport default ${JSON.stringify(bytes.toString("base64"))};\n`,
  );
  fs.renameSync(intermediate, path.join(outputDir, filename));
  const importLine = `import ${identifier} from "./creative-data/${label}";`;
  const entryLine = `  "${pathname}": { mimeType: "image/jpeg", base64: ${identifier} },`;
  if (!manifest.includes(importLine)) {
    manifest = manifest.replace(
      /\nexport const CREATIVE_ASSETS:/,
      `\n${importLine}\n\nexport const CREATIVE_ASSETS:`,
    );
  }
  if (!manifest.includes(pathname)) {
    manifest = manifest.replace(
      'export const CREATIVE_ASSETS: Record<string, { mimeType: "image/jpeg" | "image/png"; base64: string }> = {\n',
      (match) => match + entryLine + "\n",
    );
  }
  index.push({ label, pathname, sha256: digest, bytes: bytes.length, source: original });
}

fs.writeFileSync(manifestPath, manifest);
fs.writeFileSync(path.join(outputDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
process.stdout.write(JSON.stringify(index));
