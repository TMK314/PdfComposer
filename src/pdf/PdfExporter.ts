// PdfExporter.ts
//
// Exportiert ein PDF-Compose-Dokument als eigenständige PDF-Datei.
// PDF-Quellseiten werden verlustfrei per pdf-lib copyPages() übernommen,
// Leerseiten neu gezeichnet. Vektorannotationen (Stifte, Formen) werden
// als echte Vektorpfade (drawSvgPath) statt als Rastergrafik eingefügt.
// Textblöcke werden mit einfacher Rich-Text-Formatierung (Fett, Kursiv,
// Überschriften, Listen, Inline-Code) gerendert. PDF-Anmerkungen werden
// zusätzlich als echte PDF-Kommentare (Sticky-Note-Annotation) exportiert.
//
// Bekannte Einschränkungen (bewusste Vereinfachungen):
// - Kurven/Stufen bei Linien/Pfeilen/Polygonen werden als gerade Segmente
//   exportiert (keine Bézier-Rekonstruktion).
// - Freihand-Striche mit variabler Druckbreite werden mit einer
//   gemittelten Strichbreite gezeichnet.
// - Markdown-Unterstützung ist bewusst einfach gehalten: **fett**,
//   *kursiv*, ***fett+kursiv***, `code`, # Überschriften, - Listen.
//   Verschachtelte/komplexere Konstrukte (Tabellen, Zitate, Links mit
//   eigener Formatierung) werden auf Klartext reduziert.

import { App, TFile } from "obsidian";
import {
    PDFDocument,
    PDFPage,
    PDFFont,
    PDFName,
    PDFString,
    PDFArray,
    PDFDict,
    PDFBool,
    PDFNumber,
    PDFOperator,
    PDFOperatorNames,
    rgb,
    degrees,
    LineCapStyle,
    StandardFonts,
    LineJoinStyle,
    setLineJoin,
    pushGraphicsState,
    popGraphicsState,
} from "pdf-lib";
import {
    PdfComposeDocument,
    VectorObject,
    PdfPageDefinition,
    BlankPageDefinition,
    PageDefinition,
    ColorMode,
    isPdfPage,
    isBlankPage,
    FreehandObject,
    DiamondObject,
}
    from "../types";
import { PAGE_SIZES } from "../view/constants";
import { decodeAnnotations } from "./VectorSerializer";
import { parseTextBlocks, groupTextBlocksByPage, TextBlockEntry } from "../parser/TextBlockParser";
import { parsePdfAnnotations, groupPdfAnnotationsByPage, PdfAnnotationRect } from "../parser/PdfAnnotationParser";
import { buildVariableWidthPathData, isUniformWidth, buildSmoothCenterlinePathData, centripetalControlPoints } from "./StrokePathBuilder";
import { PdfPageRenderer } from "./PdfPageRenderer";
import { invertLightness } from "./ColorUtils";
import { PdfComposeSettings } from "../settings";
import { parseShapeLabels, groupShapeLabelsByPage, ShapeLabelEntry } from "../parser/ShapeLabelParser";

const MM = 72 / 25.4;
const GRID_SIZE = 5 * MM;
const LINE_SPACING = 8 * MM;
const MARGIN = 20 * MM;

interface FontBundle {
    regular: PDFFont;
    bold: PDFFont;
    italic: PDFFont;
    boldItalic: PDFFont;
    code: PDFFont;
}

export interface PdfExportOptions {
    /** IDs der zu exportierenden Seiten, IN DER GEWÜNSCHTEN REIHENFOLGE. undefined = alle Seiten in Dokumentreihenfolge. */
    pageIds?: string[];
    /** "original" kopiert PDF-Seiten unverändert; "light"/"dark" erzwingt eine Farbinvertierung. */
    colorMode: ColorMode;
}

export async function exportPdfComposeToPdf(
    app: App,
    file: TFile,
    doc: PdfComposeDocument,
    renderer: PdfPageRenderer,
    options: PdfExportOptions = { colorMode: "original" }
): Promise<Uint8Array> {
    const outPdf = await PDFDocument.create();
    const fonts: FontBundle = {
        regular: await outPdf.embedFont(StandardFonts.Helvetica),
        bold: await outPdf.embedFont(StandardFonts.HelveticaBold),
        italic: await outPdf.embedFont(StandardFonts.HelveticaOblique),
        boldItalic: await outPdf.embedFont(StandardFonts.HelveticaBoldOblique),
        code: await outPdf.embedFont(StandardFonts.Courier),
    };

    const raw = await app.vault.read(file);
    const textBlocksByPage = groupTextBlocksByPage(parseTextBlocks(raw, doc));
    const pdfAnnotationsByPage = groupPdfAnnotationsByPage(parsePdfAnnotations(raw, doc));
    // NEU: Formen-Beschriftungen laden - lagen bisher nur in der Live-Ansicht
    // (PdfComposeView.getPageAnnotations) im "label"-Feld vor, nie beim Export.
    const shapeLabelsByPage = groupShapeLabelsByPage(parseShapeLabels(raw, doc));

    const pagesToExport: PageDefinition[] = options.pageIds
        ? options.pageIds
            .map(id => doc.pages.find(p => p.id === id))
            .filter((p): p is PageDefinition => !!p)
        : doc.pages;

    for (const page of pagesToExport) {
        const invert = await shouldInvertPageForExport(renderer, doc, page, options.colorMode);

        if (isPdfPage(page)) {
            await appendPdfPage(
                app, outPdf, doc, page, fonts,
                textBlocksByPage.get(page.id) ?? [],
                shapeLabelsByPage.get(page.id) ?? [],
                invert, renderer
            );
        } else if (isBlankPage(page)) {
            appendBlankPage(
                outPdf, doc, page, fonts,
                textBlocksByPage.get(page.id) ?? [],
                shapeLabelsByPage.get(page.id) ?? [],
                invert
            );
        }

        const pdfAnnots = pdfAnnotationsByPage.get(page.id) ?? [];
        if (pdfAnnots.length > 0) {
            const lastPage = outPdf.getPage(outPdf.getPageCount() - 1);
            const { height } = lastPage.getSize();
            for (const entry of pdfAnnots) {
                const displayColorHex = invert ? invertLightness(entry.color) : entry.color;
                const { r, g, b, a } = hexToRgbComponents(displayColorHex);

                for (const rect of entry.rects) {
                    lastPage.drawRectangle({
                        x: rect.x,
                        y: height - rect.y - rect.height,
                        width: rect.width,
                        height: rect.height,
                        color: rgb(r, g, b),
                        opacity: Math.min(0.5, a),
                    });
                }

                if (entry.rects.length > 0 && entry.markdown.trim()) {
                    const box = mergeRects(entry.rects);
                    const iconX = box.x + box.width;
                    const iconY = height - box.y;
                    addCommentAnnotation(outPdf, lastPage, iconX, iconY, markdownToPlainText(entry.markdown), { r, g, b });
                }
            }
        }
    }

    return outPdf.save();
}

/**
 * Ermittelt, ob eine Seite beim Export invertiert werden soll - dieselbe
 * Logik wie PdfComposeView.isPageInverted(), aber ohne Zugriff auf den
 * View-internen pageIsDarkOriginal-Cache: die Original-Helligkeit wird
 * hier bei Bedarf per Kleinst-Rasterung neu ermittelt.
 */
async function shouldInvertPageForExport(
    renderer: PdfPageRenderer,
    doc: PdfComposeDocument,
    page: PageDefinition,
    colorMode: ColorMode
): Promise<boolean> {
    const manualOverride = page.invert === true;
    if (colorMode === "original") return manualOverride;

    let originalIsDark = false;
    if (isPdfPage(page)) {
        const sourcePath = doc.sources[page.src];
        if (sourcePath) {
            try {
                // Nur eine winzige Sonde zur Helligkeits-Erkennung, KEIN
                // Teil der exportierten Seite selbst - der eigentliche
                // Seiteninhalt bleibt in appendPdfPage() vollständig vektoriell.
                const probeCanvas = document.createElement("canvas");
                await renderer.renderPageToCanvas(sourcePath, page.srcPage, probeCanvas, { scale: 0.3, rotate: page.rotate ?? 0 });
                originalIsDark = renderer.detectBackgroundIsDark(sourcePath, page.srcPage, probeCanvas);
            } catch {
                // Konnte nicht ermittelt werden -> als helle Seite behandeln.
            }
        }
    }

    const wantsDark = colorMode === "dark";
    const baseInvert = wantsDark ? !originalIsDark : originalIsDark;
    return manualOverride ? !baseInvert : baseInvert;
}

function hexToHueDegreesExport(hex: string): number {
    const clean = hex.replace("#", "");
    if (clean.length < 6) return 0;
    const r = parseInt(clean.substring(0, 2), 16) / 255;
    const g = parseInt(clean.substring(2, 4), 16) / 255;
    const b = parseInt(clean.substring(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return 0;
    let h = 0;
    switch (max) {
        case r: h = ((g - b) / d) % 6; break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
    if (h < 0) h += 360;
    return h;
}

/**
 * Baut denselben CSS-Filter-String wie PdfComposeView.buildPageFilter() für
 * die Live-Ansicht - als reine Funktion, damit der Export PIXEL-IDENTISCH
 * zur Anzeige aussieht, statt einer eigenen (abweichenden) Invertierung.
 */
function buildExportFilter(invert: boolean, colorMode: ColorMode, settings: PdfComposeSettings): string {
    const applyInLight = settings.applyFiltersInLightMode ?? false;
    const applyInDark = settings.applyFiltersInDarkMode ?? true;
    const isDark = colorMode === "dark";
    const applyFilters = (isDark && applyInDark) || (!isDark && applyInLight);

    const monochrome = settings.darkModeMonochromeColor;
    const whiteDim = settings.darkModeWhiteDim ?? 0;
    const blackLighten = settings.darkModeBlackLighten ?? 0;
    const userHueRotate = settings.darkModeHueRotate ?? 0;

    const contrast = Math.max(0.5, 1 - whiteDim / 200);
    const brightness = Math.min(1.5, 1 + blackLighten / 200);

    let filter = "";
    if (invert) {
        filter += "invert(1) hue-rotate(180deg)";
    }

    if (monochrome) {
        const hue = hexToHueDegreesExport(monochrome);
        filter += ` grayscale(1) sepia(1) hue-rotate(${hue}deg) saturate(4)`;
    } else if (applyFilters) {
        if (userHueRotate !== 0) filter += ` hue-rotate(${userHueRotate}deg)`;
        if (contrast !== 1 || brightness !== 1) filter += ` brightness(${brightness}) contrast(${contrast})`;
    }

    return filter.trim();
}

/** RGB (0..1) → HSL, H und S beibehalten, L auf 1−L setzen, zurück nach RGB. */
function invertRgbHuePreserving(r: number, g: number, b: number): [number, number, number] {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0, s = 0;
    if (d !== 0) {
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }
    const lInv = 1 - l;
    if (s === 0) return [lInv, lInv, lInv];
    const q = lInv < 0.5 ? lInv * (1 + s) : lInv + s - lInv * s;
    const p = 2 * lInv - q;
    const h2r = (t: number) => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [h2r(h + 1 / 3), h2r(h), h2r(h - 1 / 3)];
}

// ============================================================
//  SEITEN AUFBAUEN
// ============================================================

async function appendPdfPage(
    app: App,
    outPdf: PDFDocument,
    doc: PdfComposeDocument,
    page: PdfPageDefinition,
    fonts: FontBundle,
    textBlocks: TextBlockEntry[],
    shapeLabels: ShapeLabelEntry[],
    invert: boolean,
    renderer: PdfPageRenderer
): Promise<void> {
    const sourcePath = doc.sources[page.src];
    if (!sourcePath) return;
    const file = app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;

    const bytes = await app.vault.readBinary(file);
    const srcPdf = await PDFDocument.load(bytes);
    const [copied] = await outPdf.copyPages(srcPdf, [page.srcPage - 1]);
    outPdf.addPage(copied);

    if (page.rotate) {
        const current = copied.getRotation().angle;
        copied.setRotation(degrees((current + page.rotate) % 360));
    }

    const { width, height } = copied.getSize();

    if (invert) {
        prependPageContent(outPdf, copied, `q\n1 1 1 rg\n0 0 ${width} ${height} re\nf\nQ`);
    }

    const objects = decodeAnnotations(doc.annotations[page.id] ?? []);

    // NEU: Formen-Beschriftungen aus dem separaten shapeLabels-Speicherort
    // in die Objekte einhängen - ohne das bleibt obj.label für alle Formen
    // (außer Linie/Pfeil) undefined und es wird nichts gezeichnet.
    for (const labelEntry of shapeLabels) {
        const shape = objects.find(o => o.id === labelEntry.shapeId);
        if (shape) {
            (shape as any).label = {
                text: labelEntry.text,
                fontSize: labelEntry.fontSize,
                color: labelEntry.color,
            };
        }
    }

    const highlighterObjects = objects.filter(isHighlighterVectorObject);
    const normalObjects = objects.filter(o => !isHighlighterVectorObject(o));

    if (invert) {
        const diffGsName = pushExtGStateBlend(outPdf, copied, "Difference");
        applyDifferenceWhiteRect(copied, diffGsName, 0, 0, width, height);
        try {
            const regions = await renderer.getImageRegions(sourcePath, page.srcPage);
            for (const region of regions) {
                const rx = region.x;
                const ry = height - region.y - region.height;
                applyDifferenceWhiteRect(copied, diffGsName, rx, ry, region.width, region.height);
            }
        } catch {
            // Bildbereiche konnten nicht ermittelt werden -> Bilder bleiben invertiert.
        }
    }

    if (highlighterObjects.length > 0) {
        const blendMode = invert ? "Screen" : "Multiply";
        const gsName = pushExtGStateBlend(outPdf, copied, blendMode);
        pushGraphicsStateStart(copied, gsName);
        drawObjects(copied, highlighterObjects, height, invert, fonts);
        pushGraphicsStateEnd(copied);
    }

    drawObjects(copied, normalObjects, height, invert, fonts);
    drawTextBlocks(copied, textBlocks, height, fonts, invert);
}

/**
 * Kehrt die Farben einer bereits vollständig gezeichneten Seite um, OHNE
 * die Seite zu rastern: eine deckende weiße Fläche wird mit PDF-Blend-Mode
 * "Difference" über den gesamten Seiteninhalt gelegt. Difference(weiß, C)
 * = |1 - C| = 1 - C entspricht exakt einer Farbinvertierung pro RGB-Kanal
 * - dieselbe Operation wie ein CSS "invert(1)"-Filter, aber als echter
 * PDF-Blend-Mode direkt im Vektor-Inhalt. Text bleibt dadurch echter,
 * kopier-/markierbarer Text, eingebettete Bilder bleiben in
 * Originalauflösung erhalten - nichts wird gerastert.
 */
function applyPageInvertOverlay(pdfDoc: PDFDocument, page: PDFPage, width: number, height: number): void {
    const context = pdfDoc.context;

    const gsDict = PDFDict.withContext(context);
    gsDict.set(PDFName.of("Type"), PDFName.of("ExtGState"));
    gsDict.set(PDFName.of("BM"), PDFName.of("Difference"));
    const gsRef = context.register(gsDict);

    let resources = page.node.lookupMaybe(PDFName.of("Resources"), PDFDict);
    if (!resources) {
        resources = PDFDict.withContext(context);
        page.node.set(PDFName.of("Resources"), resources);
    }
    let extGStateDict = resources.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
    if (!extGStateDict) {
        extGStateDict = PDFDict.withContext(context);
        resources.set(PDFName.of("ExtGState"), extGStateDict);
    }
    const gsName = PDFName.of("PdfComposeInvert");
    extGStateDict.set(gsName, gsRef);

    page.pushOperators(
        PDFOperator.of(PDFOperatorNames.PushGraphicsState),
        PDFOperator.of(PDFOperatorNames.SetGraphicsStateParams, [gsName]),
        PDFOperator.of(PDFOperatorNames.NonStrokingColorRgb, [PDFNumber.of(1), PDFNumber.of(1), PDFNumber.of(1)]),
        PDFOperator.of(PDFOperatorNames.AppendRectangle, [PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(width), PDFNumber.of(height)]),
        PDFOperator.of(PDFOperatorNames.FillNonZero),
        PDFOperator.of(PDFOperatorNames.PopGraphicsState)
    );
}

function appendBlankPage(
    outPdf: PDFDocument,
    doc: PdfComposeDocument,
    page: BlankPageDefinition,
    fonts: FontBundle,
    textBlocks: TextBlockEntry[],
    shapeLabels: ShapeLabelEntry[],
    invert: boolean
): void {
    const size = typeof page.size === "object" ? page.size : PAGE_SIZES[page.size ?? "A4"];
    const pdfPage = outPdf.addPage([size.width, size.height]);

    const bg = invert ? rgb(0.12, 0.12, 0.12) : rgb(1, 1, 1);
    pdfPage.drawRectangle({ x: 0, y: 0, width: size.width, height: size.height, color: bg });
    drawBlankTemplate(pdfPage, page.template ?? "blank", size.width, size.height, invert);

    const objects = decodeAnnotations(doc.annotations[page.id] ?? []);

    for (const labelEntry of shapeLabels) {
        const shape = objects.find(o => o.id === labelEntry.shapeId);
        if (shape) {
            (shape as any).label = {
                text: labelEntry.text,
                fontSize: labelEntry.fontSize,
                color: labelEntry.color,
            };
        }
    }

    drawObjects(pdfPage, objects, size.height, invert, fonts);
    drawTextBlocks(pdfPage, textBlocks, size.height, fonts, invert);
}

function drawBlankTemplate(pdfPage: PDFPage, template: string, width: number, height: number, dark: boolean = false): void {
    const gridColor = dark ? rgb(0.35, 0.4, 0.45) : rgb(0.72, 0.83, 0.94);
    if (template === "grid" || template === "grid-margin") {
        const margin = template === "grid-margin" ? MARGIN : 0;
        for (let x = margin; x <= width - margin + 0.01; x += GRID_SIZE) {
            pdfPage.drawLine({ start: { x, y: margin }, end: { x, y: height - margin }, thickness: 0.5, color: gridColor });
        }
        for (let y = margin; y <= height - margin + 0.01; y += GRID_SIZE) {
            pdfPage.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.5, color: gridColor });
        }
    } else if (template === "lines" || template === "lines-margin") {
        const margin = template === "lines-margin" ? MARGIN : 0;
        for (let y = margin + LINE_SPACING; y <= height - margin + 0.01; y += LINE_SPACING) {
            pdfPage.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.5, color: gridColor });
        }
    }
}

// ============================================================
//  FARBEN / GEOMETRIE-HILFSFUNKTIONEN
// ============================================================

function hexToRgbComponents(hex: string): { r: number; g: number; b: number; a: number } {
    let clean = hex;
    let a = 1;
    if (/^#[0-9a-fA-F]{8}$/.test(clean)) {
        a = parseInt(clean.slice(7, 9), 16) / 255;
        clean = clean.slice(0, 7);
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(clean)) return { r: 0, g: 0, b: 0, a };
    const r = parseInt(clean.slice(1, 3), 16) / 255;
    const g = parseInt(clean.slice(3, 5), 16) / 255;
    const b = parseInt(clean.slice(5, 7), 16) / 255;
    return { r, g, b, a };
}

/** true, wenn dieses Objekt (Freihand-Textmarker ODER eine als isHighlighter markierte Form) wie ein Textmarker behandelt werden soll. */
function isHighlighterVectorObject(obj: VectorObject): boolean {
    if (obj.type === "freehand") return obj.highlighter === true;
    return (obj as any).isHighlighter === true;
}

/**
 * Fügt eigene Zeichenoperatoren VOR dem gesamten bisherigen Seiteninhalt
 * ein (statt dahinter, wie page.pushOperators() es täte). Damit lässt
 * sich z. B. ein Hintergrund-Rechteck HINTER die eigentliche PDF-Seite
 * legen - mit pdf-libs normalen Zeichenmethoden ist das nicht möglich, da
 * sie immer an den bestehenden Content-Stream ANHÄNGEN.
 */
function prependPageContent(pdfDoc: PDFDocument, page: PDFPage, operatorsStr: string): void {
    const context = pdfDoc.context;
    const newStream = context.stream(operatorsStr);
    const newStreamRef = context.register(newStream);

    const contentsKey = PDFName.of("Contents");
    const existing = page.node.get(contentsKey);

    let newArray: PDFArray;
    if (existing) {
        // Kann ein PDFRef auf einen Stream oder auf ein Array sein -
        // deshalb erst auflösen, dann entscheiden.
        const resolved = context.lookup(existing);
        if (resolved instanceof PDFArray) {
            newArray = context.obj([newStreamRef, ...resolved.asArray()]);
        } else {
            newArray = context.obj([newStreamRef, existing]);
        }
    } else {
        newArray = context.obj([newStreamRef]);
    }

    page.node.set(contentsKey, newArray);
}

/** Registriert einen benannten ExtGState-Eintrag mit dem gewünschten Blend-Modus in den Resourcen der Seite und gibt seinen Ressourcennamen zurück. */
function pushExtGStateBlend(pdfDoc: PDFDocument, page: PDFPage, blendModeName: string): PDFName {
    const context = pdfDoc.context;
    const gsDict = PDFDict.withContext(context);
    gsDict.set(PDFName.of("Type"), PDFName.of("ExtGState"));
    gsDict.set(PDFName.of("BM"), PDFName.of(blendModeName));
    const gsRef = context.register(gsDict);

    let resources = page.node.lookupMaybe(PDFName.of("Resources"), PDFDict);
    if (!resources) {
        resources = PDFDict.withContext(context);
        page.node.set(PDFName.of("Resources"), resources);
    }
    let extGStateDict = resources.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
    if (!extGStateDict) {
        extGStateDict = PDFDict.withContext(context);
        resources.set(PDFName.of("ExtGState"), extGStateDict);
    }
    const gsName = PDFName.of(`PdfComposeGS${(gsRef as any).objectNumber}`);
    extGStateDict.set(gsName, gsRef);
    return gsName;
}

function pushGraphicsStateStart(page: PDFPage, gsName: PDFName): void {
    page.pushOperators(
        PDFOperator.of(PDFOperatorNames.PushGraphicsState),
        PDFOperator.of(PDFOperatorNames.SetGraphicsStateParams, [gsName])
    );
}

function pushGraphicsStateEnd(page: PDFPage): void {
    page.pushOperators(PDFOperator.of(PDFOperatorNames.PopGraphicsState));
}

/** Zeichnet ein deckendes weißes Rechteck mit dem übergebenen Blend-Modus über den angegebenen Bereich - Baustein für die Invertierung bzw. deren gezielte Aufhebung über Bildbereichen. */
function applyDifferenceWhiteRect(page: PDFPage, gsName: PDFName, x: number, y: number, width: number, height: number): void {
    pushGraphicsStateStart(page, gsName);
    page.pushOperators(
        PDFOperator.of(PDFOperatorNames.NonStrokingColorRgb, [PDFNumber.of(1), PDFNumber.of(1), PDFNumber.of(1)]),
        PDFOperator.of(PDFOperatorNames.AppendRectangle, [PDFNumber.of(x), PDFNumber.of(y), PDFNumber.of(width), PDFNumber.of(height)]),
        PDFOperator.of(PDFOperatorNames.FillNonZero)
    );
    pushGraphicsStateEnd(page);
}

/**
 * Berechnet für jeden Punkt eines Freihand-Objekts die tatsächliche
 * Strichbreite (abhängig von strokeWidth, Druck und Druckkurve) - exakt
 * dieselbe Formel wie PdfComposeView.drawFreehandPath() in der Live-
 * Ansicht. Nötig, weil decodeAnnotations() beim Laden JEDEN Punkt mit
 * w=0 initialisiert (die Breite wird laut Kommentar dort "beim Zeichnen
 * neu berechnet") - ohne diese Neuberechnung exportierte jeder Strich
 * mit der minimalen Fallback-Breite von 0.2pt, unabhängig von der
 * tatsächlich eingestellten Strichdicke.
 */
function computeFreehandPointWidths(obj: FreehandObject): number[] {
    return obj.points.map(p => {
        if (!obj.pressureEnabled || p.p === undefined) return obj.strokeWidth;
        const pressure = Math.max(0, Math.min(1, p.p));
        let t: number;
        switch (obj.pressureCurve) {
            case "quadratic": t = pressure * pressure; break;
            case "sqrt": t = Math.sqrt(pressure); break;
            case "ease": t = pressure * pressure * (3 - 2 * pressure); break;
            default: t = pressure;
        }
        const minWidth = obj.strokeWidth * obj.pressureMinFactor;
        return minWidth + (obj.strokeWidth - minWidth) * t;
    });
}

function mergeRects(rects: PdfAnnotationRect[]): PdfAnnotationRect {
    const minX = Math.min(...rects.map(r => r.x));
    const minY = Math.min(...rects.map(r => r.y));
    const maxX = Math.max(...rects.map(r => r.x + r.width));
    const maxY = Math.max(...rects.map(r => r.y + r.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function linePointsToSvgPath(
    points: { x: number; y: number; segment?: "straight" | "curve" | "step" }[],
    closed: boolean = false
): string {
    if (points.length === 0) return "";
    const n = points.length;
    if (n === 1) return `M ${points[0].x} ${points[0].y}`;

    let d = `M ${points[0].x} ${points[0].y}`;
    const segmentCount = closed ? n : n - 1;
    for (let i = 1; i <= segmentCount; i++) {
        const idx = i % n;
        const prevIdx = (i - 1) % n;
        const prev = points[prevIdx];
        const curr = points[idx];
        const kind = curr.segment ?? "straight";

        if (kind === "step") {
            d += ` L ${curr.x} ${prev.y} L ${curr.x} ${curr.y}`;
        } else if (kind === "curve") {
            const before = points[closed ? (prevIdx - 1 + n) % n : Math.max(prevIdx - 1, 0)];
            const after = points[closed ? (idx + 1) % n : Math.min(idx + 1, n - 1)];
            const { c1, c2 } = centripetalControlPoints(before, prev, curr, after, false, 0.4);
            d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${curr.x} ${curr.y}`;
        } else {
            d += ` L ${curr.x} ${curr.y}`;
        }
    }
    if (closed) d += " Z";
    return d;
}

/** Zeichnet mit runden Linienverbindungen (drawSvgPath bietet dafür keine Option). */
function withRoundJoin(pdfPage: PDFPage, draw: () => void): void {
    pdfPage.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round));
    try {
        draw();
    } finally {
        pdfPage.pushOperators(popGraphicsState());
    }
}

function freehandToSvgPath(points: { x: number; y: number }[]): string {
    if (points.length === 0) return "";
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) d += ` L ${points[i].x} ${points[i].y}`;
    return d;
}

// ============================================================
//  VEKTOR-ANNOTATIONEN
// ============================================================
/** Dreht einen Punkt um einen Pivot – identische Formel wie
 *  PdfComposeView.rotatePoint(), damit Export und Live-Ansicht optisch
 *  übereinstimmen (beide arbeiten im selben "y wächst nach unten"-System). */
function rotatePointForExport(p: { x: number; y: number }, pivot: { x: number; y: number }, degreesVal: number): { x: number; y: number } {
    const rad = (degreesVal * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const dx = p.x - pivot.x, dy = p.y - pivot.y;
    return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

/** Baut einen SVG-Pfad für eine (optional rotierte) Ellipse per
 *  Bezier-Näherung – pdf-lib bietet für drawEllipse() keine Rotation. */
function ellipseToSvgPath(cx: number, cy: number, rx: number, ry: number, rotationDeg: number): string {
    const k = 0.5522847498;
    const localPoints = [
        { x: rx, y: 0 }, { x: rx, y: k * ry }, { x: k * rx, y: ry }, { x: 0, y: ry },
        { x: -k * rx, y: ry }, { x: -rx, y: k * ry }, { x: -rx, y: 0 },
        { x: -rx, y: -k * ry }, { x: -k * rx, y: -ry }, { x: 0, y: -ry },
        { x: k * rx, y: -ry }, { x: rx, y: -k * ry },
    ];
    const abs = rotationDeg
        ? localPoints.map(p => rotatePointForExport({ x: cx + p.x, y: cy + p.y }, { x: cx, y: cy }, rotationDeg))
        : localPoints.map(p => ({ x: cx + p.x, y: cy + p.y }));

    const [p0, c1a, c1b, p1, c2a, c2b, p2, c3a, c3b, p3, c4a, c4b] = abs;
    return `M ${p0.x} ${p0.y} ` +
        `C ${c1a.x} ${c1a.y} ${c1b.x} ${c1b.y} ${p1.x} ${p1.y} ` +
        `C ${c2a.x} ${c2a.y} ${c2b.x} ${c2b.y} ${p2.x} ${p2.y} ` +
        `C ${c3a.x} ${c3a.y} ${c3b.x} ${c3b.y} ${p3.x} ${p3.y} ` +
        `C ${c4a.x} ${c4a.y} ${c4b.x} ${c4b.y} ${p0.x} ${p0.y} Z`;
}

function drawObjects(pdfPage: PDFPage, objects: VectorObject[], pageHeight: number, invert: boolean, fonts: FontBundle): void {
    for (const obj of objects) {
        try {
            drawSingleObject(pdfPage, obj, pageHeight, invert, fonts);
        } catch (e) {
            console.warn("PdfCompose-Export: Objekt konnte nicht gezeichnet werden", obj, e);
        }
    }
}

function drawSingleObject(pdfPage: PDFPage, obj: VectorObject, pageHeight: number, invert: boolean, fonts: FontBundle): void {
    switch (obj.type) {
        case "freehand": {
            if (obj.points.length === 0) return;
            const colorHex = invert ? invertLightness(obj.color) : obj.color;
            const { r, g, b, a } = hexToRgbComponents(colorHex);
            const widths = computeFreehandPointWidths(obj);
            const pointsWithWidth = obj.points.map((p, i) => ({ ...p, w: widths[i] }));

            if (isUniformWidth(widths)) {
                // Gleiche geglättete Kurve wie in der Live-Ansicht
                const path = buildSmoothCenterlinePathData(pointsWithWidth);
                withRoundJoin(pdfPage, () => {
                    pdfPage.drawSvgPath(path, {
                        x: 0,
                        y: pageHeight,
                        borderColor: rgb(r, g, b),
                        borderWidth: Math.max(0.2, widths[0] ?? 1),
                        borderOpacity: a,
                        borderLineCap: LineCapStyle.Round,
                    });
                });
            } else {
                const path = buildVariableWidthPathData(pointsWithWidth);
                pdfPage.drawSvgPath(path, {
                    x: 0,
                    y: pageHeight,
                    color: rgb(r, g, b),
                    opacity: a,
                });
            }
            break;
        }
        case "line":
        case "arrow": {
            const colorHex = invert ? invertLightness(obj.color) : obj.color;
            const { r, g, b, a } = hexToRgbComponents(colorHex);
            const path = linePointsToSvgPath(obj.points);
            withRoundJoin(pdfPage, () => {
                pdfPage.drawSvgPath(path, {
                    x: 0, y: pageHeight,
                    borderColor: rgb(r, g, b),
                    borderWidth: Math.max(0.2, obj.width),
                    borderOpacity: a,
                    borderLineCap: LineCapStyle.Round,
                });
            });
            break;
        }
        case "polygon": {
            const strokeHex = invert ? invertLightness(obj.strokeColor) : obj.strokeColor;
            const fillHex = obj.fillColor ? (invert ? invertLightness(obj.fillColor) : obj.fillColor) : undefined;
            const stroke = hexToRgbComponents(strokeHex);
            const fill = fillHex ? hexToRgbComponents(fillHex) : null;
            const path = linePointsToSvgPath(obj.points, true);
            withRoundJoin(pdfPage, () => {
                pdfPage.drawSvgPath(path, {
                    x: 0, y: pageHeight,
                    borderColor: rgb(stroke.r, stroke.g, stroke.b),
                    borderWidth: Math.max(0.2, obj.strokeWidth),
                    borderOpacity: stroke.a,
                    color: fill ? rgb(fill.r, fill.g, fill.b) : undefined,
                    opacity: fill ? (obj.fillOpacity ?? 1) : undefined,
                });
            });
            if (obj.label) {
                const cx = obj.points.reduce((s, p) => s + p.x, 0) / obj.points.length;
                const cy = obj.points.reduce((s, p) => s + p.y, 0) / obj.points.length;
                drawShapeLabelPdf(pdfPage, fonts, obj.label, cx, cy, pageHeight, invert);
            }
            break;
        }
        case "rectangle": {
            const strokeHex = invert ? invertLightness(obj.strokeColor) : obj.strokeColor;
            const fillHex = obj.fillColor ? (invert ? invertLightness(obj.fillColor) : obj.fillColor) : undefined;
            const stroke = hexToRgbComponents(strokeHex);
            const fill = fillHex ? hexToRgbComponents(fillHex) : null;
            const center = { x: obj.x + obj.width / 2, y: obj.y + obj.height / 2 };
            const baseCorners = [
                { x: obj.x, y: obj.y },
                { x: obj.x + obj.width, y: obj.y },
                { x: obj.x + obj.width, y: obj.y + obj.height },
                { x: obj.x, y: obj.y + obj.height },
            ];
            const corners = obj.rotation ? baseCorners.map(p => rotatePointForExport(p, center, obj.rotation!)) : baseCorners;
            const path = linePointsToSvgPath(corners, true);
            pdfPage.drawSvgPath(path, {
                x: 0, y: pageHeight,
                borderColor: rgb(stroke.r, stroke.g, stroke.b),
                borderWidth: Math.max(0.2, obj.strokeWidth),
                borderOpacity: stroke.a,
                color: fill ? rgb(fill.r, fill.g, fill.b) : undefined,
                opacity: fill ? (obj.fillOpacity ?? 1) : undefined,
            });
            if (obj.label) {
                drawShapeLabelPdf(pdfPage, fonts, obj.label, center.x, center.y, pageHeight, invert, obj.rotation ?? 0);
            }
            break;
        }
        case "triangle": {
            const { x, y } = obj;
            const width = obj.width ?? obj.size ?? 0;
            const height = obj.height ?? obj.size ?? 0;
            const center = { x: x + width / 2, y: y + height / 2 };
            const basePoints = obj.variant === "right"
                ? [{ x, y: y + height }, { x, y }, { x: x + width, y: y + height }]
                : [{ x: x + width / 2, y }, { x, y: y + height }, { x: x + width, y: y + height }];
            const points = obj.rotation ? basePoints.map(p => rotatePointForExport(p, center, obj.rotation!)) : basePoints;
            const strokeHex = invert ? invertLightness(obj.strokeColor) : obj.strokeColor;
            const fillHex = obj.fillColor ? (invert ? invertLightness(obj.fillColor) : obj.fillColor) : undefined;
            const stroke = hexToRgbComponents(strokeHex);
            const fill = fillHex ? hexToRgbComponents(fillHex) : null;
            const path = linePointsToSvgPath(points, true);
            pdfPage.drawSvgPath(path, {
                x: 0, y: pageHeight,
                borderColor: rgb(stroke.r, stroke.g, stroke.b),
                borderWidth: Math.max(0.2, obj.strokeWidth),
                borderOpacity: stroke.a,
                color: fill ? rgb(fill.r, fill.g, fill.b) : undefined,
                opacity: fill ? (obj.fillOpacity ?? 1) : undefined,
            });
            if (obj.label) {
                // WICHTIG: der Beschriftungs-Anker ist bewusst der UNROTIERTE
                // Schwerpunkt (identisch zu PdfComposeView.drawTriangle) -
                // die Rotation dreht danach NUR die Textausrichtung um genau
                // diesen Anker, verschiebt ihn aber nicht (siehe drawShapeLabelPdf).
                const centroidX = obj.variant === "right" ? x + width / 3 : x + width / 2;
                const centroidY = y + (height * 2) / 3;
                drawShapeLabelPdf(pdfPage, fonts, obj.label, centroidX, centroidY, pageHeight, invert, obj.rotation ?? 0);
            }
            break;
        }
        case "ellipse": {
            const strokeHex = invert ? invertLightness(obj.strokeColor) : obj.strokeColor;
            const fillHex = obj.fillColor ? (invert ? invertLightness(obj.fillColor) : obj.fillColor) : undefined;
            const stroke = hexToRgbComponents(strokeHex);
            const fill = fillHex ? hexToRgbComponents(fillHex) : null;
            const path = ellipseToSvgPath(obj.cx, obj.cy, obj.rx, obj.ry, obj.rotation ?? 0);
            pdfPage.drawSvgPath(path, {
                x: 0, y: pageHeight,
                borderColor: rgb(stroke.r, stroke.g, stroke.b),
                borderWidth: Math.max(0.2, obj.strokeWidth),
                borderOpacity: stroke.a,
                color: fill ? rgb(fill.r, fill.g, fill.b) : undefined,
                opacity: fill ? (obj.fillOpacity ?? 1) : undefined,
            });
            if (obj.label) {
                drawShapeLabelPdf(pdfPage, fonts, obj.label, obj.cx, obj.cy, pageHeight, invert, obj.rotation ?? 0);
            }
            break;
        }
        case "diamond": {
            const { x, y, width, height } = obj;
            const center = { x: x + width / 2, y: y + height / 2 };
            const basePoints = [
                { x: x + width / 2, y },
                { x: x + width, y: y + height / 2 },
                { x: x + width / 2, y: y + height },
                { x, y: y + height / 2 },
            ];
            const points = obj.rotation ? basePoints.map(p => rotatePointForExport(p, center, obj.rotation!)) : basePoints;
            const strokeHex = invert ? invertLightness(obj.strokeColor) : obj.strokeColor;
            const fillHex = obj.fillColor ? (invert ? invertLightness(obj.fillColor) : obj.fillColor) : undefined;
            const stroke = hexToRgbComponents(strokeHex);
            const fill = fillHex ? hexToRgbComponents(fillHex) : null;
            const path = linePointsToSvgPath(points, true);
            pdfPage.drawSvgPath(path, {
                x: 0, y: pageHeight,
                borderColor: rgb(stroke.r, stroke.g, stroke.b),
                borderWidth: Math.max(0.2, obj.strokeWidth),
                borderOpacity: stroke.a,
                color: fill ? rgb(fill.r, fill.g, fill.b) : undefined,
                opacity: fill ? (obj.fillOpacity ?? 1) : undefined,
            });
            if (obj.label) {
                drawShapeLabelPdf(pdfPage, fonts, obj.label, center.x, center.y, pageHeight, invert, obj.rotation ?? 0);
            }
            break;
        }
    }
}

// ============================================================
//  MARKDOWN -> RICH TEXT (für Textblöcke)
// ============================================================

interface TextRun {
    text: string;
    bold: boolean;
    italic: boolean;
    code: boolean;
}

interface RichLine {
    runs: TextRun[];
    fontSize: number;
    bullet: boolean;
    /** Zusätzlicher vertikaler Abstand NACH dieser Zeile (z. B. nach Überschriften). */
    spacingAfter: number;
}

interface WordToken {
    text: string;
    bold: boolean;
    italic: boolean;
    code: boolean;
}

/** Entfernt Bild-Embeds vollständig, ersetzt Links durch ihren sichtbaren Text. */
function stripLinksAndImages(text: string): string {
    return text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

/** Tokenisiert eine Zeile in fett/kursiv/code-Runs (**fett**, *kursiv*, ***beides***, `code`). */
function parseInlineRuns(text: string, forceBold: boolean): TextRun[] {
    const cleaned = stripLinksAndImages(text);
    const runs: TextRun[] = [];
    const regex = /\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|([^*`]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleaned)) !== null) {
        if (match[1] !== undefined) {
            runs.push({ text: match[1], bold: true, italic: true, code: false });
        } else if (match[2] !== undefined) {
            runs.push({ text: match[2], bold: true, italic: false, code: false });
        } else if (match[3] !== undefined) {
            runs.push({ text: match[3], bold: forceBold, italic: true, code: false });
        } else if (match[4] !== undefined) {
            runs.push({ text: match[4], bold: forceBold, italic: false, code: true });
        } else if (match[5] !== undefined) {
            runs.push({ text: match[5], bold: forceBold, italic: false, code: false });
        }
    }
    if (runs.length === 0) runs.push({ text: "", bold: forceBold, italic: false, code: false });
    return runs;
}

/** Parst Markdown zeilenweise: Überschriften, Listenpunkte, Inline-Formatierung. */
function parseMarkdownLines(markdown: string, baseFontSize: number): RichLine[] {
    const rawLines = markdown.split(/\r?\n/);
    const lines: RichLine[] = [];

    for (const raw of rawLines) {
        if (raw.trim() === "") {
            lines.push({ runs: [{ text: "", bold: false, italic: false, code: false }], fontSize: baseFontSize, bullet: false, spacingAfter: 0 });
            continue;
        }

        const headerMatch = raw.match(/^(#{1,6})\s+(.*)$/);
        if (headerMatch) {
            const level = headerMatch[1].length;
            const fontSize = baseFontSize * (1.8 - (level - 1) * 0.15);
            lines.push({ runs: parseInlineRuns(headerMatch[2], true), fontSize, bullet: false, spacingAfter: fontSize * 0.3 });
            continue;
        }

        const bulletMatch = raw.match(/^\s*[-*+]\s+(.*)$/);
        if (bulletMatch) {
            lines.push({ runs: parseInlineRuns(bulletMatch[1], false), fontSize: baseFontSize, bullet: true, spacingAfter: 0 });
            continue;
        }

        lines.push({ runs: parseInlineRuns(raw, false), fontSize: baseFontSize, bullet: false, spacingAfter: 0 });
    }

    return lines;
}

/** Zerlegt die Runs einer RichLine in einzelne Wort-/Leerzeichen-Tokens (für den Zeilenumbruch). */
function lineToWordTokens(line: RichLine): WordToken[] {
    const tokens: WordToken[] = [];
    for (const run of line.runs) {
        const parts = run.text.split(/(\s+)/);
        for (const part of parts) {
            if (part === "") continue;
            tokens.push({ text: part, bold: run.bold, italic: run.italic, code: run.code });
        }
    }
    return tokens;
}

function getFont(fonts: FontBundle, token: { bold: boolean; italic: boolean; code: boolean }): PDFFont {
    if (token.code) return fonts.code;
    if (token.bold && token.italic) return fonts.boldItalic;
    if (token.bold) return fonts.bold;
    if (token.italic) return fonts.italic;
    return fonts.regular;
}

/** Bricht eine Token-Liste anhand der verfügbaren Breite in mehrere Zeilen um. */
function wrapTokens(tokens: WordToken[], fonts: FontBundle, fontSize: number, maxWidth: number, indent: number): WordToken[][] {
    const lines: WordToken[][] = [];
    let current: WordToken[] = [];
    let currentWidth = 0;
    const available = Math.max(10, maxWidth - indent);

    for (const token of tokens) {
        const font = getFont(fonts, token);
        const width = font.widthOfTextAtSize(token.text, fontSize);
        const isWhitespace = token.text.trim() === "";
        if (currentWidth + width > available && current.length > 0 && !isWhitespace) {
            lines.push(current);
            current = [];
            currentWidth = 0;
        }
        current.push(token);
        currentWidth += width;
    }
    lines.push(current);
    return lines;
}

function drawTextBlocks(pdfPage: PDFPage, entries: TextBlockEntry[], pageHeight: number, fonts: FontBundle, invert: boolean): void {
    const baseFontSize = 10;
    const bulletIndent = 12;
    const textColor = invert ? rgb(0.949, 0.949, 0.949) : rgb(0, 0, 0);

    for (const entry of entries) {
        if (!entry.markdown.trim()) continue;
        const scale = (entry.fontScale || 100) / 100;
        const fontSize = baseFontSize * scale;
        const maxWidth = Math.max(20, entry.width);
        const richLines = parseMarkdownLines(entry.markdown, fontSize);

        let y = pageHeight - entry.y - fontSize;

        for (const richLine of richLines) {
            const indent = richLine.bullet ? bulletIndent : 0;
            const tokens = lineToWordTokens(richLine);
            const visualLines = wrapTokens(tokens, fonts, richLine.fontSize, maxWidth, indent);

            for (let i = 0; i < visualLines.length; i++) {
                if (richLine.bullet && i === 0) {
                    pdfPage.drawText("•", { x: entry.x, y, size: richLine.fontSize, font: fonts.regular, color: textColor });
                }
                let x = entry.x + indent;
                for (const token of visualLines[i]) {
                    const font = getFont(fonts, token);
                    if (token.text.trim() !== "") {
                        pdfPage.drawText(token.text, { x, y, size: richLine.fontSize, font, color: textColor });
                    }
                    x += font.widthOfTextAtSize(token.text, richLine.fontSize);
                }
                y -= richLine.fontSize * 1.3;
            }
            y -= richLine.spacingAfter;
        }
    }
}

/** Zeichnet die mittige Text-Beschriftung einer Form (Pendant zu
 *  PdfComposeView.renderShapeLabel). Rotation: In der Live-Ansicht wird der
 *  Text per SVG "translate(cx cy) rotate(deg)" um genau den übergebenen
 *  Anker gedreht - mathematisch äquivalent zu "nominale Position um den
 *  Anker rotieren UND den Text selbst um denselben Winkel drehen". pdf-libs
 *  eigenes drawText-rotate arbeitet in echtem PDF-Raum (y nach oben,
 *  Gegenuhrzeigersinn positiv) - das Vorzeichen wird deshalb umgekehrt,
 *  damit die Drehrichtung optisch zur Live-Ansicht (y nach unten,
 *  Uhrzeigersinn positiv) passt. */
function drawShapeLabelPdf(
    pdfPage: PDFPage,
    fonts: FontBundle,
    label: { text: string; fontSize?: number; color?: string } | undefined,
    centerX: number,
    centerY: number,
    pageHeight: number,
    invert: boolean,
    rotationDeg: number = 0,
): void {
    if (!label || !label.text.trim()) return;
    const fontSize = label.fontSize ?? 14;
    const lines = label.text.split(/\r?\n/);
    const lineHeight = fontSize * 1.2;
    const colorHex = label.color
        ? (invert ? invertLightness(label.color) : label.color)
        : (invert ? "#f2f2f2" : "#1a1a1a");
    const { r, g, b } = hexToRgbComponents(colorHex);
    const font = fonts.regular;

    const startYOffset = -((lines.length - 1) * lineHeight) / 2 + fontSize * 0.35;
    const pdfRotation = degrees(-rotationDeg);

    lines.forEach((line, i) => {
        const textWidth = font.widthOfTextAtSize(line, fontSize);
        const lineYOffsetTopDown = startYOffset + i * lineHeight;
        const nominalLeft = { x: centerX - textWidth / 2, y: centerY + lineYOffsetTopDown };
        const rotatedLeft = rotationDeg
            ? rotatePointForExport(nominalLeft, { x: centerX, y: centerY }, rotationDeg)
            : nominalLeft;

        pdfPage.drawText(line, {
            x: rotatedLeft.x,
            y: pageHeight - rotatedLeft.y,
            size: fontSize,
            font,
            color: rgb(r, g, b),
            rotate: pdfRotation,
        });
    });
}

function markdownToPlainText(md: string): string {
    return stripLinksAndImages(md)
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "• ")
        .replace(/[*_`~]/g, "")
        .trim();
}

// ============================================================
//  PDF-ANMERKUNGEN ALS ECHTE KOMMENTARE
// ============================================================

/**
 * Fügt eine echte PDF-Text-Annotation (Sticky Note / Kommentar) hinzu.
 * pdf-lib bietet dafür keine High-Level-API, daher wird das
 * Annotations-Dictionary manuell über die Low-Level-Objekte des
 * PDFContext gebaut und in den "Annots"-Array der Seite eingehängt.
 */
function addCommentAnnotation(
    pdfDoc: PDFDocument,
    page: PDFPage,
    x: number,
    y: number,
    contents: string,
    color: { r: number; g: number; b: number }
): void {
    if (!contents.trim()) return;
    const context = pdfDoc.context;
    const iconSize = 16;

    const dict = PDFDict.withContext(context);
    dict.set(PDFName.of("Type"), PDFName.of("Annot"));
    dict.set(PDFName.of("Subtype"), PDFName.of("Text"));
    dict.set(PDFName.of("Rect"), context.obj([x, y - iconSize, x + iconSize, y]));
    dict.set(PDFName.of("Contents"), PDFString.of(contents));
    dict.set(PDFName.of("Name"), PDFName.of("Comment"));
    dict.set(PDFName.of("C"), context.obj([color.r, color.g, color.b]));
    dict.set(PDFName.of("Open"), PDFBool.False);

    const annotRef = context.register(dict);

    const existing = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (existing) {
        existing.push(annotRef);
    } else {
        page.node.set(PDFName.of("Annots"), context.obj([annotRef]));
    }
}