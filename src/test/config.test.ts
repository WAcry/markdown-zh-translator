import { strict as assert } from "node:assert";

import { readExtensionSettings } from "../util/config";
import { computeConfigSignature, PROVIDER_ID, TARGET_LOCALE } from "../util/translationContract";

describe("config", () => {
  it("uses the default baseUrl when none is configured", () => {
    const settings = readExtensionSettings(createConfigPort({ model: "gpt-test" }));

    assert.equal(settings.baseUrl, "https://api.openai.com/v1");
  });

  it("throws when model is missing", () => {
    assert.throws(() => readExtensionSettings({ get: () => undefined }), /markdownTranslator\.model/);
  });

  it("throws when baseUrl is invalid", () => {
    assert.throws(
      () =>
        readExtensionSettings(
          createConfigPort({
            model: "gpt-test",
            baseUrl: "not-a-url"
          })
        ),
      /baseUrl/
    );
  });

  it("rejects non-http schemes that only start with http", () => {
    assert.throws(
      () =>
        readExtensionSettings(
          createConfigPort({
            model: "gpt-test",
            baseUrl: "httpx://example.com"
          })
        ),
      /baseUrl/
    );
  });

  it("changes the config signature when systemPrompt changes", () => {
    const left = computeConfigSignature({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-test",
      systemPrompt: "left"
    });
    const right = computeConfigSignature({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-test",
      systemPrompt: "right"
    });

    assert.notEqual(left, right);
    assert.equal(TARGET_LOCALE, "zh-CN");
    assert.equal(PROVIDER_ID, "openai-compatible");
  });
});

function createConfigPort(values: Record<string, unknown>) {
  return {
    get: <T>(key: string) => values[key] as T | undefined
  };
}
