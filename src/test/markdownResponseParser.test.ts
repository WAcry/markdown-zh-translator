import { strict as assert } from "node:assert";

import { MarkdownResponseParser } from "../services/markdownResponseParser";

describe("MarkdownResponseParser", () => {
  it("extracts the translated markdown from a valid fenced block", () => {
    const parser = new MarkdownResponseParser();
    const result = parser.extractTranslatedMarkdown("`````markdown\n# 标题\n`````");

    assert.equal(result, "# 标题");
  });

  it("ignores non-document text before and after the fenced block", () => {
    const parser = new MarkdownResponseParser();
    const result = parser.extractTranslatedMarkdown("Here is the translation:\n`````markdown\n# 标题\n`````\nDone.");

    assert.equal(result, "# 标题");
  });

  it("rejects malformed responses", () => {
    const parser = new MarkdownResponseParser();

    assert.throws(() => parser.extractTranslatedMarkdown("{\"markdown\": \"bad\"}"), /fenced block/);
    assert.throws(() => parser.extractTranslatedMarkdown("```markdown\nbad\n```"), /fenced block/);
    assert.throws(
      () => parser.extractTranslatedMarkdown("`````markdown\n# 一\n`````\n\n`````markdown\n# 二\n`````"),
      /exactly one/
    );
  });
});
