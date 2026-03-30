import { isMap, isScalar, isSeq, parseDocument } from "yaml";

export interface IntegrityValidationInput {
  sourceMarkdown: string;
  translatedMarkdown: string;
}

export class MarkdownIntegrityValidator {
  public validate(input: IntegrityValidationInput): void {
    const sourceFrontmatter = extractFrontmatter(input.sourceMarkdown);
    const translatedFrontmatter = extractFrontmatter(input.translatedMarkdown);

    if (Boolean(sourceFrontmatter) !== Boolean(translatedFrontmatter)) {
      throw new Error("Translated Markdown changed YAML frontmatter presence");
    }

    if (sourceFrontmatter && translatedFrontmatter) {
      const normalizedSource = normalizeFrontmatterStructure(sourceFrontmatter);
      const normalizedTranslated = normalizeFrontmatterStructure(translatedFrontmatter);
      if (
        sourceFrontmatter.opener !== translatedFrontmatter.opener ||
        sourceFrontmatter.closer !== translatedFrontmatter.closer ||
        normalizedSource !== normalizedTranslated
      ) {
        throw new Error("Translated Markdown changed YAML frontmatter keys or structure");
      }
    }

    compareArrays("fenced code blocks", extractFencedCodeBlocks(input.sourceMarkdown), extractFencedCodeBlocks(input.translatedMarkdown));
    compareArrays("inline code spans", extractInlineCode(input.sourceMarkdown), extractInlineCode(input.translatedMarkdown));
    compareArrays("link targets", extractLinkTargets(input.sourceMarkdown), extractLinkTargets(input.translatedMarkdown));
    compareArrays("image targets", extractImageTargets(input.sourceMarkdown), extractImageTargets(input.translatedMarkdown));
    compareArrays("reference targets", extractReferenceTargets(input.sourceMarkdown), extractReferenceTargets(input.translatedMarkdown));
    compareArrays("bare URLs", extractBareUrls(input.sourceMarkdown), extractBareUrls(input.translatedMarkdown));
    compareArrays("file paths", extractStandaloneFilePaths(input.sourceMarkdown), extractStandaloneFilePaths(input.translatedMarkdown));
    compareArrays("HTML tag names", extractHtmlTagNames(input.sourceMarkdown), extractHtmlTagNames(input.translatedMarkdown));
    compareArrays("math spans", extractMathSpans(input.sourceMarkdown), extractMathSpans(input.translatedMarkdown));
  }
}

function compareArrays(label: string, left: string[], right: string[]): void {
  if (left.length !== right.length) {
    throw new Error(`Translated Markdown changed ${label}`);
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      throw new Error(`Translated Markdown changed ${label}`);
    }
  }
}

interface FrontmatterBlock {
  opener: string;
  body: string;
  closer: string;
}

function extractFrontmatter(markdown: string): FrontmatterBlock | undefined {
  const match = /^(---)\r?\n([\s\S]*?)\r?\n(---|\.\.\.)\r?\n?/.exec(markdown);
  if (!match) {
    return undefined;
  }

  return {
    opener: match[1],
    body: match[2],
    closer: match[3]
  };
}

function normalizeFrontmatterStructure(frontmatter: FrontmatterBlock): string {
  const document = parseDocument(frontmatter.body, {
    prettyErrors: false
  });

  if (document.errors.length > 0) {
    throw new Error("Unable to parse YAML frontmatter for structure validation");
  }

  return normalizeYamlNode(document.contents, 0).join("\n") + "\n---RAW---\n" + normalizeFrontmatterLines(frontmatter.body);
}

function normalizeYamlNode(node: unknown, indent: number): string[] {
  const prefix = " ".repeat(indent);

  if (isMap(node)) {
    const lines: string[] = [];
    for (const item of node.items) {
      const key = isScalar(item.key) ? String(item.key.value) : String(item.key?.toString() ?? "");
      if (isMap(item.value) || isSeq(item.value)) {
        lines.push(`${prefix}${key}:`);
        lines.push(...normalizeYamlNode(item.value, indent + 2));
      } else {
        lines.push(`${prefix}${key}: __VALUE__`);
      }
    }
    return lines;
  }

  if (isSeq(node)) {
    const lines: string[] = [];
    for (const item of node.items) {
      if (isMap(item) || isSeq(item)) {
        lines.push(`${prefix}-`);
        lines.push(...normalizeYamlNode(item, indent + 2));
      } else {
        lines.push(`${prefix}- __VALUE__`);
      }
    }
    return lines;
  }

  return [`${prefix}__VALUE__`];
}

function normalizeFrontmatterLines(frontmatterBody: string): string {
  const lines = frontmatterBody.split(/\r?\n/);
  const normalized: string[] = [];
  let blockScalarIndent: number | undefined;

  for (const line of lines) {
    if (blockScalarIndent !== undefined) {
      const currentIndent = line.match(/^ */)?.[0].length ?? 0;
      if (line.trim() === "") {
        normalized.push("");
        continue;
      }
      if (currentIndent >= blockScalarIndent) {
        normalized.push(`${" ".repeat(currentIndent)}__BLOCK_VALUE__`);
        continue;
      }
      blockScalarIndent = undefined;
    }

    const blockScalarMatch = /^(\s*[^:#\-\s][^:]*:\s*)([>|][+-]?\d*)\s*$/.exec(line);
    if (blockScalarMatch) {
      normalized.push(line);
      blockScalarIndent = (line.match(/^ */)?.[0].length ?? 0) + 2;
      continue;
    }

    const flowMatch = /^(\s*[^:#\-\s][^:]*:\s*)(\[[\s\S]*\]|\{[\s\S]*\})\s*$/.exec(line);
    if (flowMatch) {
      const open = flowMatch[2][0];
      const close = flowMatch[2][flowMatch[2].length - 1];
      normalized.push(`${flowMatch[1]}${open}__VALUE__${close}`);
      continue;
    }

    const keyValueMatch = /^(\s*[^:#\-\s][^:]*:\s*)(.+)$/.exec(line);
    if (keyValueMatch) {
      normalized.push(`${keyValueMatch[1]}${normalizeInlineYamlValue(keyValueMatch[2])}`);
      continue;
    }

    const sequenceValueMatch = /^(\s*-\s+)(.+)$/.exec(line);
    if (sequenceValueMatch) {
      normalized.push(`${sequenceValueMatch[1]}${normalizeInlineYamlValue(sequenceValueMatch[2])}`);
      continue;
    }

    normalized.push(line);
  }

  return normalized.join("\n");
}

function normalizeInlineYamlValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    return `${trimmed[0]}__VALUE__${trimmed[trimmed.length - 1]}`;
  }

  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return `${trimmed[0]}__VALUE__${trimmed[trimmed.length - 1]}`;
  }

  return "__VALUE__";
}

function extractFencedCodeBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let current: string[] | undefined;
  let fence: string | undefined;

  for (const line of lines) {
    if (!current) {
      const start = /^([`~]{3,})(.*)$/.exec(line);
      if (start) {
        current = [line];
        fence = start[1];
      }
      continue;
    }

    current.push(line);
    if (new RegExp(`^${escapeRegExp(fence ?? "")}[ \t]*$`).test(line)) {
      blocks.push(current.join("\n"));
      current = undefined;
      fence = undefined;
    }
  }

  return blocks;
}

function extractInlineCode(markdown: string): string[] {
  const sanitized = removeFencedBlocks(markdown);
  const values: string[] = [];

  for (let index = 0; index < sanitized.length; index += 1) {
    if (sanitized[index] !== "`") {
      continue;
    }

    let tickCount = 1;
    while (sanitized[index + tickCount] === "`") {
      tickCount += 1;
    }

    const fence = "`".repeat(tickCount);
    const end = sanitized.indexOf(fence, index + tickCount);
    if (end === -1) {
      continue;
    }

    const inner = sanitized.slice(index + tickCount, end);
    if (!inner.includes("\n")) {
      values.push(inner);
    }
    index = end + tickCount - 1;
  }

  return values;
}

function extractLinkTargets(markdown: string): string[] {
  const sanitized = removeFencedBlocks(markdown);
  const targets: string[] = [];
  for (const match of sanitized.matchAll(/(?<!!)\[[^\]]*]\(([^)\r\n]+)\)/g)) {
    targets.push(match[1]);
  }
  return targets;
}

function extractImageTargets(markdown: string): string[] {
  const sanitized = removeFencedBlocks(markdown);
  const targets: string[] = [];
  for (const match of sanitized.matchAll(/!\[[^\]]*]\(([^)\r\n]+)\)/g)) {
    targets.push(match[1]);
  }
  return targets;
}

function extractStandaloneFilePaths(markdown: string): string[] {
  const sanitized = removeInlineCode(
    removeLinksAndUrls(
      removeFencedBlocks(markdown)
    )
  );
  const paths: string[] = [];
  const pattern =
    /(?:^|[\s(])((?:\.{1,2}\/|\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_-]+)?|[A-Za-z]:\\(?:[^\\\s<>:"|?*]+\\)*[^\\\s<>:"|?*]+(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+)(?=$|[\s),.;:])/g;

  for (const match of sanitized.matchAll(pattern)) {
    paths.push(match[1]);
  }
  return paths;
}

function extractReferenceTargets(markdown: string): string[] {
  const sanitized = removeFencedBlocks(markdown);
  const targets: string[] = [];
  for (const match of sanitized.matchAll(/^\s*\[[^\]]+]:\s+(\S+)/gm)) {
    targets.push(match[1]);
  }
  return targets;
}

function extractBareUrls(markdown: string): string[] {
  const sanitized = removeInlineCode(removeFencedBlocks(markdown));
  const urls: string[] = [];

  for (const match of sanitized.matchAll(/<((?:https?:\/\/)[^>\s]+)>/g)) {
    urls.push(match[1]);
  }

  for (const match of sanitized.matchAll(/(?<!\()(?<!\[)(https?:\/\/[^\s<>)\]]+)/g)) {
    urls.push(match[1]);
  }

  return urls;
}

function extractHtmlTagNames(markdown: string): string[] {
  const sanitized = removeFencedBlocks(markdown);
  const tags: string[] = [];
  for (const match of sanitized.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)\b[^>]*>/g)) {
    tags.push(match[1].toLowerCase());
  }
  return tags;
}

function extractMathSpans(markdown: string): string[] {
  const sanitized = removeFencedBlocks(markdown);
  const math: string[] = [];
  for (const match of sanitized.matchAll(/\$\$[\s\S]*?\$\$|\$(?!\s)[^$\r\n]+?\$/g)) {
    math.push(match[0]);
  }
  return math;
}

function removeFencedBlocks(markdown: string): string {
  return markdown.replace(/^([`~]{3,})(.*)\r?\n[\s\S]*?^\1[ \t]*$/gm, "");
}

function removeInlineCode(markdown: string): string {
  return markdown.replace(/`+[^`\r\n]+`+/g, "");
}

function removeLinksAndUrls(markdown: string): string {
  return markdown
    .replace(/!?\[[^\]]*]\(([^)\r\n]+)\)/g, "")
    .replace(/https?:\/\/\S+/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
