const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const packageJson = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
const outputFile = `markdown-zh-translator-${packageJson.version}.vsix`;

const vsceEntrypoint = require.resolve("@vscode/vsce/vsce");
const result = spawnSync(process.execPath, [vsceEntrypoint, "package", "--out", outputFile], {
  stdio: "inherit"
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
