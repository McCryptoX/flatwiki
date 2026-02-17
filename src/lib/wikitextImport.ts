interface WikitextImportStats {
  sourceLines: number;
  markdownLines: number;
  convertedHeadings: number;
  convertedLists: number;
  convertedTables: number;
  convertedCodeBlocks: number;
  convertedImageLinks: number;
  convertedExternalLinks: number;
  normalizedInternalLinks: number;
}

export interface WikitextConversionResult {
  markdown: string;
  detectedTitle: string;
  warnings: string[];
  stats: WikitextImportStats;
}

const IMAGE_OPTION_WORDS = new Set([
  "mini",
  "thumb",
  "thumbnail",
  "frameless",
  "frame",
  "border",
  "right",
  "left",
  "center",
  "none"
]);

const trimBom = (value: string): string => value.replace(/^\uFEFF/, "");

const normalizeLineEndings = (value: string): string => value.replace(/\r\n?/g, "\n");

const isLikelyImageOption = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (IMAGE_OPTION_WORDS.has(normalized)) return true;
  if (/^\d+\s*px$/.test(normalized)) return true;
  if (/^upright(?:=|$)/.test(normalized)) return true;
  if (/^(link|lang|class|page|border|baseline|sub|super)\s*=/.test(normalized)) return true;
  return false;
};

const normalizeImageFileName = (input: string): string => {
  const stripped = input
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    ?.trim() ?? "";

  return stripped.replace(/\s+/g, "_");
};

const fallbackAltFromFileName = (fileName: string): string => {
  const withoutExt = fileName.replace(/\.[a-z0-9]+$/i, "");
  const cleaned = withoutExt.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "Bild";
};

const escapeTableCell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

const stripWikiAttributesPrefix = (value: string): string => {
  const trimmed = value.trim();
  const pipeIndex = trimmed.indexOf("|");
  if (pipeIndex < 0) return trimmed;

  const prefix = trimmed.slice(0, pipeIndex).trim();
  if (/^(?:class|style|align|valign|width|rowspan|colspan|scope)\b/i.test(prefix) || prefix.includes("=")) {
    return trimmed.slice(pipeIndex + 1).trim();
  }

  return trimmed;
};

const parseSyntaxLang = (startTag: string): string => {
  const attrMatch = startTag.match(/<syntaxhighlight\b([^>]*)>/i);
  const attrs = attrMatch?.[1] ?? "";
  const langMatch = attrs.match(/lang\s*=\s*["']?([a-z0-9_+-]+)/i);
  if (langMatch?.[1]) return langMatch[1].toLowerCase();

  const fallbackQuoted = attrs.match(/["']([a-z0-9_+-]+)["']/i);
  if (fallbackQuoted?.[1]) return fallbackQuoted[1].toLowerCase();

  return "";
};

const normalizeInlineWikitext = (
  input: string,
  stats: WikitextImportStats,
  warnings: string[]
): string => {
  let value = input;

  value = value.replace(/<span\b[^>]*>([\s\S]*?)<\/span>/gi, "$1");
  value = value.replace(/<\/?span\b[^>]*>/gi, "");

  value = value.replace(/<code>([\s\S]*?)<\/code>/gi, (_full, body: string) => {
    const normalizedBody = String(body ?? "").replace(/`+/g, "'").trim();
    return normalizedBody ? `\`${normalizedBody}\`` : "``";
  });

  value = value.replace(/\[\[(?:Datei|File):([^\]]+)\]\]/gi, (_full, rawBody: string) => {
    const parts = String(rawBody)
      .split("|")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    const rawFileName = parts.shift() ?? "";
    const fileName = normalizeImageFileName(rawFileName);

    if (!fileName) {
      warnings.push("Ein Datei-Link ohne Dateinamen wurde uebersprungen.");
      return "";
    }

    let alt = "";
    for (const part of parts) {
      const normalized = part.trim();
      const altMatch = normalized.match(/^alt\s*=\s*(.+)$/i);
      if (altMatch?.[1]) {
        alt = altMatch[1].trim();
        continue;
      }

      if (!isLikelyImageOption(normalized)) {
        alt = normalized;
      }
    }

    const safeAlt = (alt || fallbackAltFromFileName(fileName)).replace(/[\r\n]+/g, " ").trim();
    const imagePath = `/uploads/${encodeURIComponent(fileName)}`;
    stats.convertedImageLinks += 1;
    return `![${safeAlt}](${imagePath})`;
  });

  value = value.replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/gi, (_full, rawUrl: string, rawLabel: string) => {
    const url = rawUrl.trim();
    const label = rawLabel.trim();
    if (!url || !label) return _full;
    stats.convertedExternalLinks += 1;
    return `[${label}](${url})`;
  });

  value = value.replace(/\[(https?:\/\/[^\s\]]+)\]/gi, (_full, rawUrl: string) => {
    const url = rawUrl.trim();
    if (!url) return _full;
    stats.convertedExternalLinks += 1;
    return `<${url}>`;
  });

  value = value.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_full, rawTarget: string, rawLabel?: string) => {
    const target = String(rawTarget ?? "").trim();
    if (!target || /^(datei|file):/i.test(target)) {
      return _full;
    }

    let cleanTarget = target;
    const hashPos = cleanTarget.indexOf("#");
    if (hashPos >= 0) {
      cleanTarget = cleanTarget.slice(0, hashPos);
    }
    cleanTarget = cleanTarget.replace(/_/g, " ").trim();
    if (!cleanTarget) return String(rawLabel ?? "").trim() || "";

    const label = String(rawLabel ?? "").trim();
    stats.normalizedInternalLinks += 1;
    return label ? `[[${cleanTarget}|${label}]]` : `[[${cleanTarget}]]`;
  });

  value = value.replace(/'''''([^\n]+?)'''''/g, "***$1***");
  value = value.replace(/'''([^\n]+?)'''/g, "**$1**");
  value = value.replace(/''([^\n]+?)''/g, "*$1*");

  return value;
};

const convertListLine = (line: string, stats: WikitextImportStats, warnings: string[]): string | null => {
  const bulletMatch = line.match(/^(\*+)\s*(.*)$/);
  if (bulletMatch?.[1]) {
    const depth = Math.max(1, bulletMatch[1].length);
    const content = normalizeInlineWikitext(bulletMatch[2] ?? "", stats, warnings);
    stats.convertedLists += 1;
    return `${"  ".repeat(depth - 1)}- ${content}`;
  }

  const orderedMatch = line.match(/^(#+)\s*(.*)$/);
  if (orderedMatch?.[1]) {
    const depth = Math.max(1, orderedMatch[1].length);
    const content = normalizeInlineWikitext(orderedMatch[2] ?? "", stats, warnings);
    stats.convertedLists += 1;
    return `${"  ".repeat(depth - 1)}1. ${content}`;
  }

  return null;
};

const splitTableCells = (rawLine: string, delimiter: "!!" | "||", stats: WikitextImportStats, warnings: string[]): string[] => {
  return rawLine.split(delimiter).map((segment) => {
    let cell = segment.trim();
    const pipeIndex = cell.indexOf("|");
    if (pipeIndex >= 0) {
      const prefix = cell.slice(0, pipeIndex).trim();
      if (/^(?:style|class|align|valign|width|rowspan|colspan|scope)\b/i.test(prefix) || prefix.includes("=")) {
        cell = cell.slice(pipeIndex + 1).trim();
      }
    }

    return normalizeInlineWikitext(cell, stats, warnings);
  });
};

interface ParsedTableRow {
  header: boolean;
  cells: string[];
}

const convertTableBlock = (blockLines: string[], stats: WikitextImportStats, warnings: string[]): string => {
  const lines = [...blockLines];
  const hasClosingTag = lines[lines.length - 1]?.trim().startsWith("|}") ?? false;
  if (!hasClosingTag) {
    warnings.push("Eine Tabelle war nicht mit |} abgeschlossen und wurde bestmoeglich konvertiert.");
  }

  const bodyLines = hasClosingTag ? lines.slice(1, -1) : lines.slice(1);
  const rows: ParsedTableRow[] = [];
  let caption = "";
  let activeRow: ParsedTableRow | null = null;

  const flushRow = (): void => {
    if (!activeRow || activeRow.cells.length < 1) {
      activeRow = null;
      return;
    }

    rows.push(activeRow);
    activeRow = null;
  };

  for (const rawLine of bodyLines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("|+")) {
      const rawCaption = stripWikiAttributesPrefix(line.slice(2).trim());
      caption = normalizeInlineWikitext(rawCaption, stats, warnings);
      continue;
    }

    if (line.startsWith("|-")) {
      flushRow();
      continue;
    }

    if (line.startsWith("!")) {
      const cells = splitTableCells(line.slice(1).trim(), "!!", stats, warnings);
      if (!activeRow || !activeRow.header) {
        flushRow();
        activeRow = { header: true, cells: [] };
      }
      activeRow.cells.push(...cells);
      continue;
    }

    if (line.startsWith("|")) {
      const cells = splitTableCells(line.slice(1).trim(), "||", stats, warnings);
      if (!activeRow) {
        flushRow();
        activeRow = { header: false, cells: [] };
      } else if (activeRow.header) {
        activeRow.header = false;
      }
      activeRow.cells.push(...cells);
      continue;
    }
  }

  flushRow();

  if (rows.length < 1) {
    return lines.join("\n");
  }

  const firstHeaderIndex = rows.findIndex((row) => row.header);
  const maxColumns = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);

  const padCells = (cells: string[]): string[] => {
    const next = [...cells];
    while (next.length < maxColumns) {
      next.push("");
    }
    return next;
  };

  const headerCells =
    firstHeaderIndex >= 0
      ? padCells(rows[firstHeaderIndex]?.cells ?? [])
      : Array.from({ length: maxColumns }, (_unused, index) => `Spalte ${index + 1}`);

  const bodyRows = rows.filter((_row, index) => index !== firstHeaderIndex).map((row) => padCells(row.cells));

  const markdownLines: string[] = [];
  if (caption) {
    markdownLines.push(`**${caption}**`);
    markdownLines.push("");
  }

  markdownLines.push(`| ${headerCells.map(escapeTableCell).join(" | ")} |`);
  markdownLines.push(`| ${Array.from({ length: maxColumns }, () => "---").join(" | ")} |`);
  for (const row of bodyRows) {
    markdownLines.push(`| ${row.map(escapeTableCell).join(" | ")} |`);
  }

  stats.convertedTables += 1;
  return markdownLines.join("\n");
};

const convertSyntaxHighlightBlocks = (
  sourceLines: string[],
  stats: WikitextImportStats,
  warnings: string[]
): string[] => {
  const output: string[] = [];

  for (let i = 0; i < sourceLines.length; i += 1) {
    const line = sourceLines[i] ?? "";
    const startMatch = line.match(/<syntaxhighlight\b[^>]*>/i);

    if (!startMatch) {
      if (/<\/syntaxhighlight>/i.test(line)) {
        warnings.push(`Ein isoliertes </syntaxhighlight> wurde entfernt (Zeile ${i + 1}).`);
        output.push(line.replace(/<\/syntaxhighlight>/gi, "").trimEnd());
      } else {
        output.push(line);
      }
      continue;
    }

    const startTag = startMatch[0];
    const lang = parseSyntaxLang(startTag);
    const codeLines: string[] = [];

    const startIndex = line.indexOf(startTag);
    const afterStart = startIndex >= 0 ? line.slice(startIndex + startTag.length) : "";
    const inlineCloseIndex = afterStart.toLowerCase().indexOf("</syntaxhighlight>");

    if (inlineCloseIndex >= 0) {
      codeLines.push(afterStart.slice(0, inlineCloseIndex));
    } else {
      if (afterStart.length > 0) {
        codeLines.push(afterStart);
      }

      let closed = false;
      for (let j = i + 1; j < sourceLines.length; j += 1) {
        const candidate = sourceLines[j] ?? "";
        const closeIndex = candidate.toLowerCase().indexOf("</syntaxhighlight>");
        if (closeIndex >= 0) {
          codeLines.push(candidate.slice(0, closeIndex));
          i = j;
          closed = true;
          break;
        }
        codeLines.push(candidate);
      }

      if (!closed) {
        warnings.push(`Ein <syntaxhighlight>-Block ab Zeile ${i + 1} war nicht sauber geschlossen.`);
        i = sourceLines.length;
      }
    }

    const fence = lang ? `\`\`\`${lang}` : "```";
    output.push(fence);
    output.push(...codeLines);
    output.push("```");
    stats.convertedCodeBlocks += 1;
  }

  return output;
};

const convertTableBlocks = (sourceLines: string[], stats: WikitextImportStats, warnings: string[]): string[] => {
  const output: string[] = [];

  for (let i = 0; i < sourceLines.length; i += 1) {
    const line = sourceLines[i] ?? "";
    if (!line.trim().startsWith("{|")) {
      output.push(line);
      continue;
    }

    const blockLines: string[] = [line];
    let closed = false;

    for (let j = i + 1; j < sourceLines.length; j += 1) {
      const candidate = sourceLines[j] ?? "";
      blockLines.push(candidate);
      if (candidate.trim().startsWith("|}")) {
        closed = true;
        i = j;
        break;
      }
    }

    if (!closed) {
      warnings.push(`Eine Tabelle ab Zeile ${i + 1} war nicht sauber geschlossen.`);
      i = sourceLines.length;
    }

    output.push(convertTableBlock(blockLines, stats, warnings));
  }

  return output;
};

const compactBlankLines = (lines: string[]): string[] => {
  const output: string[] = [];
  let previousBlank = true;

  for (const line of lines) {
    const blank = line.trim().length === 0;
    if (blank) {
      if (!previousBlank) {
        output.push("");
      }
    } else {
      output.push(line);
    }
    previousBlank = blank;
  }

  while (output.length > 0 && output[0]?.trim() === "") {
    output.shift();
  }

  while (output.length > 0 && output[output.length - 1]?.trim() === "") {
    output.pop();
  }

  return output;
};

export const convertWikitextToMarkdown = (source: string): WikitextConversionResult => {
  const normalizedSource = normalizeLineEndings(trimBom(String(source ?? "")));
  const originalLines = normalizedSource.split("\n");

  const stats: WikitextImportStats = {
    sourceLines: originalLines.length,
    markdownLines: 0,
    convertedHeadings: 0,
    convertedLists: 0,
    convertedTables: 0,
    convertedCodeBlocks: 0,
    convertedImageLinks: 0,
    convertedExternalLinks: 0,
    normalizedInternalLinks: 0
  };

  const warnings: string[] = [];
  let detectedTitle = "";

  const withCodeBlocks = convertSyntaxHighlightBlocks(originalLines, stats, warnings);
  const withTables = convertTableBlocks(withCodeBlocks, stats, warnings);

  const convertedLines: string[] = [];
  let inCodeFence = false;
  let inCollapsibleWrapper = false;

  for (const rawLine of withTables) {
    const line = rawLine ?? "";

    if (/^```/.test(line.trim())) {
      inCodeFence = !inCodeFence;
      convertedLines.push(line);
      continue;
    }

    if (inCodeFence) {
      convertedLines.push(line);
      continue;
    }

    if (/^\s*<ul\b[^>]*\bmw-collapsible\b[^>]*>\s*$/i.test(line)) {
      inCollapsibleWrapper = true;
      continue;
    }

    if (inCollapsibleWrapper && /^\s*<li>\s*$/i.test(line)) {
      continue;
    }

    if (inCollapsibleWrapper && /^\s*<\/li>\s*$/i.test(line)) {
      continue;
    }

    if (inCollapsibleWrapper && /^\s*<\/ul>\s*$/i.test(line)) {
      inCollapsibleWrapper = false;
      continue;
    }

    const headingMatch = line.match(/^(={1,6})\s*(.*?)\s*\1\s*$/);
    if (headingMatch?.[1]) {
      const depth = Math.min(headingMatch[1].length, 6);
      const headingText = normalizeInlineWikitext(headingMatch[2] ?? "", stats, warnings).trim();
      if (depth === 1 && !detectedTitle) {
        detectedTitle = headingText;
      }
      convertedLines.push(`${"#".repeat(depth)} ${headingText}`.trim());
      stats.convertedHeadings += 1;
      continue;
    }

    const listLine = convertListLine(line, stats, warnings);
    if (listLine !== null) {
      convertedLines.push(listLine);
      continue;
    }

    convertedLines.push(normalizeInlineWikitext(line, stats, warnings));
  }

  const compactedLines = compactBlankLines(convertedLines);
  const markdown = `${compactedLines.join("\n").trim()}\n`;
  stats.markdownLines = markdown === "\n" ? 0 : markdown.split("\n").length;

  return {
    markdown,
    detectedTitle,
    warnings: [...new Set(warnings)],
    stats
  };
};
