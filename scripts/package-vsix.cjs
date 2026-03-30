const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const packageJson = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
const outputFile = `markdown-zh-translator-${packageJson.version}.vsix`;

const command = resolve(
  __dirname,
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vsce.cmd" : "vsce"
);

const result =
  process.platform === "win32"
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command, "package", "--out", outputFile], {
        stdio: "inherit"
      })
    : spawnSync(command, ["package", "--out", outputFile], {
        stdio: "inherit"
      });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
