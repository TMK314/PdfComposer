// OcrBlockParser.ts
//
// Parst/serialisiert OCR-Ergebnisse für per Stift geschriebene Wörter.
// Liegt wie Textblöcke/Anmerkungen im Dateikörper, NICHT im Frontmatter.
// Zwei Teile pro Seite:
//  - Ein eingeklappter Obsidian-Callout mit dem erkannten Klartext (normale
//    Obsidian-Volltextsuche funktioniert dadurch ohne Zusatzaufwand).
//  - Ein HTML-Kommentar mit den komprimierten Wort-Bounding-Boxen (für die
//    Suche innerhalb der PDF-Compose-Ansicht).
//
// <!--pdfcompose-ocr id="…" page="…" hash="…" data="…"-->
// > [!ocr]- OCR-Text (automatisch erkannt)
// > wort1 wort2 wort3 …
// <!--pdfcompose-ocr-end id="…"-->
//
// Hinweis: Der Callout-Typ "ocr" ist kein von Obsidian mitgelieferter Typ,
// wird aber trotzdem korrekt (mit Standard-Icon) gerendert und ist wie jeder
// andere Callout einklappbar ("-" nach dem Typ). Optional lässt sich per CSS
// (.callout[data-callout="ocr"]) ein eigenes Icon/eine eigene Farbe vergeben.

import { OcrMeta } from "../types";
import { compressText, decompressText } from "../pdf/VectorCompression";

export interface OcrWordEntry {
    text: string;
    /** Erkennungs-Konfidenz, 0..1. */
    confidence: number;
    /** Unskalierte PDF-Punkt-Koordinaten, seiten-lokal (wie PdfAnnotationRect). */
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface OcrBlockEntry {
    id: string;
    pageId: string;
    /** Hash der Strichdaten zum Erkennungszeitpunkt (Änderungserkennung, siehe OcrController.computeStrokeHash). */
    hash: string;
    words: OcrWordEntry[];
}

const BLOCK_REGEX = /<!--pdfcompose-ocr id="([^"]+)"-->([\s\S]*?)<!--pdfcompose-ocr-end id="\1"-->/g;

export function extractOcrBlockContents(content: string): Map<string, string> {
    const map = new Map<string, string>();
    const re = new RegExp(BLOCK_REGEX);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
        const id = match[1];
        const body = match[2].trim();
        map.set(id, body);
    }
    return map;
}

const BLOCK_SOURCE =
    '<!--pdfcompose-ocr\\s+id="([^"]+)"\\s+page="([^"]+)"\\s+hash="([^"]*)"\\s+data="([^"]*)"-->' +
    '\\r?\\n([\\s\\S]*?)<!--pdfcompose-ocr-end\\s+id="\\1"-->';

export function parseOcrBlocks(content: string, frontmatter: any): OcrBlockEntry[] {
    const metas: OcrMeta[] = frontmatter.ocrBlocks || [];
    // Body-Inhalte werden für die Anzeige nicht benötigt, da der Callout automatisch generiert wird.
    // Wir geben trotzdem die Metadaten zurück.
    return metas.map(meta => ({
        id: meta.id,
        pageId: meta.pageId,
        hash: meta.hash,
        words: meta.words,
    }));
}

export function groupOcrBlocksByPage(entries: OcrBlockEntry[]): Map<string, OcrBlockEntry[]> {
    const map = new Map<string, OcrBlockEntry[]>();
    for (const entry of entries) {
        const list = map.get(entry.pageId) || [];
        list.push(entry);
        map.set(entry.pageId, list);
    }
    return map;
}

function buildVisibleText(words: OcrWordEntry[]): string {
    if (words.length === 0) return "*(no strokes recognized)*";
    return words.map(w => w.text).join(" ");
}

export function serializeOcrBlock(entry: OcrBlockEntry): string {
    const visible = buildVisibleText(entry.words);
    const calloutBody = visible
        .split("\n")
        .map(line => `> ${line}`)
        .join("\n");
    return `<!--pdfcompose-ocr id="${entry.id}"-->\n> [!ocr]- OCR text (automatically recognized)\n${calloutBody}\n<!--pdfcompose-ocr-end id="${entry.id}"-->`;
}

function blockRegexForId(id: string): RegExp {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
        `<!--pdfcompose-ocr\\s+id="${escaped}"[^>]*-->\\r?\\n[\\s\\S]*?<!--pdfcompose-ocr-end\\s+id="${escaped}"-->`,
        "g"
    );
}

/** Ersetzt ein vorhandenes OCR-Ergebnis (per id) oder hängt ein neues ans Dateiende an. */
export function upsertOcrBlock(content: string, entry: OcrBlockEntry): string {
    const id = entry.id;
    const serialized = serializeOcrBlock(entry);
    const re = new RegExp(`<!--pdfcompose-ocr id="${id}"-->[\\s\\S]*?<!--pdfcompose-ocr-end id="${id}"-->`, 'g');
    if (re.test(content)) {
        re.lastIndex = 0;
        return content.replace(re, serialized);
    }
    const separator = content.endsWith("\n") ? "\n" : "\n\n";
    return content + separator + serialized + "\n";
}

export function removeOcrBlock(content: string, id: string): string {
    const re = new RegExp(`<!--pdfcompose-ocr id="${id}"-->[\\s\\S]*?<!--pdfcompose-ocr-end id="${id}"-->`, 'g');
    return content.replace(re, "").replace(/\n{3,}/g, "\n\n");
}

/** Findet den vorhandenen OCR-Block einer Seite (es wird immer genau einer je Seite gepflegt). */
export function findOcrBlockForPage(entries: OcrBlockEntry[], pageId: string): OcrBlockEntry | undefined {
    return entries.find(e => e.pageId === pageId);
}

/**
 * Extrahiert alle OCR‑Blöcke (Kommentar + Callout) als vollständigen String.
 */
export function extractAllOcrBlocks(content: string): { id: string; serialized: string }[] {
    const blocks: { id: string; serialized: string }[] = [];
    const re = /<!--pdfcompose-ocr id="([^"]+)"-->([\s\S]*?)<!--pdfcompose-ocr-end id="\1"-->/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
        blocks.push({ id: match[1], serialized: match[0] });
    }
    return blocks;
}