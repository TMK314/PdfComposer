// ShapeLabelParser.ts
//
// Parst/serialisiert Beschriftungen von Formen (Rechteck, Ellipse, Dreieck,
// Raute, Polygon, Linie, Pfeil). Wie TextBlockParser: Inhalt liegt als
// HTML-Kommentar im Dateikörper, die stilistischen Metadaten (Schriftgröße,
// Farbe, Mode) im Frontmatter unter "shapeLabels". Der Kommentar verweist
// über die ID auf das jeweilige Vektorobjekt.
//
// <!--pdfcompose-shape-label id="shapeId"-->
// Beschriftungstext
// <!--pdfcompose-shape-label-end id="shapeId"-->

import { ShapeLabelMeta } from "../types";

export interface ShapeLabelEntry {
    id: string;       // == shapeId
    pageId: string;
    shapeId: string;
    fontSize?: number;
    color?: string;
    mode?: "inline" | "box";
    text: string;
}

const BLOCK_REGEX =
    /<!--pdfcompose-shape-label id="([^"]+)"-->([\s\S]*?)<!--pdfcompose-shape-label-end id="\1"-->/g;

export function extractShapeLabelContents(content: string): Map<string, string> {
    const map = new Map<string, string>();
    const re = new RegExp(BLOCK_REGEX);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
        map.set(match[1], match[2].trim());
    }
    return map;
}

export function parseShapeLabels(content: string, frontmatter: any): ShapeLabelEntry[] {
    const metas: ShapeLabelMeta[] = frontmatter.shapeLabels || [];
    const contents = extractShapeLabelContents(content);
    return metas.map((meta) => ({
        ...meta,
        text: contents.get(meta.id) || "",
    }));
}

export function groupShapeLabelsByPage(
    entries: ShapeLabelEntry[]
): Map<string, ShapeLabelEntry[]> {
    const map = new Map<string, ShapeLabelEntry[]>();
    for (const entry of entries) {
        const list = map.get(entry.pageId) || [];
        list.push(entry);
        map.set(entry.pageId, list);
    }
    return map;
}

export function serializeShapeLabel(entry: ShapeLabelEntry): string {
    return `<!--pdfcompose-shape-label id="${entry.id}"-->\n${entry.text}\n<!--pdfcompose-shape-label-end id="${entry.id}"-->`;
}

export function upsertShapeLabel(content: string, entry: ShapeLabelEntry): string {
    const id = entry.id;
    const serialized = serializeShapeLabel(entry);
    const re = new RegExp(
        `<!--pdfcompose-shape-label id="${id}"-->[\\s\\S]*?<!--pdfcompose-shape-label-end id="${id}"-->`,
        "g"
    );
    if (re.test(content)) {
        re.lastIndex = 0;
        return content.replace(re, serialized);
    }
    const sep = content.endsWith("\n") ? "\n" : "\n\n";
    return content + sep + serialized + "\n";
}

export function removeShapeLabel(content: string, id: string): string {
    const re = new RegExp(
        `<!--pdfcompose-shape-label id="${id}"-->[\\s\\S]*?<!--pdfcompose-shape-label-end id="${id}"-->`,
        "g"
    );
    return content.replace(re, "").replace(/\n{3,}/g, "\n\n");
}

export function extractAllShapeLabels(content: string): { id: string; serialized: string }[] {
    const blocks: { id: string; serialized: string }[] = [];
    const re = new RegExp(BLOCK_REGEX);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
        blocks.push({ id: match[1], serialized: match[0] });
    }
    return blocks;
}