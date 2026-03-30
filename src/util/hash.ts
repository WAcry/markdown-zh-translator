import { createHash } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(normalizeLineEndings(value), "utf8").digest("hex");
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function toCrLfLineEndings(value: string): string {
  return normalizeLineEndings(value).replace(/\n/g, "\r\n");
}

export function sha256HexRaw(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function matchesStoredTextHash(value: string, storedHash: string | undefined): boolean {
  if (!storedHash) {
    return false;
  }

  return sha256Hex(value) === storedHash || sha256HexRaw(value) === storedHash || sha256HexRaw(toCrLfLineEndings(value)) === storedHash;
}
