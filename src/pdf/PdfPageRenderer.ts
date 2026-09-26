import { TFile, Vault } from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.js";

// Worker über CDN beziehen (Version muss mit deiner pdfjs-dist-Version übereinstimmen)
pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

export interface RenderOptions {
    scale?: number;
    rotate?: number;
    /** Bitmap-Auflösung relativ zur CSS-Anzeigegröße (devicePixelRatio). Standard 1. */
    pixelRatio?: number;
}

export class PdfPageRenderer {
    private vault: Vault;
    private documentCache: Map<string, Promise<PDFDocumentProxy>>;
    private textItemsCache: Map<string, TextItemWithPosition[]> = new Map();

    private darkDetectionCache: Map<string, boolean> = new Map();
    private imageRegionCache: Map<string, ImageRegion[]> = new Map();
    private viewportSizeCache: Map<string, { width: number; height: number }> = new Map();
    private static readonly MAX_CACHE_ENTRIES = 40;

    constructor(vault: Vault) {
        this.vault = vault;
        this.documentCache = new Map();
    }

    /**
     * Lädt ein PDF-Dokument aus dem Vault und cached das Ergebnis anhand des
     * Pfads. Mehrfache Aufrufe für denselben Pfad liefern dieselbe (gecachte)
     * Promise zurück, damit ein PDF pro View nur einmal geparst wird.
     */
    private getDocument(path: string): Promise<PDFDocumentProxy> {
        const cached = this.documentCache.get(path);
        if (cached) {
            return cached;
        }

        const loadPromise = this.loadDocumentFromVault(path);
        this.documentCache.set(path, loadPromise);
        return loadPromise;
    }

    private async loadDocumentFromVault(path: string): Promise<PDFDocumentProxy> {
        const file = this.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            throw new Error(`PDF-Quelle nicht gefunden: ${path}`);
        }

        const data = await this.vault.readBinary(file);
        const loadingTask = pdfjsLib.getDocument({
            data: new Uint8Array(data),
            // disableWorker wurde entfernt – der Worker wird über GlobalWorkerOptions gesteuert
        });
        return loadingTask.promise;
    }

    private textCache: Map<string, string> = new Map(); // Schlüssel: path + "#" + pageNumber

    /**
 * Transformiert ein achsenparalleles Rechteck aus dem PDF-Koordinatensystem
 * (y nach oben) über die VOLLSTÄNDIGE Viewport-Transformation (Skalierung
 * UND Rotation) in Bildschirmkoordinaten und liefert die resultierende,
 * wieder achsenparallele Bounding-Box zurück. Eine reine
 * "viewport.height - y"-Umrechnung (wie zuvor) berücksichtigt keine
 * Drehung und platziert Text/Links auf rotierten Seiten falsch.
 */
    private static viewportBoundingBox(
        viewport: { convertToViewportPoint: (x: number, y: number) => number[] },
        x: number,
        y: number,
        width: number,
        height: number
    ): { x: number; y: number; width: number; height: number } {
        const corners = [
            [x, y],
            [x + width, y],
            [x + width, y + height],
            [x, y + height],
        ];
        const transformed = corners.map(([cx, cy]) => viewport.convertToViewportPoint(cx, cy));
        const xs = transformed.map(p => p[0]);
        const ys = transformed.map(p => p[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    async getPageText(path: string, pageNumber: number): Promise<string> {
        const key = `${path}#${pageNumber}`;
        if (this.textCache.has(key)) {
            return this.textCache.get(key)!;
        }
        const text = await this.extractTextInternal(path, pageNumber);
        this.textCache.set(key, text);
        this.capCacheSize(this.textCache);
        return text;
    }

    private async extractTextInternal(path: string, pageNumber: number): Promise<string> {
        const pdfDocument = await this.getDocument(path);
        const page = await pdfDocument.getPage(pageNumber);
        const textContent = await page.getTextContent();

        // Nur Einträge mit einer 'str'-Eigenschaft (das sind die TextItems)
        const textItems = textContent.items.filter(item => 'str' in item);
        return textItems.map(item => (item as any).str).join(' ');
    }

    async getPageTextItems(path: string, pageNumber: number, rotate: number = 0): Promise<TextItemWithPosition[]> {
        const key = `${path}#${pageNumber}#${rotate}`;
        if (this.textItemsCache.has(key)) {
            return this.textItemsCache.get(key)!;
        }
        const items = await this.extractTextItemsInternal(path, pageNumber, rotate);
        this.textItemsCache.set(key, items);
        this.capCacheSize(this.textItemsCache);
        return items;
    }

    private async extractTextItemsInternal(path: string, pageNumber: number, rotate: number): Promise<TextItemWithPosition[]> {
        const pdfDocument = await this.getDocument(path);
        const page = await pdfDocument.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1, rotation: rotate }); // Skalierung 1, aber MIT Rotation
        const items: TextItemWithPosition[] = [];
        for (const item of textContent.items) {
            if ('str' in item) {
                const transform = item.transform;
                const box = PdfPageRenderer.viewportBoundingBox(viewport, transform[4], transform[5], item.width, item.height);
                items.push({
                    str: item.str,
                    x: box.x,
                    y: box.y + box.height, // entspricht der bisherigen Semantik von item.y bei rotate=0
                    width: box.width,
                    height: box.height,
                });
            }
        }
        return items;
    }

    /**
* Liest die Link-Annotationen einer PDF-Seite aus (externe URLs sowie
* interne Sprungziele, z. B. aus einem Inhaltsverzeichnis). Koordinaten
* werden wie bei getPageTextItems() über die volle Viewport-Transformation
* (inkl. Rotation) in Bildschirmkoordinaten umgerechnet.
*/
    async getPageLinkAnnotations(path: string, pageNumber: number, rotate: number = 0): Promise<PdfLinkAnnotation[]> {
        const pdfDocument = await this.getDocument(path);
        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1, rotation: rotate });
        const annotations = await page.getAnnotations({ intent: "display" });

        const result: PdfLinkAnnotation[] = [];
        for (const annot of annotations as any[]) {
            if (annot.subtype !== "Link") continue;
            const rect = annot.rect;
            if (!rect || rect.length < 4) continue;

            const x1 = Math.min(rect[0], rect[2]);
            const x2 = Math.max(rect[0], rect[2]);
            const y1 = Math.min(rect[1], rect[3]);
            const y2 = Math.max(rect[1], rect[3]);
            const box = PdfPageRenderer.viewportBoundingBox(viewport, x1, y1, x2 - x1, y2 - y1);
            const { x, y, width, height } = box;

            const url: string | undefined = annot.url || annot.unsafeUrl || undefined;
            if (url) {
                result.push({ x, y, width, height, url });
                continue;
            }

            if (annot.dest) {
                try {
                    const dest = typeof annot.dest === "string"
                        ? await (pdfDocument as any).getDestination(annot.dest)
                        : annot.dest;
                    if (dest && dest[0]) {
                        const pageIndex = await (pdfDocument as any).getPageIndex(dest[0]);
                        result.push({ x, y, width, height, internalPage: pageIndex + 1 });
                    }
                } catch {
                    // Sprungziel konnte nicht aufgelöst werden -> Link ignorieren.
                }
            }
        }
        return result;
    }

    /**
     * Begrenzt die Größe einer Cache-Map: entfernt bei Überschreitung die
     * ältesten Einträge (Map behält Einfügereihenfolge bei). Reduziert den
     * Speicherverbrauch bei langen Dokumenten auf RAM-armen Geräten
     * (Mobile), auf Kosten einer erneuten Berechnung bei späterem erneutem
     * Zugriff auf eine verdrängte Seite. Der PDF-Dokument-Cache selbst
     * (documentCache) wird bewusst NICHT hier eingeschränkt, da ein
     * offenes pdf.js-Dokument nicht einfach "verworfen" werden kann,
     * solange andere Aufrufe noch darauf warten.
     */
    private capCacheSize<K, V>(map: Map<K, V>, max: number = PdfPageRenderer.MAX_CACHE_ENTRIES): void {
        while (map.size > max) {
            const oldestKey = map.keys().next().value;
            if (oldestKey === undefined) break;
            map.delete(oldestKey);
        }
    }

    /**
     * Rendert eine einzelne Seite eines referenzierten PDFs auf ein
     * Canvas-Element. pageNumber ist 1-basiert (wie im Frontmatter definiert).
     */
    async renderPageToCanvas(
        path: string, pageNumber: number, canvas: HTMLCanvasElement,
        options: RenderOptions = {}
    ): Promise<{ width: number; height: number }> {
        const scale = options.scale ?? 1.5;
        const rotate = options.rotate ?? 0;
        const pixelRatio = options.pixelRatio ?? 1;

        const pdfDocument = await this.getDocument(path);
        if (pageNumber < 1 || pageNumber > pdfDocument.numPages) { /* Fehler */ }

        const page = await pdfDocument.getPage(pageNumber);
        const cssViewport = page.getViewport({ scale, rotation: rotate });
        const bitmapViewport = pixelRatio === 1
            ? cssViewport
            : page.getViewport({ scale: scale * pixelRatio, rotation: rotate });

        canvas.width = bitmapViewport.width;
        canvas.height = bitmapViewport.height;

        const context = canvas.getContext("2d");
        if (!context) throw new Error("Konnte 2D-Rendering-Kontext des Canvas nicht erstellen.");

        await page.render({ canvasContext: context, viewport: bitmapViewport }).promise;
        return { width: cssViewport.width, height: cssViewport.height };
    }

    /**
 * Liefert nur die Viewport-Größe einer PDF-Seite (keine Rasterung),
 * für die Größenermittlung von Platzhaltern bei der Seiten-
 * Virtualisierung (siehe PdfComposeView.createPagePlaceholders).
 * Deutlich billiger als renderPageToCanvas, da kein Canvas gezeichnet wird.
 */
    async getPageViewportSize(
        path: string,
        pageNumber: number,
        scale: number,
        rotate: number = 0
    ): Promise<{ width: number; height: number }> {
        const key = `${path}#${pageNumber}#${scale}#${rotate}`;
        const cached = this.viewportSizeCache.get(key);
        if (cached) return cached;

        const pdfDocument = await this.getDocument(path);
        if (pageNumber < 1 || pageNumber > pdfDocument.numPages) {
            throw new Error(
                `Seite ${pageNumber} existiert nicht in "${path}" ` +
                `(Dokument hat ${pdfDocument.numPages} Seiten).`
            );
        }
        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({ scale, rotation: rotate });
        const size = { width: viewport.width, height: viewport.height };
        this.viewportSizeCache.set(key, size);
        this.capCacheSize(this.viewportSizeCache);
        return size;
    }

    /**
 * Prüft anhand von Stichproben am Seitenrand, ob der Hintergrund der
 * gerenderten Seite im Original eher dunkel ist. Liest nur Pixelwerte
 * zur Erkennung – verändert nichts.
 */
    detectBackgroundIsDark(path: string, pageNumber: number, canvas: HTMLCanvasElement): boolean {
        const key = `${path}#${pageNumber}`;
        const cached = this.darkDetectionCache.get(key);
        if (cached !== undefined) return cached;

        const w = canvas.width, h = canvas.height;
        if (w === 0 || h === 0) return false;

        const N = 32;
        const probe = document.createElement("canvas");
        probe.width = N;
        probe.height = N;
        const pctx = probe.getContext("2d", { willReadFrequently: true });
        if (!pctx) return false;
        pctx.drawImage(canvas, 0, 0, w, h, 0, 0, N, N);
        const data = pctx.getImageData(0, 0, N, N).data;

        const samplePoints: [number, number][] = [
            [0, 0], [N - 1, 0], [0, N - 1], [N - 1, N - 1],
            [N >> 1, 0], [N >> 1, N - 1], [0, N >> 1], [N - 1, N >> 1],
        ];
        let totalLuminance = 0;
        for (const [x, y] of samplePoints) {
            const i = (y * N + x) * 4;
            totalLuminance += (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
        }
        const isDark = (totalLuminance / samplePoints.length) < 0.5;
        this.darkDetectionCache.set(key, isDark);
        this.capCacheSize(this.darkDetectionCache, 5000);
        return isDark;
    }

    /**
 * Ermittelt die Bildbereiche (eingebettete Rasterbilder) einer PDF-Seite
 * in Bildschirmkoordinaten (inkl. Rotation), damit sie bei einer
 * Dark-/Lightmode-Invertierung des ROTIERTEN Canvas korrekt ausgenommen
 * werden können. `rotate` muss dieselbe Rotation sein, mit der die Seite
 * gerade auf dem Canvas gerendert wurde (page.rotate).
 */
    async getImageRegions(path: string, pageNumber: number, rotate: number = 0): Promise<ImageRegion[]> {
        const key = `${path}#${pageNumber}#${rotate}`;
        const cached = this.imageRegionCache.get(key);
        if (cached) return cached;

        const pdfDocument = await this.getDocument(path);
        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1, rotation: rotate });
        const opList = await page.getOperatorList();
        const OPS = (pdfjsLib as any).OPS;

        let transformStack: number[][] = [[1, 0, 0, 1, 0, 0]];
        const current = () => transformStack[transformStack.length - 1];
        const multiply = (a: number[], b: number[]): number[] => [
            a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
            a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
            a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
        ];

        const regions: ImageRegion[] = [];
        for (let i = 0; i < opList.fnArray.length; i++) {
            const fn = opList.fnArray[i];
            const args = opList.argsArray[i];
            if (fn === OPS.save) {
                transformStack.push([...current()]);
            } else if (fn === OPS.restore) {
                if (transformStack.length > 1) transformStack.pop();
            } else if (fn === OPS.transform) {
                transformStack[transformStack.length - 1] = multiply(current(), args as number[]);
            } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
                const m = current();
                const pdfCorners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => [
                    m[0] * x + m[2] * y + m[4],
                    m[1] * x + m[3] * y + m[5],
                ]);
                const viewportCorners = pdfCorners.map(([x, y]) => viewport.convertToViewportPoint(x, y));
                const xs = viewportCorners.map(c => c[0]);
                const ys = viewportCorners.map(c => c[1]);
                const minX = Math.min(...xs), maxX = Math.max(...xs);
                const minY = Math.min(...ys), maxY = Math.max(...ys);
                regions.push({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
            }
        }

        this.imageRegionCache.set(key, regions);
        this.capCacheSize(this.imageRegionCache);
        return regions;
    }

    /**
     * Gibt alle gecachten PDF-Dokumente frei. Muss beim Schließen der View
     * bzw. beim Entladen des Plugins aufgerufen werden, um Speicherlecks zu
     * vermeiden.
     */
    async destroy(): Promise<void> {
        for (const docPromise of this.documentCache.values()) {
            try {
                const doc = await docPromise;
                await doc.destroy();
            } catch (error) {
                console.error("PdfComposePlugin: Fehler beim Freigeben eines PDF-Dokuments", error);
            }
        }
        this.textCache.clear();
        this.documentCache.clear();
        this.darkDetectionCache.clear();
        this.imageRegionCache.clear();
        this.viewportSizeCache.clear();
    }
}


// Interface für ein Textelement mit Position
export interface TextItemWithPosition {
    str: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ImageRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface PdfLinkAnnotation {
    x: number;
    y: number;
    width: number;
    height: number;
    /** Externe URL (http/https/mailto/…), falls vorhanden. */
    url?: string;
    /** 1-basierte Zielseite IM QUELL-PDF, für interne Sprungziele (z. B. Inhaltsverzeichnis) ohne externe URL. */
    internalPage?: number;
}