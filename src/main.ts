import { Plugin, TFile, WorkspaceLeaf, Notice } from "obsidian";
import { PdfComposeView } from "./view/PdfComposeView";
import { VIEW_TYPE_PDFCOMPOSE } from "./view/constants";
import { isPdfComposeFile } from "./parser/FrontmatterParser";
import { PdfComposeSettings, DEFAULT_SETTINGS, PdfComposeSettingTab } from "./settings";
import { OcrTrainingCaptureModal } from "./ocr/OcrTrainingCaptureModal";

export default class PdfComposePlugin extends Plugin {
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

                // Ein einmaliger, gezielter Wechsel von PDF-Compose -> Markdown
                // darf nicht sofort durch den automatischen Compose-Wechsel
                // rückgängig gemacht werden.
                if (
                    this.suppressAutoSwitchFor &&
                    this.suppressAutoSwitchFor.leaf === leaf &&
                    this.suppressAutoSwitchFor.filePath === file.path
                ) {
                    this.suppressAutoSwitchFor = null;
                    return;
                }

                // Prüfen, ob der aktuelle Leaf bereits die PDF-Compose-Ansicht hat.
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

    onunload(): void {
        // Ressourcen werden von den Views selbst freigegeben
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