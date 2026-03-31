# Markdown Zh Translator

Translate a saved Markdown document into `*.zh-CN.md` inside VS Code.

## What V1 Does

- Adds two editor title actions for eligible Markdown documents.
- Adds a force-refresh action when you want a brand new translation instead of a cache or local blob restore result.
- Sends the entire source Markdown document in one `chat/completions` request.
- Expects the model to return one outer ``````markdown fenced block.
- Reuses an existing translated file when the cache is still valid.
- Restores a deleted translated file from the persistent local blob cache when the source and config still match.
- Refuses to overwrite a translated file that has unsaved editor changes.
- Can optionally delete the workspace `.zh-CN.md` file when the translated document closes, while keeping the local blob cache.

## Configuration

Set these settings in VS Code:

- `markdownTranslator.model`
- `markdownTranslator.baseUrl` (optional; defaults to `https://api.openai.com/v1`)
- `markdownTranslator.requestTimeoutMs`
- `markdownTranslator.systemPrompt` (optional)
- `markdownTranslator.localBlobCacheMaxBytes` (optional; defaults to `10485760`)
- `markdownTranslator.deleteTranslatedOnClose` (optional; defaults to `false`)

Store the API key with the command:

- `Markdown Translator: Set API Key`

Clear the API key with:

- `Markdown Translator: Clear API Key`

## Response Contract

The model must return exactly one outer fenced block using 5 backticks:

``````text
`````markdown
<translated markdown>
`````
``````

The extension extracts only the Markdown inside the unique outer fence. JSON, malformed fences, or responses with zero or multiple candidate fences are rejected. If the model adds a little noise before or after the unique fence, that noise is discarded.

## Development

```bash
npm install
npm run lint
npm run compile
npm test
```

Run the extension with `F5` in VS Code.

## Known Limits

- Buttons can appear for any Markdown editor, but translation still expects a saved document with a usable path.
- `*.zh-CN.md` files are still treated as generated targets, not sources.
- V1 relies on prompt rules to preserve Markdown structure and intentionally does not hard-reject minor formatting drift from the model.
