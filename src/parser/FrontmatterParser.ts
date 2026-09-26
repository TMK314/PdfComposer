import { CachedMetadata } from "obsidian";
import {
    CURRENT_PDFCOMPOSE_VERSION,
    DocumentSources,
    PageDefinition,
    PdfComposeDocument,
    BuiltinTemplateId,
    ColorMode,
    TextBlockMeta,
    PdfAnnotationMeta,
    OcrMeta,
} from "../types";
import { decompressText } from "../pdf/VectorCompression";

/** Wird geworfen, wenn das Frontmatter nicht dem erwarteten Schema entspricht. */
export class FrontmatterParseError extends Error { }

/**
 * Prüft, ob eine Datei anhand ihres gecachten Frontmatters ein
 * PDF-Compose-Dokument ist.
 */
export function isPdfComposeFile(cache: CachedMetadata | null): boolean {
    return cache?.frontmatter?.pdfcompose === true;
}

/**
 * Parst und validiert das Frontmatter einer Datei zu einem PdfComposeDocument.
 * Wirft FrontmatterParseError bei strukturellen Problemen, statt still
 * falsche Daten zurückzugeben.
 */
export function parseFrontmatter(cache: CachedMetadata | null): PdfComposeDocument {
    const frontmatter = cache?.frontmatter;
    if (!frontmatter || frontmatter.pdfcompose !== true) {
        throw new FrontmatterParseError('Frontmatter enthält kein "pdfcompose: true".');
    }

    const sources = parseSources(frontmatter.sources);
    const pages = parsePages(frontmatter.pages, sources);
    const annotations = parseAnnotations(frontmatter.annotations);
    const version = typeof frontmatter.version === "number" ? frontmatter.version : CURRENT_PDFCOMPOSE_VERSION;
    const colorMode = parseColorMode(frontmatter.colorMode);

    const textBlocks = decompressMetaArray(frontmatter.textBlocks);
    const pdfAnnotations = decompressMetaArray(frontmatter.pdfAnnotations);
    const ocrBlocks = decompressMetaArray(frontmatter.ocrBlocks);
    const savePdfText = frontmatter.savePdfText === true;
    const shapeLabels = decompressMetaArray(frontmatter.shapeLabels);

    return { version, sources, pages, annotations, colorMode, textBlocks, pdfAnnotations, ocrBlocks, shapeLabels, savePdfText };
}

function parseTextBlocksMeta(raw: unknown): TextBlockMeta[] | undefined {
    if (!raw) return undefined;
    if (!Array.isArray(raw)) {
        throw new FrontmatterParseError('"textBlocks" muss ein Array sein.');
    }
    return raw.map((item, idx) => {
        if (typeof item !== "object" || item === null) {
            throw new FrontmatterParseError(`textBlocks[${idx}] ist kein Objekt.`);
        }
        const { id, pageId, x, y, width, fontScale } = item as any;
        if (typeof id !== "string" || !id) throw new FrontmatterParseError(`textBlocks[${idx}].id fehlt oder ist kein String.`);
        if (typeof pageId !== "string" || !pageId) throw new FrontmatterParseError(`textBlocks[${idx}].pageId fehlt.`);
        if (typeof x !== "number") throw new FrontmatterParseError(`textBlocks[${idx}].x muss eine Zahl sein.`);
        if (typeof y !== "number") throw new FrontmatterParseError(`textBlocks[${idx}].y muss eine Zahl sein.`);
        if (typeof width !== "number") throw new FrontmatterParseError(`textBlocks[${idx}].width muss eine Zahl sein.`);
        if (typeof fontScale !== "number") throw new FrontmatterParseError(`textBlocks[${idx}].fontScale muss eine Zahl sein.`);
        return { id, pageId, x, y, width, fontScale };
    });
}

function parsePdfAnnotationsMeta(raw: unknown): PdfAnnotationMeta[] | undefined {
    if (!raw) return undefined;
    if (!Array.isArray(raw)) {
        throw new FrontmatterParseError('"pdfAnnotations" muss ein Array sein.');
    }
    return raw.map((item, idx) => {
        if (typeof item !== "object" || item === null) {
            throw new FrontmatterParseError(`pdfAnnotations[${idx}] ist kein Objekt.`);
        }
        const { id, pageId, color, rects, y, width, connector, fontScale } = item as any;
        if (typeof id !== "string" || !id) throw new FrontmatterParseError(`pdfAnnotations[${idx}].id fehlt.`);
        if (typeof pageId !== "string" || !pageId) throw new FrontmatterParseError(`pdfAnnotations[${idx}].pageId fehlt.`);
        if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) {
            throw new FrontmatterParseError(`pdfAnnotations[${idx}].color muss ein Hex-String sein.`);
        }
        if (!Array.isArray(rects)) throw new FrontmatterParseError(`pdfAnnotations[${idx}].rects muss ein Array sein.`);
        const parsedRects = rects.map((r: any, ri: number) => {
            if (typeof r.x !== "number" || typeof r.y !== "number" || typeof r.width !== "number" || typeof r.height !== "number") {
                throw new FrontmatterParseError(`pdfAnnotations[${idx}].rects[${ri}] ungültig.`);
            }
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        if (typeof y !== "number") throw new FrontmatterParseError(`pdfAnnotations[${idx}].y muss eine Zahl sein.`);
        if (typeof width !== "number") throw new FrontmatterParseError(`pdfAnnotations[${idx}].width muss eine Zahl sein.`);
        if (!["none", "straight", "curve", "step"].includes(connector)) {
            throw new FrontmatterParseError(`pdfAnnotations[${idx}].connector ungültig.`);
        }
        if (typeof fontScale !== "number") throw new FrontmatterParseError(`pdfAnnotations[${idx}].fontScale muss eine Zahl sein.`);
        return { id, pageId, color, rects: parsedRects, y, width, connector, fontScale };
    });
}

function parseOcrBlocksMeta(raw: unknown): OcrMeta[] | undefined {
    if (!raw) return undefined;
    if (!Array.isArray(raw)) {
        throw new FrontmatterParseError('"ocrBlocks" muss ein Array sein.');
    }
    return raw.map((item, idx) => {
        if (typeof item !== "object" || item === null) {
            throw new FrontmatterParseError(`ocrBlocks[${idx}] ist kein Objekt.`);
        }
        const { id, pageId, hash, words } = item as any;
        if (typeof id !== "string" || !id) throw new FrontmatterParseError(`ocrBlocks[${idx}].id fehlt.`);
        if (typeof pageId !== "string" || !pageId) throw new FrontmatterParseError(`ocrBlocks[${idx}].pageId fehlt.`);
        if (typeof hash !== "string") throw new FrontmatterParseError(`ocrBlocks[${idx}].hash fehlt.`);
        if (!Array.isArray(words)) throw new FrontmatterParseError(`ocrBlocks[${idx}].words muss ein Array sein.`);
        const parsedWords = words.map((w: any, wi: number) => {
            if (typeof w.text !== "string") throw new FrontmatterParseError(`ocrBlocks[${idx}].words[${wi}].text fehlt.`);
            if (typeof w.confidence !== "number") throw new FrontmatterParseError(`ocrBlocks[${idx}].words[${wi}].confidence fehlt.`);
            if (typeof w.x !== "number" || typeof w.y !== "number" || typeof w.width !== "number" || typeof w.height !== "number") {
                throw new FrontmatterParseError(`ocrBlocks[${idx}].words[${wi}].x/y/width/height müssen Zahlen sein.`);
            }
            return { text: w.text, confidence: w.confidence, x: w.x, y: w.y, width: w.width, height: w.height };
        });
        return { id, pageId, hash, words: parsedWords };
    });
}

function parseColorMode(raw: unknown): ColorMode {
    if (raw === "light" || raw === "dark" || raw === "original") return raw;
    return "original";
}

function parseSources(raw: unknown): DocumentSources {
    if (raw === undefined || raw === null) {
        return {};
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new FrontmatterParseError('"sources" muss ein Objekt aus Name -> Pfad sein.');
    }

    const sources: DocumentSources = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== "string" || value.trim().length === 0) {
            throw new FrontmatterParseError(`Quelle "${key}" muss ein nicht-leerer Pfad-String sein.`);
        }
        sources[key] = value;
    }
    return sources;
}

function parseAnnotations(raw: unknown): Record<string, string[]> {
    if (raw === undefined || raw === null) {
        return {};
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new FrontmatterParseError(
            '"annotations" muss ein Objekt aus Seiten-ID -> komprimierten Vektordaten sein.'
        );
    }

    const annotations: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "string") {
            // Altformat: ein einzelner komprimierter Blob mit allen
            // Objekten der Seite. Als Einzelelement-Array übernehmen –
            // decodeAnnotations() kann das weiterhin lesen.
            annotations[key] = [value];
        } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
            annotations[key] = value as string[];
        } else {
            throw new FrontmatterParseError(
                `Annotation für Seite "${key}" muss ein String oder eine Liste von Strings sein.`
            );
        }
    }
    return annotations;
}

function parsePages(raw: unknown, sources: DocumentSources): PageDefinition[] {
    if (!Array.isArray(raw)) {
        throw new FrontmatterParseError('"pages" muss eine Liste von Seiten-Definitionen sein.');
    }

    return raw.map((entry, index) => parseSinglePage(entry, index, sources));
}

function parseSinglePage(
    entry: unknown,
    index: number,
    sources: DocumentSources
): PageDefinition {
    if (typeof entry !== "object" || entry === null) {
        throw new FrontmatterParseError(`Seite an Index ${index} ist kein gültiges Objekt.`);
    }
    const raw = entry as Record<string, unknown>;

    if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
        throw new FrontmatterParseError(
            `Seite an Index ${index} benötigt ein nicht-leeres "id"-Feld.`
        );
    }

    const type = raw.type === undefined ? "pdf" : raw.type;

    if (type === "blank") {
        return {
            id: raw.id,
            type: "blank",
            template: parseBlankTemplate(raw.template),
            size: parseBlankSize(raw.size),
            invert: raw.invert === true ? true : undefined,
        };
    }

    if (type === "pdf") {
        if (typeof raw.src !== "string" || !(raw.src in sources)) {
            throw new FrontmatterParseError(
                `Seite "${raw.id}" referenziert unbekannte Quelle "${String(raw.src)}". ` +
                `Verfügbare Quellen: ${Object.keys(sources).join(", ") || "(keine)"}`
            );
        }
        if (typeof raw.srcPage !== "number" || raw.srcPage < 1) {
            throw new FrontmatterParseError(
                `Seite "${raw.id}" benötigt eine positive Ganzzahl in "srcPage".`
            );
        }
        const rotate = parseRotation(raw.rotate);

        return {
            id: raw.id,
            type: "pdf",
            src: raw.src,
            srcPage: raw.srcPage,
            rotate,
            invert: raw.invert === true ? true : undefined,
        };
    }

    throw new FrontmatterParseError(`Seite "${raw.id}" hat unbekannten Typ "${String(type)}".`);
}

function parseRotation(raw: unknown): 0 | 90 | 180 | 270 | undefined {
    if (raw === undefined) return undefined;
    if (raw === 0 || raw === 90 || raw === 180 || raw === 270) return raw;
    throw new FrontmatterParseError(`"rotate" muss 0, 90, 180 oder 270 sein, war: ${String(raw)}`);
}

function parseBlankSize(
    raw: unknown
): "A4" | "Letter" | { width: number; height: number } | undefined {
    if (raw === undefined) return undefined;
    if (raw === "A4" || raw === "Letter") return raw;
    if (
        typeof raw === "object" &&
        raw !== null &&
        typeof (raw as Record<string, unknown>).width === "number" &&
        typeof (raw as Record<string, unknown>).height === "number"
    ) {
        return raw as { width: number; height: number };
    }
    throw new FrontmatterParseError(
        `"size" muss "A4", "Letter" oder {width, height} sein, war: ${JSON.stringify(raw)}`
    );
}

function parseBlankTemplate(raw: unknown): BuiltinTemplateId | undefined {
    if (raw === undefined) return undefined;
    const valid: BuiltinTemplateId[] = ["blank", "grid", "grid-margin", "lines", "lines-margin"];
    if (typeof raw === "string" && (valid as string[]).includes(raw)) {
        return raw as BuiltinTemplateId;
    }
    throw new FrontmatterParseError(`"template" muss einer von ${valid.join(", ")} sein, war: ${String(raw)}`);
}

/**
 * Dekomprimiert ein Metadaten-Feld (textBlocks/pdfAnnotations/ocrBlocks).
 * Unterstützt drei Formate für Abwärtskompatibilität:
 *
 *  - NEU: Map { id: komprimierterString }. Git-freundlich (eine Zeile pro
 *    Eintrag) und in der Reading-View als "…" zusammengefasst (Obsidian
 *    verkürzt Objekt-Werte, Arrays dagegen werden voll ausgeschrieben).
 *  - ALT: Array von Strings (ein String pro Eintrag, ebenfalls eine Zeile
 *    pro Eintrag — aber in der Reading-View voll ausgeschrieben).
 *  - ALT-ALT: einzelner String, der das komplette Array als komprimiertes
 *    JSON enthält.
 */
export function decompressMetaArray(compressed: unknown): any[] | undefined {
    if (!compressed) return undefined;
    try {
        // NEU: Map { id: compressedString }
        if (!Array.isArray(compressed) && typeof compressed === "object") {
            const out: any[] = [];
            for (const value of Object.values(compressed as Record<string, unknown>)) {
                if (typeof value !== "string") continue;
                out.push(JSON.parse(decompressText(value)));
            }
            return out.length > 0 ? out : undefined;
        }
        // ALT: Array von Strings
        if (Array.isArray(compressed)) {
            return compressed.map((item) => JSON.parse(decompressText(item as string)));
        }
        // ALT-ALT: einzelner String (das ganze Array als JSON)
        const json = decompressText(compressed as string);
        return JSON.parse(json);
    } catch {
        return undefined;
    }
}