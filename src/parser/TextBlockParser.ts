/**
 * Parst/serialisiert Textblöcke, die als HTML-Kommentar-Marker direkt im
 * Dateikörper (nicht im Frontmatter) liegen. Format:
 *
 * <!--pdfcompose-text id="…" page="…" x="0.00" y="0.00" width="200.00" fontScale="100"-->
 * Beliebiger Markdown-Inhalt (inkl. Bild-Embeds, Links, …)
 * <!--pdfcompose-text-end id="…"-->
 */

import { TextBlockMeta } from "../types";

export interface TextBlockEntry {
    id: string;
    pageId: string;
    x: number;
    y: number;
    width: number;
    fontScale: number;
    markdown: string;
}

const BLOCK_REGEX = /<!--pdfcompose-text id="([^"]+)"-->([\s\S]*?)<!--pdfcompose-text-end id="\1"-->/g;

export function extractTextBlockContents(content: string): Map<string, string> {
    const map = new Map<string, string>();
    const re = new RegExp(BLOCK_REGEX);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
        const id = match[1];
        const text = match[2].trim();
        map.set(id, text);
    }
    return map;
}

const BLOCK_SOURCE =
    '<!--pdfcompose-text\\s+id="([^"]+)"\\s+page="([^"]+)"\\s+x="([-\\d.]+)"\\s+y="([-\\d.]+)"\\s+width="([\\d.]+)"\\s+fontScale="([\\d.]+)"-->\\r?\\n([\\s\\S]*?)<!--pdfcompose-text-end\\s+id="\\1"-->';

export function parseTextBlocks(content: string, frontmatter: any): TextBlockEntry[] {
    const metas: TextBlockMeta[] = frontmatter.textBlocks || [];
    const contents = extractTextBlockContents(content);
    const entries: TextBlockEntry[] = [];
    for (const meta of metas) {
        const markdown = contents.get(meta.id) || "";
        entries.push({
            ...meta,
            markdown,
        });
    }
    return entries;
}

export function groupTextBlocksByPage(entries: TextBlockEntry[]): Map<string, TextBlockEntry[]> {
    const map = new Map<string, TextBlockEntry[]>();
    for (const entry of entries) {
        const list = map.get(entry.pageId) || [];
        list.push(entry);
        map.set(entry.pageId, list);
    }
    return map;
}

export function serializeTextBlock(entry: TextBlockEntry): string {
    return `<!--pdfcompose-text id="${entry.id}"-->\n${entry.markdown}\n<!--pdfcompose-text-end id="${entry.id}"-->`;
}

function blockRegexForId(id: string): RegExp {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
        `<!--pdfcompose-text\\s+id="${escaped}"[^>]*-->\\r?\\n[\\s\\S]*?<!--pdfcompose-text-end\\s+id="${escaped}"-->`,
        "g"
    );
}

/** Ersetzt einen vorhandenen Block (per id) oder hängt einen neuen ans Dateiende an. */
export function upsertTextBlock(content: string, entry: TextBlockEntry): string {
    const id = entry.id;
    const serialized = serializeTextBlock(entry);
    const re = new RegExp(`<!--pdfcompose-text id="${id}"-->[\\s\\S]*?<!--pdfcompose-text-end id="${id}"-->`, 'g');
    if (re.test(content)) {
        re.lastIndex = 0;
        return content.replace(re, serialized);
    }
    const separator = content.endsWith("\n") ? "\n" : "\n\n";
    return content + separator + serialized + "\n";
}

export function removeTextBlock(content: string, id: string): string {
    const re = new RegExp(`<!--pdfcompose-text id="${id}"-->[\\s\\S]*?<!--pdfcompose-text-end id="${id}"-->`, 'g');
    return content.replace(re, "").replace(/\n{3,}/g, "\n\n");
}

/**
 * Extrahiert alle Textblock‑Blöcke (Kommentar + Inhalt) als vollständigen String.
 * Gibt eine Liste von { id, serialized } zurück, sortiert nach Vorkommen im Body.
 */
export function extractAllTextBlocks(content: string): { id: string; serialized: string }[] {
    const blocks: { id: string; serialized: string }[] = [];
    const re = /<!--pdfcompose-text id="([^"]+)"-->([\s\S]*?)<!--pdfcompose-text-end id="\1"-->/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
        blocks.push({ id: match[1], serialized: match[0] });
    }
    return blocks;
}