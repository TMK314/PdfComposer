import {
    Plugin, TFile, WorkspaceLeaf, Notice, CachedMetadata,
    MarkdownPostProcessorContext,
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

            // Blob-Cache invalidieren, damit Embeds neu rendern
            const cachedUrl = this.pdfComposeBlobUrls.get(file.path);
            if (cachedUrl) {
                URL.revokeObjectURL(cachedUrl.url);
                this.pdfComposeBlobUrls.delete(file.path);
            }

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

    private async getComposeAsPdfBlobUrl(file: TFile): Promise<string> {
        const stat = await this.app.vault.adapter.stat(file.path);
        const mtime = stat?.mtime ?? 0;
        const cached = this.pdfComposeBlobUrls.get(file.path);
        if (cached && cached.mtime === mtime) return cached.url;

        const doc = await this.readDocumentFreshFromFile(file);
        const renderer = this.getCompanionRenderer();
        const bytes = await exportPdfComposeToPdf(
            this.app, file, doc, renderer,
            { colorMode: this.companionPdfColorMode() },
        );
        const pdfBuffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(pdfBuffer).set(bytes);
        const blob = new Blob([pdfBuffer], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);

        if (cached) URL.revokeObjectURL(cached.url);
        this.pdfComposeBlobUrls.set(file.path, { mtime, url });
        return url;
    }

    // ============================================================
    //  POST-PROCESSOR (Reading View)
    // ============================================================

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
            embed.empty();

            const loading = embed.createDiv({
                cls: "pdfcompose-embed-loading",
                text: "Rendering PDF…",
            });
            try {
                const url = await this.getComposeAsPdfBlobUrl(file);
                loading.remove();
                const iframe = embed.createEl("iframe", { cls: "pdfcompose-embed-iframe" });
                iframe.src = url;
                iframe.setAttribute("title", `PDF: ${file.basename}`);
            } catch (error) {
                loading.remove();
                embed.createEl("div", {
                    cls: "pdfcompose-embed-error",
                    text: `Failed to render PDF Compose file: ${String(error)}`,
                });
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