export interface ChunkOptions {
  /** Target maximum characters per chunk (~4 chars per token). */
  maxChars?: number;
  /** Characters of trailing context repeated at the start of the next chunk. */
  overlap?: number;
}

/**
 * Splits text into overlapping chunks along paragraph, then sentence, then word
 * boundaries so retrieved passages stay readable.
 */
export function chunkText(text: string, { maxChars = 3200, overlap = 400 }: ChunkOptions = {}): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const pieces = clean.split(/\n\n/).flatMap((p) => splitLong(p, maxChars));
  const chunks: string[] = [];
  let current = "";

  for (const piece of pieces) {
    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    const tail = overlap > 0 && current ? tailAtWordBoundary(current, overlap) : "";
    current = tail && tail.length + piece.length + 2 <= maxChars ? `${tail}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLong(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const sentences = paragraph.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) ?? [paragraph];
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) out.push(current.trim());
      current = "";
      out.push(...splitWords(sentence, maxChars));
      continue;
    }
    if ((current + sentence).length > maxChars) {
      out.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function splitWords(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (word.length > maxChars) {
      if (current) out.push(current);
      for (let i = 0; i < word.length; i += maxChars) out.push(word.slice(i, i + maxChars));
      current = "";
    } else if ((current ? current.length + 1 : 0) + word.length > maxChars) {
      out.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) out.push(current);
  return out;
}

function tailAtWordBoundary(text: string, size: number): string {
  if (text.length <= size) return text;
  const tail = text.slice(-size);
  const firstSpace = tail.indexOf(" ");
  return firstSpace === -1 ? tail : tail.slice(firstSpace + 1);
}
