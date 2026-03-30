import { strict as assert } from "node:assert";

import { MarkdownIntegrityValidator } from "../services/markdownIntegrityValidator";

const SOURCE = [
  "---",
  "title: Quick Start",
  "tags:",
  "  - getting-started",
  "  - basics",
  "details: |",
  "  First line.",
  "  Second line.",
  "sidebar_position: 1",
  "---",
  "",
  "# Welcome",
  "",
  "Use `npm install`.",
  "",
  "The setup script lives at docs/setup/install.sh.",
  "",
  "The package manifest is package.json and the docs live in README.md.",
  "",
  "See https://example.com/docs and <https://example.com/reference>.",
  "",
  "[ref]: ./docs/setup/install.sh",
  "",
  "![Architecture](./images/arch.png)",
  "",
  "<Callout type=\"info\">Note</Callout>",
  "",
  "Euler: $e^{i\\pi} + 1 = 0$",
  "",
  "```ts",
  "console.log('keep code unchanged')",
  "```",
  ""
].join("\n");

describe("MarkdownIntegrityValidator", () => {
  it("accepts translations that preserve protected structures", () => {
    const validator = new MarkdownIntegrityValidator();

    validator.validate({
      sourceMarkdown: SOURCE,
      translatedMarkdown: SOURCE.replace("Quick Start", "快速开始")
        .replace("getting-started", "入门")
        .replace("basics", "基础")
        .replace("First line.", "第一行。")
        .replace("Second line.", "第二行。")
        .replace("sidebar_position: 1", "sidebar_position: 第一章")
        .replace("# Welcome", "# 欢迎")
    });
  });

  it("rejects changed link or code structures", () => {
    const validator = new MarkdownIntegrityValidator();

    assert.throws(
      () =>
        validator.validate({
          sourceMarkdown: SOURCE,
          translatedMarkdown: SOURCE.replace("./images/arch.png", "./images/changed.png")
        }),
      /image targets/
    );
  });

  it("rejects changed standalone file paths", () => {
    const validator = new MarkdownIntegrityValidator();

    assert.throws(
      () =>
        validator.validate({
          sourceMarkdown: SOURCE,
          translatedMarkdown: SOURCE.replace("docs/setup/install.sh", "docs/安装/install.sh")
        }),
      /file paths/
    );
  });

  it("rejects changed bare URLs and reference targets", () => {
    const validator = new MarkdownIntegrityValidator();

    assert.throws(
      () =>
        validator.validate({
          sourceMarkdown: SOURCE,
          translatedMarkdown: SOURCE.replace("https://example.com/docs", "https://example.cn/docs")
        }),
      /bare URLs/
    );

    assert.throws(
      () =>
        validator.validate({
          sourceMarkdown: SOURCE,
          translatedMarkdown: SOURCE.replace("[ref]: ./docs/setup/install.sh", "[ref]: ./docs/setup/changed.sh")
        }),
      /reference targets/
    );
  });

  it("rejects changed frontmatter style even when keys stay the same", () => {
    const validator = new MarkdownIntegrityValidator();

    assert.throws(
      () =>
        validator.validate({
          sourceMarkdown: SOURCE,
          translatedMarkdown: SOURCE.replace("tags:\n  - getting-started\n  - basics", "tags: [入门, 基础]")
        }),
      /frontmatter keys or structure/
    );

    assert.throws(
      () =>
        validator.validate({
          sourceMarkdown: SOURCE,
          translatedMarkdown: SOURCE.replace("details: |", "details: >")
        }),
      /frontmatter keys or structure/
    );
  });

  it("rejects changed frontmatter keys", () => {
    const validator = new MarkdownIntegrityValidator();

    assert.throws(
      () =>
        validator.validate({
          sourceMarkdown: SOURCE,
          translatedMarkdown: SOURCE.replace("title: Quick Start", "标题: 快速开始")
        }),
      /frontmatter keys or structure/
    );
  });
});
