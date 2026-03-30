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
});

function createLogger(): LoggerPort {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
