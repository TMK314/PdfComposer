import {
    Plugin, TFile, WorkspaceLeaf, Notice, CachedMetadata,
    MarkdownPostProcessorContext,
    MarkdownRenderer, MarkdownRenderChild, Platform, Component,
} from "obsidian";
import { PdfComposeView } from "./view/PdfComposeView";
import { VIEW_TYPE_PDFCOMPOSE } from "./view/constants";
import { isPdfComposeFile, parseFrontmatter } from "./parser/FrontmatterParser";
import { PdfComposeSettings, DEFAULT_SETTINGS, PdfComposeSettingTab } from "./settings";
import { OcrTrainingCaptureModal } from "./ocr/OcrTrainingCaptureModal";
import { PdfPageRenderer } from "./pdf/PdfPageRenderer";
import { exportPdfComposeToPdf } from "./pdf/PdfExporter";
import { ColorMode, PdfComposeDocument } from "./types";
import * as YAML from "js-yaml";

export default class PdfComposePlugin extends Plugin {
    private companionPdfDebounceTimers: Map<string, number> = new Map();
    private pdfComposeBlobUrls: Map<string, { mtime: number; url: string }> = new Map();
    private companionRenderer: PdfPageRenderer | null = null;

    private suppressAutoSwitchFor: {
        leaf: WorkspaceLeaf;
        filePath: string;
    } | null = null;
    public settings!: PdfComposeSettings;

    async onload(): Promise<void> {
        await this.loadSettings();
        this.addSettingTab(new PdfComposeSettingTab(this.app, this));
        this.registerView(VIEW_TYPE_PDFCOMPOSE, (leaf) => new PdfComposeView(leaf, this));

        // Command: create new PDF Compose file
        this.addCommand({
            id: "pdfcompose-create-new",
            name: "Create new PDF Compose file",
            callback: async () => {
                await this.createNewPdfComposeFile();
            },
        });

        // Ribbon icon: create new PDF Compose file
        this.addRibbonIcon("file-stack", "New PDF Compose file", async () => {
            await this.createNewPdfComposeFile();
        });

        // Automatischer Wechsel beim Öffnen einer PDF-Compose-Datei
        this.registerEvent(
            this.app.workspace.on("file-open", async (file) => {
                if (!file) return;

                const leaf = this.app.workspace.getLeaf(false);

                if (
                    this.suppressAutoSwitchFor &&
                    this.suppressAutoSwitchFor.leaf === leaf &&
                    this.suppressAutoSwitchFor.filePath === file.path
                ) {
                    this.suppressAutoSwitchFor = null;
                    return;
                }

                if (leaf.view.getViewType() === VIEW_TYPE_PDFCOMPOSE) return;

                await this.maybeSwitchToComposeView(file);
            })
        );

        // Command: switch to PDF Compose view
        this.addCommand({
            id: "pdfcompose-open-as-compose-view",
            name: "Open as PDF Compose view",
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return false;
                const cache = this.app.metadataCache.getFileCache(file);
                if (!isPdfComposeFile(cache)) return false;
                if (!checking) {
                    void this.maybeSwitchToComposeView(file, true);
                }
                return true;
            },
        });

        // Command: switch to Markdown view
        this.addCommand({
            id: "pdfcompose-open-as-markdown",
            name: "Open as Markdown",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(PdfComposeView);
                if (!view) return false;
                if (!checking) {
                    void this.openAsMarkdown();
                }
                return true;
            },
        });

        // Command: toggle fullscreen
        this.addCommand({
            id: "pdfcompose-toggle-fullscreen",
            name: "Toggle fullscreen",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(PdfComposeView);
                if (!view) return false;
                if (!checking) view.toggleFullscreen();
                return true;
            },
        });

        this.addCommand({
            id: "pdfcompose-ocr-training-capture",
            name: "OCR: Collect training data (own handwriting)",
            callback: async () => {
                const chars = await this.getOcrLabelChars();
                new OcrTrainingCaptureModal(this.app, chars).open();
            },
        });

        this.addCommand({
            id: "analyze-ocr-training-char-frequencies",
            name: "OCR: Output character frequency of exported training data as Markdown file",
            callback: async () => {
                const files = this.app.vault.getFiles().filter(f => f.name.startsWith("ocr-training-") && f.extension === "json");

                if (files.length === 0) {
                    new Notice("No exported OCR training data (ocr-training-*.json) found.");
                    return;
                }

                const charCounts = new Map<string, number>();

                for (const file of files) {
                    try {
                        const content = await this.app.vault.read(file);
                        const data = JSON.parse(content);

                        if (Array.isArray(data.samples)) {
                            for (const sample of data.samples) {
                                if (typeof sample.text === "string") {
                                    for (const ch of sample.text) {
                                        charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        console.error(`Error reading ${file.path}:`, err);
                    }
                }

                const sorted = Array.from(charCounts.entries())
                    .map(([char, count]) => ({ char, count }))
                    .sort((a, b) => a.count - b.count);

                const totalChars = sorted.reduce((sum, item) => sum + item.count, 0);

                let mdContent = `# OCR character frequency\n\n`;
                mdContent += `- **Created at:** ${new Date().toLocaleString()}\n`;
                mdContent += `- **Analyzed files:** ${files.length}\n`;
                mdContent += `- **Unique characters found:** ${sorted.length}\n`;
                mdContent += `- **Total characters captured:** ${totalChars}\n\n`;
                mdContent += `## Ascending frequencies\n\n`;
                mdContent += `| Character | Representation | Count |\n`;
                mdContent += `| :--- | :--- | :--- |\n`;

                for (const { char, count } of sorted) {
                    let displayChar = char;
                    if (char === " ") displayChar = "␣ (space)";
                    else if (char === "\n") displayChar = "\\n (line break)";
                    else if (char === "\t") displayChar = "\\t (tab)";
                    else if (char === "|") displayChar = "\\|";

                    const jsonRep = JSON.stringify(char);
                    mdContent += `| \`${displayChar}\` | \`${jsonRep}\` | ${count} |\n`;
                }

                const filename = `ocr-zeichenstatistik-${Date.now()}.md`;

                try {
                    const newFile = await this.app.vault.create(filename, mdContent);
                    new Notice(`Statistics saved: ${filename}`);

                    const leaf = this.app.workspace.getLeaf(false);
                    await leaf.openFile(newFile);
                } catch (err) {
                    console.error("Error creating statistics file:", err);
                    new Notice(`Error creating file: ${String(err)}`);
                }
            }
        });

        // File context menu
        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
                if (!(file instanceof TFile)) return;
                const cache = this.app.metadataCache.getFileCache(file);
                if (!isPdfComposeFile(cache)) return;
                menu.addItem((item) => {
                    item.setTitle("Open as PDF Compose")
                        .setIcon("file-stack")
                        .onClick(async () => {
                            await this.maybeSwitchToComposeView(file, true);
                        });
                });
            })
        );

        // ---------------------------------------------------------------
        // PDF-Compose-Dateien als PDF einbetten
        // ---------------------------------------------------------------

        // Command: Companion-PDF für die aktuell geöffnete Datei erzeugen
        this.addCommand({
            id: "pdfcompose-generate-companion-pdf",
            name: "Generate PDF companion for current PDF Compose file",
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return false;
                const cache = this.app.metadataCache.getFileCache(file);
                if (!isPdfComposeFile(cache)) return false;
                if (!checking) void this.generateCompanionPdf(file, true);
                return true;
            },
        });

        // Command: Companion-PDFs für ALLE PDF-Compose-Dateien erzeugen
        this.addCommand({
            id: "pdfcompose-generate-all-companion-pdfs",
            name: "Generate PDF companions for all PDF Compose files",
            callback: async () => { await this.generateAllCompanionPdfs(); },
        });

        // Primär: über metadataCache.changed (feuert NACH der Cache-Aktualisierung)
        this.registerEvent(
            this.app.metadataCache.on("changed", (file, _data, cache) => {
                if (!this.settings.generateCompanionPdf) return;
                if (!isPdfComposeFile(cache)) return;
                this.scheduleCompanionPdfGeneration(file);
            })
        );

        // Fallback: bei sehr frühen Änderungen greift vault.modify; Prüfung
        // erfolgt im Debounce über den Datei-INHALT (nicht über den Cache).
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (!(file instanceof TFile) || file.extension !== "md") return;
                if (!this.settings.generateCompanionPdf) return;
                this.scheduleCompanionPdfGeneration(file);
            })
        );

        // Neuanlage: Companion automatisch erzeugen, sobald die Datei steht.
        this.registerEvent(
            this.app.vault.on("create", (file) => {
                if (!(file instanceof TFile) || file.extension !== "md") return;
                if (!this.settings.generateCompanionPdf) return;
                this.scheduleCompanionPdfGeneration(file);
            })
        );

        // Post-Processor (Reading View): ![[Link]], ![[Link.md]] und
        // ![[Link.pdf]] (Fallback) auf PDF-Compose-Dateien als PDF rendern.
        this.registerMarkdownPostProcessor((el, ctx) => {
            void this.processEmbeddedPdfComposeFiles(el, ctx);
        });
    }

    /** Formatiert ein Datum als YYYY-MM-DD (lokal). */
    private formatDate(d: Date): string {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
    }

    /** Formatiert eine Uhrzeit als HH-MM-SS (lokal). */
    private formatTime(d: Date): string {
        const h = String(d.getHours()).padStart(2, "0");
        const mi = String(d.getMinutes()).padStart(2, "0");
        const s = String(d.getSeconds()).padStart(2, "0");
        return `${h}-${mi}-${s}`;
    }

    /**
     * Baut den Basis-Dateinamen aus der in den Einstellungen hinterlegten
     * Syntax. Platzhalter: $date, $time, $datetime. Unbekannte $…-Platzhalter
     * bleiben stehen. Ungültige Dateinamen-Zeichen werden ersetzt.
     */
    private buildNewFileName(now: Date): string {
        const template = (this.settings.newFileSyntax ?? "").trim();
        if (!template) return "Untitled";

        const replacements: Record<string, string> = {
            datetime: `${this.formatDate(now)} ${this.formatTime(now)}`,
            date: this.formatDate(now),
            time: this.formatTime(now),
        };

        // Längere Alternativen zuerst, damit "$date" nicht in "$datetime" hineinpasst.
        const result = template.replace(
            /\$(datetime|date|time)\b/g,
            (match, key: string) => replacements[key] ?? match,
        );

        const sanitized = result
            .replace(/[\\/:*?"<>|]/g, "-")
            .replace(/\s+/g, " ")
            .trim();

        return sanitized || "Untitled";
    }

    /**
     * Prüft, ob ein Pfad bereits belegt ist – auch case-insensitiv, da
     * Obsidians getAbstractFileByPath case-sensitiv arbeitet, das Dateisystem
     * auf macOS/Windows aber case-insensitiv ist (→ "Untitled.md" vs.
     * "untitled.md" würden sonst beim create() kollidieren).
     */
    private pathExistsCaseInsensitive(path: string): boolean {
        if (this.app.vault.getAbstractFileByPath(path)) return true;
        const lower = path.toLowerCase();
        for (const file of this.app.vault.getAllLoadedFiles()) {
            if (file.path.toLowerCase() === lower) return true;
        }
        return false;
    }

    /**
     * Findet einen freien Dateipfad: versucht zuerst `baseName.ext` und hängt
     * bei Kollision " 2", " 3", … an. Case-insensitiv.
     */
    private findFreeFilePath(folder: string, baseName: string, extension: string): string {
        const buildPath = (name: string) =>
            folder ? `${folder}/${name}.${extension}` : `${name}.${extension}`;

        let candidate = buildPath(baseName);
        if (!this.pathExistsCaseInsensitive(candidate)) return candidate;

        let counter = 2;
        while (true) {
            candidate = buildPath(`${baseName} ${counter}`);
            if (!this.pathExistsCaseInsensitive(candidate)) return candidate;
            counter++;
        }
    }

    private async createNewPdfComposeFile(): Promise<void> {
        const folder = this.app.workspace.getActiveFile()?.parent?.path || "";
        const now = new Date();
        const baseName = this.buildNewFileName(now);

        const lines = [
            "---",
            "pdfcompose: true",
            "version: 1",
        ];
        if (this.settings.saveCreatedDate !== false) {
            lines.push(`created: ${now.toISOString()}`);
        }
        lines.push("sources: {}", "pages: []", "annotations: {}", "---", "", "");
        const content = lines.join("\n");

        const MAX_ATTEMPTS = 1000;
        let file: TFile | null = null;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const suffix = attempt === 0 ? "" : ` ${attempt + 1}`;
            const candidateName = `${baseName}${suffix}.md`;
            const candidatePath = folder ? `${folder}/${candidateName}` : candidateName;
            try {
                file = await this.app.vault.create(candidatePath, content);
                break;
            } catch (err) {
                if (/file already exists/i.test(String(err))) continue;
                throw err;
            }
        }

        if (!file) {
            new Notice(`Could not create a new file (all names taken).`);
            return;
        }

        await this.app.workspace.getLeaf().setViewState({
            type: VIEW_TYPE_PDFCOMPOSE,
            state: { file: file.path },
            active: true,
        });
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    // ============================================================
    //  COMPANION-PDF & .lpdf
    // ============================================================

    private getCompanionRenderer(): PdfPageRenderer {
        if (!this.companionRenderer) {
            this.companionRenderer = new PdfPageRenderer(this.app.vault);
        }
        return this.companionRenderer;
    }

    private async readDocumentFreshFromFile(file: TFile): Promise<PdfComposeDocument> {
        try {
            const raw = await this.app.vault.read(file);
            const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (match) {
                const fm = YAML.load(match[1]) as any;
                if (fm && typeof fm === "object") {
                    return parseFrontmatter({ frontmatter: fm } as unknown as CachedMetadata);
                }
            }
        } catch { /* fallback */ }
        return parseFrontmatter(this.app.metadataCache.getFileCache(file));
    }

    private companionPdfColorMode(): ColorMode {
        const m = (this.settings.companionPdfColorMode || "original") as ColorMode;
        return (m === "light" || m === "dark" || m === "original") ? m : "original";
    }

    /** Berechnet den Companion-Pfad (nur noch .pdf) aus dem Quellpfad. */
    private companionPath(sourceFile: TFile): string {
        const configured = (this.settings.companionPdfFolder || "").trim().replace(/\/+$/, "");
        const folder = configured || (sourceFile.parent?.path ?? "");
        return folder
            ? `${folder}/${sourceFile.basename}.pdf`
            : `${sourceFile.basename}.pdf`;
    }

    private scheduleCompanionPdfGeneration(file: TFile): void {
        const existing = this.companionPdfDebounceTimers.get(file.path);
        if (existing !== undefined) window.clearTimeout(existing);
        const timer = window.setTimeout(async () => {
            this.companionPdfDebounceTimers.delete(file.path);
            // Robust: Datei-Inhalt prüfen, NICHT den ggf. veralteten Cache.
            try {
                const raw = await this.app.vault.read(file);
                const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
                if (!fmMatch) return;
                let fm: any;
                try { fm = YAML.load(fmMatch[1]); } catch { return; }
                if (!fm || typeof fm !== "object" || fm.pdfcompose !== true) return;
            } catch { return; }
            await this.generateCompanionPdf(file, false);
        }, 2000);
        this.companionPdfDebounceTimers.set(file.path, timer);
    }

    public async generateCompanionPdf(file: TFile, notify: boolean): Promise<void> {
        try {
            if (file.extension !== "md") return;
            const doc = await this.readDocumentFreshFromFile(file);
            const renderer = this.getCompanionRenderer();
            const bytes = await exportPdfComposeToPdf(
                this.app, file, doc, renderer,
                { colorMode: this.companionPdfColorMode() },
            );

            // -------- Companion .pdf schreiben --------
            const pdfPath = this.companionPath(file);
            await this.ensureFolderForPath(pdfPath);
            const pdfBuffer = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(pdfBuffer).set(bytes);
            const existingPdf = this.app.vault.getAbstractFileByPath(pdfPath);
            if (existingPdf instanceof TFile) {
                await this.app.vault.modifyBinary(existingPdf, pdfBuffer);
            } else {
                await this.app.vault.createBinary(pdfPath, pdfBuffer);
            }

            // Blob-Cache invalidieren (inkl. seitenbeschränkter Varianten),
            // damit Embeds neu rendern.
            this.invalidateBlobUrlsFor(file.path);

            if (notify) new Notice(`PDF companion generated: ${pdfPath}`);
        } catch (error) {
            console.error("PDF Compose: companion generation failed for", file.path, error);
            if (notify) new Notice(`PDF companion generation failed: ${String(error)}`);
        }
    }

    private async ensureFolderForPath(vaultPath: string): Promise<void> {
        const folder = vaultPath.split("/").slice(0, -1).join("/");
        if (!folder) return;
        if (!this.app.vault.getAbstractFileByPath(folder)) {
            try { await this.app.vault.createFolder(folder); } catch { /* existiert bereits */ }
        }
    }

    public async generateAllCompanionPdfs(): Promise<void> {
        const files = this.app.vault.getMarkdownFiles().filter((f) => {
            const cache = this.app.metadataCache.getFileCache(f);
            return isPdfComposeFile(cache);
        });
        if (files.length === 0) {
            new Notice("No PDF Compose files found.");
            return;
        }
        for (const file of files) {
            await this.generateCompanionPdf(file, false);
        }
        new Notice(`Generated ${files.length} PDF companion(s) with .lpdf markers.`);
    }

    // ============================================================
    //  BLOB-URL-CACHE (auch vom Post-Processor genutzt)
    // ============================================================

    /**
 * Stellt sicher, dass die Companion-.pdf zur übergebenen PDF-Compose-Datei
 * existiert. Generiert NUR dann neu, wenn die Datei fehlt.
 *
 * Wichtig für Mobile: Eine Regeneration bei jedem Öffnen würde auf Android
 * jedes Mal den kompletten PDF-Export (pdf-lib + Rendering aller Seiten)
 * ausführen und die UI mehrere Sekunden blockieren. Aktualisierungen bei
 * Änderungen übernimmt der modify-Handler, sofern die Option
 * "Auto-generate companion PDFs on save" aktiviert ist.
 */
    private async ensureCompanionPdfUpToDate(file: TFile): Promise<string> {
        const pdfPath = this.companionPath(file);
        const existingPdf = this.app.vault.getAbstractFileByPath(pdfPath);
        if (existingPdf instanceof TFile) {
            return pdfPath;
        }
        await this.generateCompanionPdf(file, false);
        return pdfPath;
    }

    /**
 * Parst eine Seitenbereichs-Angabe wie "1,2-4" aus dem Embed-Alias.
 * Gibt null zurück, wenn die Angabe nicht dem erwarteten Format entspricht
 * (dann werden alle Seiten angezeigt).
 */
    private parsePageRange(spec: string): number[] | null {
        const trimmed = spec.trim();
        if (!trimmed) return null;
        // Nur Zahlen, Kommas und Bindestriche (mit optionalen Leerzeichen)
        if (!/^\s*\d+\s*(-\s*\d+\s*)?(,\s*\d+\s*(-\s*\d+\s*)?)*$/.test(trimmed)) {
            return null;
        }
        const pages = new Set<number>();
        for (const part of trimmed.split(",")) {
            const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
            if (!m) continue;
            const a = parseInt(m[1], 10);
            const b = m[2] !== undefined ? parseInt(m[2], 10) : a;
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            for (let i = lo; i <= hi; i++) pages.add(i);
        }
        return pages.size > 0 ? Array.from(pages).sort((x, y) => x - y) : null;
    }

    /** Entfernt alle gecachten Blob-URLs (inkl. seitenbeschränkter Varianten) einer Datei. */
    private invalidateBlobUrlsFor(filePath: string): void {
        const toDelete: string[] = [];
        for (const key of this.pdfComposeBlobUrls.keys()) {
            if (key === filePath || key.startsWith(filePath + "#")) {
                toDelete.push(key);
            }
        }
        for (const key of toDelete) {
            const entry = this.pdfComposeBlobUrls.get(key);
            if (entry) {
                try { URL.revokeObjectURL(entry.url); } catch { /* ignore */ }
                this.pdfComposeBlobUrls.delete(key);
            }
        }
    }

    private async getComposeAsPdfBlobUrl(file: TFile, pageIndices?: number[]): Promise<string> {
        const stat = await this.app.vault.adapter.stat(file.path);
        const mtime = stat?.mtime ?? 0;
        // Cache-Key enthält die Seitenauswahl, damit unterschiedliche
        // Beschränkungen (z. B. eine Einbettung mit "1-3" und eine ohne)
        // nicht denselben Blob teilen.
        const rangeSuffix = pageIndices && pageIndices.length > 0
            ? "#" + pageIndices.join(",")
            : "";
        const cacheKey = file.path + rangeSuffix;
        const cached = this.pdfComposeBlobUrls.get(cacheKey);
        if (cached && cached.mtime === mtime) return cached.url;

        const doc = await this.readDocumentFreshFromFile(file);
        const renderer = this.getCompanionRenderer();

        // pageIndices (1-basiert) in pageIds (Dokument-IDs) übersetzen.
        let pageIds: string[] | undefined;
        if (pageIndices && pageIndices.length > 0) {
            const ids = pageIndices
                .filter(n => n >= 1 && n <= doc.pages.length)
                .map(n => doc.pages[n - 1].id);
            if (ids.length > 0) pageIds = ids;
        }

        const bytes = await exportPdfComposeToPdf(
            this.app, file, doc, renderer,
            { colorMode: this.companionPdfColorMode(), pageIds },
        );
        const pdfBuffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(pdfBuffer).set(bytes);
        const blob = new Blob([pdfBuffer], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);

        if (cached) URL.revokeObjectURL(cached.url);
        this.pdfComposeBlobUrls.set(cacheKey, { mtime, url });
        return url;
    }

    // ============================================================
    //  POST-PROCESSOR (Reading View)
    // ============================================================

    /**
 * Eigener, minimaler PDF-Viewer für den Embed-Kontext auf Mobile.
 *
 * Warum nicht der native Obsidian-PDF-Embed?
 *  - Obsidian rendert PDFs fit-to-width → horizontaler Scroll ist sinnlos,
 *    weil es nichts zu scrollen gibt.
 *  - Der mobile Embed-Container fängt Pinch-Gesten ab, bevor der PDF-Viewer
 *    sie sieht → Zoom ist nicht möglich.
 *
 * Dieser Viewer:
 *  - rendert Seiten selbst mit pdf.js auf <canvas>-Elemente (natürliche
 *    Größe, Seiten untereinander),
 *  - benutzt einen normalen `overflow: auto`-Container (Horizontal- und
 *    Vertikalscroll funktionieren, sobald gezoomt wurde),
 *  - implementiert Pinch-Zoom über `zoom`-CSS (Chromium-sicher, skaliert
 *    Layout und damit auch die Scroll-Dimensionen).
 */
    private async renderCustomPdfViewer(
        host: HTMLElement,
        pdfPath: string,
        ctx: MarkdownPostProcessorContext,
        pageIndices: number[] | null,   // NEU
    ): Promise<void> {
        const renderer = this.getCompanionRenderer();

        let numPages = 0;
        try {
            numPages = await renderer.getPageCount(pdfPath);
        } catch (err) {
            host.createEl("div", {
                cls: "pdfcompose-embed-error",
                text: `Failed to read PDF: ${String(err)}`,
            });
            return;
        }

        // Seitenauswahl bestimmen: entweder die gewünschten Seiten
        // (1-basiert, gefiltert auf den gültigen Bereich) oder alle.
        const pagesToRender: number[] = pageIndices && pageIndices.length > 0
            ? pageIndices.filter(n => n >= 1 && n <= numPages)
            : Array.from({ length: numPages }, (_, i) => i + 1);

        if (pagesToRender.length === 0) {
            host.createEl("div", {
                cls: "pdfcompose-embed-error",
                text: "No pages in the specified range.",
            });
            return;
        }

        const canvasWidth = 892;
        const canvasHeight = 1263;

        const scroll = host.createDiv({ cls: "pdfcompose-pdf-scroll" });
        const pages = scroll.createDiv({ cls: "pdfcompose-pdf-pages" });

        // ---------- Lazy Rendering ----------
        const io = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const canvas = entry.target as HTMLCanvasElement;
                const pageNum = parseInt(canvas.dataset.pageNum ?? "0", 10);
                if (pageNum <= 0) continue;
                io.unobserve(canvas);
                void renderer.renderPageToCanvas(pdfPath, pageNum, canvas, {
                    scale: 1.5,
                    pixelRatio: 1,
                }).catch(() => {
                    const parent = canvas.parentElement;
                    if (parent) {
                        parent.createEl("div", {
                            cls: "pdfcompose-pdf-page-error",
                            text: `Page ${pageNum} failed to render`,
                        });
                    }
                });
            }
        }, { root: scroll, rootMargin: "400px" });

        for (const pageNum of pagesToRender) {
            const pageWrapper = pages.createDiv({ cls: "pdfcompose-pdf-page" });
            const canvas = pageWrapper.createEl("canvas", { cls: "pdfcompose-pdf-page-canvas" });
            canvas.style.width = `${canvasWidth}px`;
            canvas.style.height = `${canvasHeight}px`;
            canvas.width = 100;
            canvas.height = Math.round(100 * (canvasHeight / canvasWidth));
            const pctx = canvas.getContext("2d");
            if (pctx) {
                pctx.fillStyle = "#ffffff";
                pctx.fillRect(0, 0, canvas.width, canvas.height);
            }
            canvas.dataset.pageNum = String(pageNum);
            io.observe(canvas);
        }

        // ---------- Zoom-Zustand (unverändert) ----------
        let zoom = 1;
        let fitZoom = 1;

        const applyZoom = () => {
            pages.setCssStyles({ zoom: zoom.toString() } as any);
        };

        const computeFitZoom = () => {
            const w = scroll.clientWidth;
            if (w > 0) fitZoom = w / canvasWidth;
            return fitZoom;
        };

        const fitInitial = () => {
            const w = scroll.clientWidth;
            if (w > 0) {
                fitZoom = w / canvasWidth;
                zoom = fitZoom;
                applyZoom();
            }
        };
        window.requestAnimationFrame(fitInitial);

        const ro = new ResizeObserver(() => {
            const prevFit = fitZoom;
            const newFit = computeFitZoom();
            if (Math.abs(zoom - prevFit) < 0.001) {
                zoom = newFit;
                applyZoom();
            }
        });
        ro.observe(scroll);

        const cleanupPinch = this.attachPinchZoom(
            scroll,
            () => zoom,
            () => fitZoom,
            (newZoom) => { zoom = newZoom; applyZoom(); },
        );

        class ViewerLifecycle extends MarkdownRenderChild {
            constructor(el: HTMLElement, private cleanup: () => void) {
                super(el);
            }
            onunload(): void { this.cleanup(); }
        }
        const child = new ViewerLifecycle(scroll, () => {
            io.disconnect();
            ro.disconnect();
            cleanupPinch();
        });
        ctx.addChild(child);
    }

    /**
     * Pinch-Zoom auf einem Element mit `overflow: auto` und einer
     * CSS-`zoom`-skalierten Inhalts-Ebene.
     *
     * Gestenlogik:
     *  - Ein Finger → native Scroll-Geste (touch-action: pan-x pan-y).
     *  - Zwei Finger → eigene Zoom-Berechnung, native Geste wird geblockt.
     *
     * Rückgabe ist eine Cleanup-Funktion, die alle Listener entfernt.
     */
    private attachPinchZoom(
        scroll: HTMLElement,
        getZoom: () => number,
        getFitZoom: () => number,
        setZoom: (z: number) => void,
    ): () => void {
        let initialDist = 0;
        let initialZoom = 1;
        let initialScrollLeft = 0;
        let initialScrollTop = 0;
        let initialCenterClientX = 0;
        let initialCenterClientY = 0;

        const onTouchStart = (e: TouchEvent) => {
            if (e.touches.length !== 2) return;
            const t1 = e.touches[0];
            const t2 = e.touches[1];
            initialDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
            initialZoom = getZoom();
            initialScrollLeft = scroll.scrollLeft;
            initialScrollTop = scroll.scrollTop;
            initialCenterClientX = (t1.clientX + t2.clientX) / 2;
            initialCenterClientY = (t1.clientY + t2.clientY) / 2;
        };

        const onTouchMove = (e: TouchEvent) => {
            if (e.touches.length !== 2 || initialDist <= 0) return;
            e.preventDefault();

            const t1 = e.touches[0];
            const t2 = e.touches[1];
            const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
            const factor = dist / initialDist;

            const fit = getFitZoom();
            const minZoom = fit;
            const maxZoom = Math.max(fit * 3, fit + 0.5);
            const newZoom = Math.max(minZoom, Math.min(maxZoom, initialZoom * factor));

            const rect = scroll.getBoundingClientRect();
            const currentCenterX = (t1.clientX + t2.clientX) / 2 - rect.left;
            const currentCenterY = (t1.clientY + t2.clientY) / 2 - rect.top;

            // Content-Koordinate des ANFÄNGLICHEN Pinch-Zentrums:
            const contentX = (initialCenterClientX - rect.left + initialScrollLeft) / initialZoom;
            const contentY = (initialCenterClientY - rect.top + initialScrollTop) / initialZoom;

            // Zoom anwenden (Layout ändert sich, Scroll-Dimensionen ändern sich)
            setZoom(newZoom);

            // Danach Scroll so setzen, dass der Content-Punkt unter dem
            // AKTUELLEN Pinch-Zentrum liegt – so kann der Nutzer während des
            // Zoomens auch verschieben.
            scroll.scrollLeft = contentX * newZoom - currentCenterX;
            scroll.scrollTop = contentY * newZoom - currentCenterY;
        };

        const onTouchEnd = (e: TouchEvent) => {
            if (e.touches.length < 2) {
                initialDist = 0;
            }
        };

        scroll.addEventListener("touchstart", onTouchStart, { passive: true });
        scroll.addEventListener("touchmove", onTouchMove, { passive: false });
        scroll.addEventListener("touchend", onTouchEnd, { passive: true });
        scroll.addEventListener("touchcancel", onTouchEnd, { passive: true });

        return () => {
            scroll.removeEventListener("touchstart", onTouchStart);
            scroll.removeEventListener("touchmove", onTouchMove);
            scroll.removeEventListener("touchend", onTouchEnd);
            scroll.removeEventListener("touchcancel", onTouchEnd);
        };
    }

    /**
 * Parst den Embed-Alias. Format:
 *   "Beschriftung"            → nur Alias, alle Seiten
 *   "Beschriftung#1,2-4"      → Alias "Beschriftung" + Seitenauswahl
 *   "#1,2-4"                  → nur Seitenauswahl (kein Alias)
 *   ""                        → weder Alias noch Seitenauswahl
 *
 * Das '#'-Trennzeichen ist nötig, weil ein Alias selbst Ziffern und
 * Kommas enthalten kann. Ist der Teil nach '#' keine gültige
 * Seitenangabe, wird er als Bestandteil der Seitenauswahl verworfen
 * und alle Seiten angezeigt (Alias bleibt erhalten).
 */
    private parseEmbedAlias(raw: string): { alias: string; pageIndices: number[] | null } {
        const hashIndex = raw.indexOf("#");
        if (hashIndex === -1) {
            return { alias: raw.trim(), pageIndices: null };
        }
        const alias = raw.slice(0, hashIndex).trim();
        const rangePart = raw.slice(hashIndex + 1).trim();
        return { alias, pageIndices: this.parsePageRange(rangePart) };
    }

    private async processEmbeddedPdfComposeFiles(
        el: HTMLElement,
        ctx: MarkdownPostProcessorContext,
    ): Promise<void> {
        const embeds = el.querySelectorAll<HTMLElement>(".internal-embed[src]");
        for (const embed of Array.from(embeds)) {
            if (embed.classList.contains("pdfcompose-embed")) continue;
            const src = embed.getAttribute("src");
            if (!src) continue;

            let file = this.app.metadataCache.getFirstLinkpathDest(src, ctx.sourcePath);

            // ![[Link.pdf]] → Fallback auf Link.md (PDF Compose)
            if (!file && src.toLowerCase().endsWith(".pdf")) {
                const mdSrc = src.slice(0, -4) + ".md";
                file = this.app.metadataCache.getFirstLinkpathDest(mdSrc, ctx.sourcePath);
            }

            if (!(file instanceof TFile)) continue;
            if (file.extension !== "md") continue;
            const cache = this.app.metadataCache.getFileCache(file);
            if (!isPdfComposeFile(cache)) continue;

            embed.addClass("pdfcompose-embed");

            // Alias aus dem Embed-Text lesen. Obsidian legt den Alias je nach
            // Dateityp in alt, title oder im Textinhalt ab – wir prüfen alle drei.
            const altText =
                (embed.getAttribute("alt") ?? "").trim() ||
                (embed.getAttribute("title") ?? "").trim() ||
                (embed.textContent ?? "").trim();
            const { alias, pageIndices } = this.parseEmbedAlias(altText);

            embed.addClass("pdfcompose-embed");
            embed.empty();

            // Alias als dezente Beschriftung über dem PDF anzeigen, sofern vorhanden.
            // So bleibt eine evtl. gesetzte Beschriftung sichtbar, ohne dass sie als
            // Seitenangabe fehlinterpretiert wird.
            if (alias) {
                const caption = embed.createDiv({ cls: "pdfcompose-embed-caption" });
                caption.setText(alias);
                caption.setCssStyles({
                    marginBottom: "6px",
                    fontSize: "0.85em",
                    opacity: "0.75",
                    fontStyle: "italic",
                });
            }

            if (Platform.isMobile) {
                const loading = embed.createDiv({
                    cls: "pdfcompose-embed-loading",
                    text: "Rendering PDF…",
                });
                try {
                    const pdfPath = await this.ensureCompanionPdfUpToDate(file);
                    loading.remove();

                    const viewerHost = embed.createDiv({ cls: "pdfcompose-embed-viewer" });
                    await this.renderCustomPdfViewer(viewerHost, pdfPath, ctx, pageIndices);

                    // Fallback-Aktion: native PDF-Ansicht mit voller Scroll/Zoom-
                    // Funktionalität öffnen (z. B. für sehr große PDFs oder wenn
                    // Textselektion gebraucht wird).
                    const actionRow = embed.createDiv({ cls: "pdfcompose-embed-actions" });
                    const openLink = actionRow.createEl("a", {
                        cls: "pdfcompose-embed-openlink",
                        text: "Open full-screen ↗",
                        href: "#",
                    });
                    openLink.addEventListener("click", (e) => {
                        e.preventDefault();
                        const target = this.app.vault.getAbstractFileByPath(pdfPath);
                        if (target instanceof TFile) {
                            void this.app.workspace.getLeaf(false).openFile(target);
                        }
                    });
                } catch (error) {
                    loading.remove();
                    embed.createEl("div", {
                        cls: "pdfcompose-embed-error",
                        text: `Failed to render PDF on mobile: ${String(error)}`,
                    });
                }
            } else {
                // ----------------------------------------------------------
                // Desktop: iframe mit Blob-URL (schnell, erzeugt keine
                // Datei auf der Festplatte).
                // ----------------------------------------------------------
                const loading = embed.createDiv({
                    cls: "pdfcompose-embed-loading",
                    text: "Rendering PDF…",
                });
                try {
                    const url = await this.getComposeAsPdfBlobUrl(file, pageIndices ?? undefined);
                    loading.remove();
                    const iframe = embed.createEl("iframe", { cls: "pdfcompose-embed-iframe" });
                    iframe.src = url;
                    iframe.setAttribute(
                        "title",
                        alias ? `${alias} – ${file.basename}` : `PDF: ${file.basename}`,
                    );
                } catch (error) {
                    loading.remove();
                    embed.createEl("div", {
                        cls: "pdfcompose-embed-error",
                        text: `Failed to render PDF Compose file: ${String(error)}`,
                    });
                }
            }
        }
    }

    async onunload(): Promise<void> {
        for (const { url } of this.pdfComposeBlobUrls.values()) {
            try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        }
        this.pdfComposeBlobUrls.clear();

        for (const timer of this.companionPdfDebounceTimers.values()) {
            window.clearTimeout(timer);
        }
        this.companionPdfDebounceTimers.clear();

        if (this.companionRenderer) {
            await this.companionRenderer.destroy();
            this.companionRenderer = null;
        }
    }

    public async maybeSwitchToComposeView(file: TFile, force = false): Promise<void> {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!isPdfComposeFile(cache)) return;

        const leaf = this.app.workspace.getLeaf(false);
        if (!force && leaf.view.getViewType() === VIEW_TYPE_PDFCOMPOSE) return;

        await leaf.setViewState({
            type: VIEW_TYPE_PDFCOMPOSE,
            state: { file: file.path },
            active: true,
        });
    }

    public async openAsMarkdown(): Promise<void> {
        const view = this.app.workspace.getActiveViewOfType(PdfComposeView);
        if (!view) return;

        const file = view.currentFile;
        if (!(file instanceof TFile)) return;

        const leaf = view.leaf;

        // Genau diesen Wechsel auf Markdown einmalig von der
        // automatischen PDF-Compose-Erkennung ausnehmen.
        this.suppressAutoSwitchFor = {
            leaf,
            filePath: file.path,
        };

        try {
            await leaf.setViewState({
                type: "markdown",
                state: {
                    file: file.path,
                },
                active: true,
            });
        } catch (error) {
            // Falls der Wechsel selbst fehlschlägt, darf die Sperre
            // nicht für einen späteren Dateiwechsel bestehen bleiben.
            if (
                this.suppressAutoSwitchFor?.leaf === leaf &&
                this.suppressAutoSwitchFor?.filePath === file.path
            ) {
                this.suppressAutoSwitchFor = null;
            }

            throw error;
        }
    }

    private async getOcrLabelChars(): Promise<string[] | null> {
        if (!this.settings.ocrLabelsPath) return null;
        try {
            const raw = await this.app.vault.adapter.read(this.settings.ocrLabelsPath);
            return raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        } catch {
            return null;
        }
    }
}