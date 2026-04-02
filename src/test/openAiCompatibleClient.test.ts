import { strict as assert } from "node:assert";

import { OpenAiCompatibleClient } from "../services/openAiCompatibleClient";
import type { LoggerPort } from "../services/ports";

describe("OpenAiCompatibleClient", () => {
  it("preserves status code and response body when a non-JSON error response is returned", async () => {
    const client = new OpenAiCompatibleClient(createLogger(), async () => ({
      ok: false,
      status: 502,
      text: async () => "<html>bad gateway</html>"
    }));

    await assert.rejects(
      () =>
        client.translateDocument("# Hello", {
          model: "gpt-test",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "secret",
          promptVersion: "v1",
          rulesVersion: "v1",
          requestTimeoutMs: 1000
        }),
      /502: <html>bad gateway<\/html>/
    );
  });

  it("extracts only text segments when the provider returns array content", async () => {
    const client = new OpenAiCompatibleClient(createLogger(), async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  { type: "text", text: "`````markdown\n# 标题\n" },
                  { type: "image_url", text: "should-be-ignored" },
                  { type: "text", text: "`````" }
                ]
              }
            }
          ]
        })
    }));

    const result = await client.translateDocument("# Hello", {
      model: "gpt-test",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "secret",
      promptVersion: "v1",
      rulesVersion: "v1",
      requestTimeoutMs: 1000
    });

    assert.equal(result, "`````markdown\n# 标题\n`````");
  });
});

function createLogger(): LoggerPort {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
