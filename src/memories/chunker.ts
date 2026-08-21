export interface Chunk {
  index: number;
  content: string;
}

export interface ChunkerOptions {
  maxChars?: number;
  overlapChars?: number;
}

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 200;

const HEADING_PATTERN = /^#{1,6}\s+\S/;
const SENTENCE_PATTERN = /[^.!?\n]+[.!?]*["')\]]*\s*/g;

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function splitSections(text: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const joined = current.join("\n").trim();
    if (joined.length > 0) sections.push(joined);
    current = [];
  };

  for (const line of text.split("\n")) {
    if (HEADING_PATTERN.test(line)) {
      flush();
    }
    current.push(line);
  }
  flush();
  return sections;
}

function splitParagraphs(section: string): string[] {
  return section
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function splitSentences(paragraph: string): string[] {
  const matches = paragraph.match(SENTENCE_PATTERN);
  if (!matches) return [paragraph];
  const sentences = matches.map((sentence) => sentence.trim()).filter((s) =>
    s.length > 0
  );
  return sentences.length > 0 ? sentences : [paragraph];
}

function hardSplit(
  text: string,
  maxChars: number,
  overlapChars: number,
): string[] {
  const pieces: string[] = [];
  const step = Math.max(1, maxChars - overlapChars);
  for (let start = 0; start < text.length; start += step) {
    pieces.push(text.slice(start, start + maxChars).trim());
    if (start + maxChars >= text.length) break;
  }
  return pieces.filter((piece) => piece.length > 0);
}

function overlapTail(content: string, overlapChars: number): string {
  if (overlapChars <= 0 || content.length <= overlapChars) return "";
  let start = content.length - overlapChars;
  const spaceIndex = content.indexOf(" ", start);
  if (spaceIndex >= 0 && spaceIndex < content.length - 1) {
    start = spaceIndex + 1;
  }
  return content.slice(start).trim();
}

export function chunkText(text: string, options: ChunkerOptions = {}): Chunk[] {
  const maxChars = Math.max(64, options.maxChars ?? DEFAULT_MAX_CHARS);
  const overlapChars = Math.min(
    Math.max(0, options.overlapChars ?? DEFAULT_OVERLAP_CHARS),
    Math.floor(maxChars / 2),
  );

  const normalized = normalize(text);
  if (normalized.length === 0) return [];

  const chunks: string[] = [];
  let buffer = "";

  const flushBuffer = () => {
    const content = buffer.trim();
    if (content.length === 0) {
      buffer = "";
      return;
    }
    chunks.push(content);
    const tail = overlapTail(content, overlapChars);
    buffer = tail.length > 0 ? tail : "";
  };

  const appendUnit = (unit: string) => {
    if (unit.length > maxChars) {
      flushBuffer();
      for (const piece of hardSplit(unit, maxChars, overlapChars)) {
        chunks.push(piece);
      }
      buffer = "";
      return;
    }
    if (buffer.length > 0 && buffer.length + unit.length + 1 > maxChars) {
      flushBuffer();
    }
    buffer = buffer.length === 0 ? unit : `${buffer} ${unit}`;
  };

  for (const section of splitSections(normalized)) {
    for (const paragraph of splitParagraphs(section)) {
      if (paragraph.length > maxChars) {
        for (const sentence of splitSentences(paragraph)) appendUnit(sentence);
      } else {
        appendUnit(paragraph);
      }
    }
  }
  flushBuffer();

  return chunks.map((content, index) => ({ index, content }));
}
