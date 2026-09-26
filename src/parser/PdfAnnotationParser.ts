// PdfAnnotationParser.ts
/**
 * Parst/serialisiert PDF-Anmerkungen (Textmarkierungen mit zugehöriger
 * Anmerkungsbox rechts der Seite). Format, analog zu TextBlockParser.ts,
 * aber mit eigenem Marker und zusätzlichen Feldern (Farbe, markierte
 * Rechtecke, Verbindungslinien-Stil). Liegt wie Textblöcke im Dateikörper,
 * NICHT im Frontmatter.
 *
 * <!--pdfcompose-annot id="…" page="…" color="#rrggbb" rects="x,y,w,h;x,y,w,h"
 *      y="0.00" width="220.00" fontScale="100" connector="curve"-->
 * Beliebiger Markdown-Inhalt
 * <!--pdfcompose-annot-end id="…"-->
 */
import { PdfAnnotationMeta } from "../types";

export type ConnectorStyle = "none" | "straight" | "curve" | "step";

/** Ein Rechteck im unskalierten Seiten-Koordinatensystem (PDF-Punkte). */
export interface PdfAnnotationRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface PdfAnnotationEntry {
    id: string;
    pageId: string;
    /** Farbe der Textmarkierung UND des Anmerkungsrahmens. */
    color: string;
    /** Markierte Textstellen (können mehrere Rechtecke umfassen, z. B. über Zeilen hinweg). */
    rects: PdfAnnotationRect[];
    /** Vertikale Position der Anmerkungsbox (unskaliert, Seiten-lokal). Horizontal fix rechts der Seite. */
    y: number;
    /** Breite der Anmerkungsbox (unskaliert). */
    width: number;
    connector: ConnectorStyle;
    /** Prozentualer Skalierungsfaktor des Inhalts, 100 = normal. */
    fontScale: number;
    markdown: string;
}

const BLOCK_REGEX = /<!--pdfcompose-annot id="([^"]+)"-->([\s\S]*?)<!--pdfcompose-annot-end id="\1"-->/g;

export function extractPdfAnnotationContents(content: string): Map<string, string> {
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
    '<!--pdfcompose-annot\\s+id="([^"]+)"\\s+page="([^"]+)"\\s+color="([^"]+)"\\s+rects="([^"]*)"\\s+' +
    'y="([-\\d.]+)"\\s+width="([\\d.]+)"\\s+fontScale="([\\d.]+)"\\s+connector="(none|straight|curve|step)"-->' +
    '\\r?\\n([\\s\\S]*?)<!--pdfcompose-annot-end\\s+id="\\1"-->';

function serializeRects(rects: PdfAnnotationRect[]): string {
    return rects
        .map((r) => `${r.x.toFixed(2)},${r.y.toFixed(2)},${r.width.toFixed(2)},${r.height.toFixed(2)}`)
        .join(";");
}

function parseRects(raw: string): PdfAnnotationRect[] {
    if (!raw.trim()) return [];
    return raw
        .split(";")
        .filter((part) => part.trim().length > 0)
        .map((part) => {
            const [x, y, width, height] = part.split(",").map(Number);
            return { x, y, width, height };
        });
}

export function parsePdfAnnotations(content: string, frontmatter: any): PdfAnnotationEntry[] {
    const metas: PdfAnnotationMeta[] = frontmatter.pdfAnnotations || [];
    const contents = extractPdfAnnotationContents(content);
    const entries: PdfAnnotationEntry[] = [];
    for (const meta of metas) {
        const markdown = contents.get(meta.id) || "";
        entries.push({
            ...meta,
            markdown,
        });
    }
    return entries;
}

export function groupPdfAnnotationsByPage(entries: PdfAnnotationEntry[]): Map<string, PdfAnnotationEntry[]> {
    const map = new Map<string, PdfAnnotationEntry[]>();
    for (const entry of entries) {
        const list = map.get(entry.pageId) || [];
        list.push(entry);
        map.set(entry.pageId, list);
    }
    return map;
}

export function serializePdfAnnotation(entry: PdfAnnotationEntry): string {
    return `<!--pdfcompose-annot id="${entry.id}"-->\n${entry.markdown}\n<!--pdfcompose-annot-end id="${entry.id}"-->`;
}

function blockRegexForId(id: string): RegExp {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
        `<!--pdfcompose-annot\\s+id="${escaped}"[^>]*-->\\r?\\n[\\s\\S]*?<!--pdfcompose-annot-end\\s+id="${escaped}"-->`,
        "g"
    );
}

/** Ersetzt eine vorhandene Anmerkung (per id) oder hängt eine neue ans Dateiende an. */
export function upsertPdfAnnotation(content: string, entry: PdfAnnotationEntry): string {
    const id = entry.id;
    const serialized = serializePdfAnnotation(entry);
    const re = new RegExp(`<!--pdfcompose-annot id="${id}"-->[\\s\\S]*?<!--pdfcompose-annot-end id="${id}"-->`, 'g');
    if (re.test(content)) {
        re.lastIndex = 0;
        return content.replace(re, serialized);
    }
    const separator = content.endsWith("\n") ? "\n" : "\n\n";
    return content + separator + serialized + "\n";
}

export function removePdfAnnotation(content: string, id: string): string {
    const re = new RegExp(`<!--pdfcompose-annot id="${id}"-->[\\s\\S]*?<!--pdfcompose-annot-end id="${id}"-->`, 'g');
    return content.replace(re, "").replace(/\n{3,}/g, "\n\n");
}

/**
 * Extrahiert alle Anmerkungs‑Blöcke (Kommentar + Inhalt) als vollständigen String.
 */
export function extractAllPdfAnnotations(content: string): { id: string; serialized: string }[] {
    const blocks: { id: string; serialized: string }[] = [];
    const re = /<!--pdfcompose-annot id="([^"]+)"-->([\s\S]*?)<!--pdfcompose-annot-end id="\1"-->/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
        blocks.push({ id: match[1], serialized: match[0] });
    }
    return blocks;
}