export class MarkdownResponseParser {
  public extractTranslatedMarkdown(rawResponse: string): string {
    const matches = Array.from(rawResponse.matchAll(/`````markdown\r?\n([\s\S]*?)\r?\n`````/g));
    if (matches.length !== 1) {
      throw new Error("Model response must include exactly one outer `````markdown fenced block");
    }

    return matches[0][1];
  }
}
