// OcrTrainingCaptureModal.ts
//
// Standalone tool for collecting personalized handwriting training data:
// displays given words one after another, lets them be traced in a fixed
// writing field, and stores the RAW (unsimplified) stylus points together
// with the correct text.

import { App, Modal, Notice } from "obsidian";

export interface CapturedPoint { x: number; y: number; t: number; }
export type CapturedStroke = CapturedPoint[];
export interface CapturedWordSample { text: string; strokes: CapturedStroke[]; }

export interface NamedWordList {
    id: string;
    name: string;
    words: string[];
}

/** Dictionary of available word lists */
export const WORD_LISTS: Record<string, NamedWordList> = {
    standard: {
        id: "standard",
        name: "Standard German & basic characters",
        words: [
            "Haus", "Baum", "Straße", "Wasser", "Freund", "Zeit", "Arbeit", "Schule",
            "Garten", "Fenster", "Buch", "Tisch", "Stuhl", "Küche", "Wetter", "Montag",
            "Januar", "Dezember", "Straßenbahn", "Universität", "Bahnhof", "Flughafen",
            "12345", "3,14", "Preis:", "9,99€", "Größe", "Übung", "Äpfel", "Öl", "weiß",
            "groß", "München", "Zürich", "1990", "über", "können", "möglich", "häufig",
        ]
    },
    extended: {
        id: "extended",
        name: "Extended (German, English, numbers & pangrams)",
        words: [
            "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "12", "42", "100", "365", "1337", "1984", "2026", "8086", "90210", "314159",
            "Auto", "Baum", "Clown", "Dschungel", "Elefant", "Flamingo", "Giraffe", "Haus", "Igel", "Jaguar",
            "Krokodil", "Leopard", "Maus", "Nashorn", "Ochse", "Panther", "Qualle", "Rhythmus", "Sonne", "Tiger", "Uhu", "Vampir",
            "Wasser", "Xylophon", "Yacht", "Zebra", "quer", "mixen", "typisch", "extrem", "verifizieren", "chillen",
            "wachsen", "boxen", "jagen", "zynisch", "komplex", "mystisch", "quirlig", "fliegen", "blicken", "zaubern",
            "The", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "Sphinx", "of",
            "black", "quartz", "judge", "my", "vow", "Pack", "box", "with", "five", "dozen", "liquor", "jugs"
        ]
    },
    umlaute: {
        id: "umlaute",
        name: "Umlauts & sharp S",
        words: [
            "Ärger", "Öl", "Übung", "Bär", "Höhle", "Mühe", "Straße", "groß", "schön",
            "Mädchen", "Käse", "Böse", "Müller", "Grün", "Hände", "Töne", "Träume",
            "Häuser", "Körper", "Würfel", "lösen", "führen", "erzählen", "wärmen",
            "können", "möchten", "glücklich", "schützen", "süß", "blöd", "früh",
            "zählen", "wählen", "hören", "stören", "üben", "küssen", "grüßen",
            "genießen", "heißen", "reißen", "beißen", "schließen", "gießen", "fließen",
            "verlieren", "Vögel", "Räuber", "Hüte", "Käfer", "Möhre", "Röhre",
            "Würze", "ärgern", "böswillig", "trüben", "vertrösten", "versöhnen"
        ]
    },
    sonderzeichen: {
        id: "sonderzeichen",
        name: "Special characters & currencies",
        words: [
            "Uhr:", "12:00",
            "Preis:", "19,99€",
            "Zeit:", "10:30",
            "Datum:", "01.01.2026",
            "Konto:", "1234,56€",
            "Rabatt:", "20%",
            "Summe:", "100,00€",
            "MwSt:", "19%",
            "Guthaben:", "50,00€",
            "Zahlung:", "9,99€",
            "Betrag:", "0,99€",
            "Kosten:", "12,75€",
            "Umsatz:", "1000,50€",
            "Gehalt:", "2500,00€",
            "Miete:", "800,00€",
            "Sprit:", "1,50€",
            "Bier:", "3,50€",
            "Kaffee:", "2,80€",
            "Brötchen:", "0,80€",
            "Käse:", "3,90€",
            "Milch:", "1,20€",
            "Brot:", "2,30€",
            "Butter:", "1,80€",
            "Eier:", "2,40€",
            "Äpfel:", "2,50€",
            "Bananen:", "1,90€",
            "Orangen:", "2,70€",
            "Tomaten:", "3,20€",
            "Salat:", "1,60€",
            "Kartoffeln:", "1,10€",
            "Zwiebeln:", "0,90€",
            "Knoblauch:", "0,70€",
            "Pfeffer:", "2,10€",
            "Salz:", "0,50€",
            "Zucker:", "1,30€",
            "Mehl:", "0,60€",
            "Öl:", "2,80€",
            "Essig:", "1,40€",
            "Senf:", "1,00€",
            "Ketchup:", "2,20€",
            "Mayo:", "1,80€",
            "Fisch:", "4,50€",
            "Fleisch:", "5,90€",
            "Geflügel:", "6,20€",
            "Schinken:", "4,10€"
        ]
    },
    grossbuchstaben: {
        id: "grossbuchstaben",
        name: "Uppercase letters & acronyms",
        words: [
            "CD", "DVD", "USA", "UK", "EU", "UNO", "NASA", "CIA", "FBI", "WHO",
            "IMF", "NATO", "EURO", "DIN", "ISO", "AIDS", "HIV", "HTML", "CSS",
            "PHP", "JSON", "XML", "PDF", "PNG", "JPG", "GIF", "MP3", "MP4",
            "AVI", "MOV", "EXE", "BAT", "CMD", "TXT", "DOC", "XLS", "PPT",
            "MDB", "SQL", "TCP", "IP", "DNS", "HTTP", "FTP", "SMTP", "IMAP",
            "POP3", "SSH", "SSL", "TLS", "RSA", "AES", "DES", "MD5", "SHA",
            "RIPEMD", "GNU", "GPL", "MIT", "BSD", "APACHE", "MYSQL", "POSTGRES",
            "MONGODB", "REDIS", "KAFKA", "RABBITMQ", "DOCKER", "KUBERNETES",
            "ANSIBLE", "TERRAFORM", "PROMETHEUS", "GRAFANA", "ELK", "SPLUNK"
        ]
    },
    seltene_kleinbuchstaben: {
        id: "seltene_kleinbuchstaben",
        name: "Rare lowercase letters",
        words: [
            "Qualle", "Quelle", "Quark", "Quarz", "Quirl", "Quittung", "Xylophon",
            "Xerox", "Xenia", "Yacht", "Yoga", "Ypsilon", "Zebra", "Zitrone",
            "Zauber", "Zirkus", "Zweig", "Vampir", "Vogel", "Vase", "Vater",
            "Wachs", "Wolke", "Wurst", "Wasser", "Känguru", "Küche", "König",
            "Käfig", "Pinguin", "Pflanze", "Punkt", "Papier", "Jazz", "Joghurt",
            "Jugend", "Juni", "Juli", "Jalousie", "Quadrat", "Querschnitt",
            "X-Beine", "Y-Gen", "Zellstoff", "Zwerg", "Zwilling", "Vulkan",
            "Wal", "Welle", "Winkel", "Keks", "Klavier", "Kaktus", "Pony",
            "Pumpe", "Puzzle", "Joker", "Jeans", "Juwel", "Jäger"
        ]
    },
    zahlen: {
        id: "zahlen",
        name: "Numbers & digit sequences",
        words: [
            "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
            "10", "11", "12", "13", "14", "15", "16", "17", "18", "19",
            "20", "21", "22", "23", "24", "25", "26", "27", "28", "29",
            "30", "31", "32", "33", "34", "35", "36", "37", "38", "39",
            "40", "50", "60", "70", "80", "90", "100", "101", "110", "111",
            "123", "456", "789", "1000", "2000", "3000", "4000", "5000",
            "6000", "7000", "8000", "9000", "10000", "11111", "12345",
            "54321", "98765", "13579", "24680", "99999", "00000", "121212",
            "333333", "777777", "888888", "123456", "654321", "987654",
            "102030", "405060", "789012", "345678", "901234", "567890"
        ]
    },
    satzzeichen: {
        id: "satzzeichen",
        name: "Punctuation & punctuation marks",
        words: [
            "Hallo.", "Wie?", "Super!", "Preis:", "eins;", "Test,",
            "Konto-Nr.", "Öffnungszeiten:", "Mo-Fr", "9-18", "12:30",
            "3,14", "9,99€", "(Achtung)", "[Hinweis]", "{Code}", "<HTML>",
            "...", "großartig!", "dir?", "Welt.", "na?", "Ende.",
            "Fragezeichen?", "Ausrufezeichen!", "Doppelpunkt:", "Semikolon;",
            "Komma,", "Punkt.", "Bindestrich-", "Unterstrich_", "Schrägstrich/",
            "Klammer)", "Klammer(", "eckige]", "eckige[", "geschweifte}",
            "geschweifte{", "spitze>", "spitze<", "Anführungszeichen\"",
            "Apostroph'", "Gänsefüßchen„", "Gänsefüßchen“", "Hochkomma‘",
            "Hochkomma’", "Auslassung…", "Gedankenstrich—", "Prozent%",
            "Und&", "At@", "Raute#", "Dollar$", "Euro€", "Pfund£", "Grad°"
        ]
    }
};

/** Helper for registering additional custom word lists */
export function registerWordList(id: string, name: string, words: string[]): void {
    WORD_LISTS[id] = { id, name, words };
}

const CANVAS_WIDTH = 520;
const CANVAS_HEIGHT = 160;

export class OcrTrainingCaptureModal extends Modal {
    private words: string[] = [];
    private currentIndex = 0;
    private samples: Map<number, CapturedWordSample> = new Map();

    private activeStrokes: CapturedStroke[] = [];
    private activeStroke: CapturedStroke | null = null;
    private activePointerId: number | null = null;

    private svgEl!: SVGSVGElement;
    private promptEl!: HTMLElement;
    private progressEl!: HTMLElement;
    private coverageEl!: HTMLElement;

    constructor(app: App, private targetChars: string[] | null = null) {
        super(app);
    }

    onOpen(): void {
        this.contentEl.empty();
        this.showSetupScreen();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private showSetupScreen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Collect OCR training data" });
        contentEl.createEl("p", {
            text:
                "Choose a predefined word list or enter your own words " +
                "(one word per line). For usable fine-tuning you should use " +
                "several hundred words (see select_coverage_words.py).",
        });

        const selectContainer = contentEl.createDiv();
        selectContainer.style.marginBottom = "10px";
        selectContainer.style.display = "flex";
        selectContainer.style.alignItems = "center";
        selectContainer.style.gap = "8px";

        selectContainer.createEl("label", { text: "Word list:" });
        const selectEl = selectContainer.createEl("select");
        selectEl.style.flexGrow = "1";

        for (const list of Object.values(WORD_LISTS)) {
            selectEl.createEl("option", { text: list.name, value: list.id });
        }

        const textarea = contentEl.createEl("textarea", {
            attr: { rows: "14", style: "width: 100%; font-family: monospace;" },
        });

        const loadSelectedList = () => {
            const selectedKey = selectEl.value;
            const list = WORD_LISTS[selectedKey];
            if (list) {
                textarea.value = list.words.join("\n");
            }
        };

        selectEl.addEventListener("change", loadSelectedList);
        loadSelectedList();

        const startBtn = contentEl.createEl("button", { text: "Start recording", cls: "mod-cta" });
        startBtn.style.marginTop = "10px";
        startBtn.addEventListener("click", () => {
            const words = textarea.value.split("\n").map(w => w.trim()).filter(w => w.length > 0);
            if (words.length === 0) {
                new Notice("Please enter at least one word.");
                return;
            }
            this.words = words;
            this.currentIndex = 0;
            this.samples.clear();
            this.showCaptureScreen();
        });
    }

    private showCaptureScreen(): void {
        const { contentEl } = this;
        contentEl.empty();

        this.progressEl = contentEl.createEl("div");
        this.promptEl = contentEl.createEl("div");
        this.promptEl.style.fontSize = "2em";
        this.promptEl.style.fontWeight = "bold";
        this.promptEl.style.textAlign = "center";
        this.promptEl.style.margin = "8px 0";

        this.svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
        this.svgEl.setAttribute("viewBox", `0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`);
        this.svgEl.setAttribute("width", "100%");
        this.svgEl.style.background = "var(--background-secondary)";
        this.svgEl.style.border = "1px solid var(--background-modifier-border)";
        this.svgEl.style.touchAction = "none";
        contentEl.appendChild(this.svgEl);

        const baseline = document.createElementNS("http://www.w3.org/2000/svg", "line");
        baseline.setAttribute("x1", "10");
        baseline.setAttribute("x2", (CANVAS_WIDTH - 10).toString());
        baseline.setAttribute("y1", (CANVAS_HEIGHT * 0.7).toString());
        baseline.setAttribute("y2", (CANVAS_HEIGHT * 0.7).toString());
        baseline.setAttribute("stroke", "var(--background-modifier-border)");
        baseline.setAttribute("stroke-dasharray", "4 3");
        this.svgEl.appendChild(baseline);

        this.svgEl.addEventListener("pointerdown", (e) => this.onPointerDown(e));
        this.svgEl.addEventListener("pointermove", (e) => this.onPointerMove(e));
        this.svgEl.addEventListener("pointerup", (e) => this.onPointerUp(e));
        this.svgEl.addEventListener("pointercancel", (e) => this.onPointerUp(e));

        const btnRow = contentEl.createDiv();
        btnRow.style.display = "flex";
        btnRow.style.gap = "6px";
        btnRow.style.marginTop = "8px";
        btnRow.style.flexWrap = "wrap";

        this.addButton(btnRow, "◀ Back", () => this.goTo(this.currentIndex - 1));
        this.addButton(btnRow, "Undo stroke", () => this.undoStroke());
        this.addButton(btnRow, "Clear word", () => this.clearWord());
        this.addButton(btnRow, "Next ▶", () => this.commitAndAdvance());
        this.addButton(btnRow, "Done & export", () => void this.exportSamples());

        this.coverageEl = contentEl.createEl("pre");
        this.coverageEl.style.fontSize = "0.75em";
        this.coverageEl.style.maxHeight = "120px";
        this.coverageEl.style.overflowY = "auto";

        this.loadWordIntoCanvas(this.currentIndex);
    }

    private addButton(container: HTMLElement, label: string, onClick: () => void): void {
        container.createEl("button", { text: label }).addEventListener("click", onClick);
    }

    private loadWordIntoCanvas(index: number): void {
        this.activeStrokes = [];
        this.svgEl.querySelectorAll("path[data-captured]").forEach(el => el.remove());

        const existing = this.samples.get(index);
        if (existing) {
            this.activeStrokes = existing.strokes.map(s => [...s]);
            for (const stroke of this.activeStrokes) this.drawStrokePreview(stroke);
        }

        this.promptEl.setText(this.words[index] ?? "");
        this.progressEl.setText(`Word ${index + 1} / ${this.words.length}`);
        this.updateCoverageDisplay();
    }

    private goTo(index: number): void {
        if (index < 0 || index >= this.words.length) return;
        this.saveCurrentIntoSamples();
        this.currentIndex = index;
        this.loadWordIntoCanvas(index);
    }

    private saveCurrentIntoSamples(): void {
        if (this.activeStrokes.length === 0) {
            this.samples.delete(this.currentIndex);
            return;
        }
        this.samples.set(this.currentIndex, {
            text: this.words[this.currentIndex],
            strokes: this.activeStrokes.map(s => [...s]),
        });
    }

    private commitAndAdvance(): void {
        this.saveCurrentIntoSamples();
        if (this.currentIndex + 1 < this.words.length) {
            this.currentIndex++;
            this.loadWordIntoCanvas(this.currentIndex);
        } else {
            new Notice("Last word reached. Click 'Done & export'.");
        }
    }

    private clearWord(): void {
        this.activeStrokes = [];
        this.svgEl.querySelectorAll("path[data-captured]").forEach(el => el.remove());
        this.samples.delete(this.currentIndex);
        this.updateCoverageDisplay();
    }

    private undoStroke(): void {
        this.activeStrokes.pop();
        const paths = this.svgEl.querySelectorAll("path[data-captured]");
        paths[paths.length - 1]?.remove();
        this.updateCoverageDisplay();
    }

    private getSvgPoint(evt: PointerEvent): { x: number; y: number } {
        const point = this.svgEl.createSVGPoint();
        point.x = evt.clientX;
        point.y = evt.clientY;
        const ctm = this.svgEl.getScreenCTM();
        if (!ctm) return { x: 0, y: 0 };
        const transformed = point.matrixTransform(ctm.inverse());
        return { x: transformed.x, y: transformed.y };
    }

    private onPointerDown(evt: PointerEvent): void {
        evt.preventDefault();
        this.svgEl.setPointerCapture(evt.pointerId);
        this.activePointerId = evt.pointerId;
        const { x, y } = this.getSvgPoint(evt);
        this.activeStroke = [{ x, y, t: performance.now() }];
    }

    private onPointerMove(evt: PointerEvent): void {
        if (!this.activeStroke || evt.pointerId !== this.activePointerId) return;
        evt.preventDefault();
        const { x, y } = this.getSvgPoint(evt);
        this.activeStroke.push({ x, y, t: performance.now() });
        this.redrawActiveStrokePreview();
    }

    private onPointerUp(evt: PointerEvent): void {
        if (!this.activeStroke || evt.pointerId !== this.activePointerId) return;
        if (this.svgEl.hasPointerCapture(evt.pointerId)) this.svgEl.releasePointerCapture(evt.pointerId);
        if (this.activeStroke.length >= 2) {
            this.activeStrokes.push(this.activeStroke);
            this.drawStrokePreview(this.activeStroke);
        }
        this.activeStroke = null;
        this.activePointerId = null;
        this.updateCoverageDisplay();
    }

    private redrawActiveStrokePreview(): void {
        if (!this.activeStroke) return;
        let previewPath = this.svgEl.querySelector('path[data-preview="1"]') as SVGPathElement | null;
        if (!previewPath) {
            previewPath = document.createElementNS("http://www.w3.org/2000/svg", "path") as SVGPathElement;
            previewPath.setAttribute("data-preview", "1");
            previewPath.setAttribute("fill", "none");
            previewPath.setAttribute("stroke", "var(--text-accent)");
            previewPath.setAttribute("stroke-width", "2.5");
            previewPath.setAttribute("stroke-linecap", "round");
            previewPath.setAttribute("stroke-linejoin", "round");
            this.svgEl.appendChild(previewPath);
        }
        previewPath.setAttribute("d", this.strokeToPathData(this.activeStroke));
    }

    private drawStrokePreview(stroke: CapturedStroke): void {
        this.svgEl.querySelector('path[data-preview="1"]')?.remove();
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("data-captured", "1");
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "var(--text-normal)");
        path.setAttribute("stroke-width", "2.5");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("d", this.strokeToPathData(stroke));
        this.svgEl.appendChild(path);
    }

    private strokeToPathData(stroke: CapturedStroke): string {
        if (stroke.length === 0) return "";
        let d = `M ${stroke[0].x} ${stroke[0].y}`;
        for (let i = 1; i < stroke.length; i++) d += ` L ${stroke[i].x} ${stroke[i].y}`;
        return d;
    }

    private updateCoverageDisplay(): void {
        if (!this.targetChars || this.targetChars.length === 0) {
            this.coverageEl.setText("");
            return;
        }
        this.saveCurrentIntoSamples();
        const counts = new Map<string, number>();
        for (const c of this.targetChars) counts.set(c, 0);
        for (const sample of this.samples.values()) {
            for (const ch of sample.text) {
                if (counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
            }
        }
        const lines = Array.from(counts.entries())
            .sort((a, b) => a[1] - b[1])
            .map(([ch, n]) => `${JSON.stringify(ch)}: ${n}`);
        this.coverageEl.setText(lines.join("  "));
    }

    private async exportSamples(): Promise<void> {
        this.saveCurrentIntoSamples();
        const samples = Array.from(this.samples.values());
        if (samples.length === 0) {
            new Notice("No training samples available.");
            return;
        }

        const payload = { createdAt: new Date().toISOString(), samples };
        const filename = `ocr-training-${Date.now()}.json`;

        try {
            await this.app.vault.create(filename, JSON.stringify(payload));
            new Notice(`${samples.length} training samples saved: ${filename}`);
            this.close();
        } catch (error) {
            new Notice(`Export failed: ${String(error)}`);
        }
    }
}