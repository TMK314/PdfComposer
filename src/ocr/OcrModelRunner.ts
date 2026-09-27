// OcrModelRunner.ts
//
// Kapselt das Laden und Ausführen des lokalen digitalink.tflite-Modells.
//
// WICHTIG (Ladestrategie): @tensorflow/tfjs und @tensorflow/tfjs-tflite
// werden bewusst NICHT über einen JS-Bundler (esbuild) eingebunden. Beide
// Pakete sind ESM/CJS-Hybride mit eigener interner dynamischer
// Backend-Ladelogik, die sich nicht zuverlässig in ein einzelnes main.js
// bündeln lässt:
//   - dynamisches import("@tensorflow/tfjs") blieb im gebündelten main.js
//     als echter Laufzeit-import() stehen -> "Failed to resolve module
//     specifier" (Obsidians Renderer kennt keine Modulauflösung für nackte
//     npm-Bezeichner).
//   - require("@tensorflow/tfjs") führte dazu, dass rohe ESM-import-Syntax
//     aus dem Paket ungefiltert ins Bundle durchsickerte -> "Cannot use
//     import statement outside a module".
//
// Deshalb: Wir laden stattdessen – exakt wie in Googles eigener
// tfjs-tflite-Dokumentation empfohlen – die fertigen UMD-Browser-Bundles
// (tf.min.js, tf-tflite.min.js) per <script>-Tag nach. Das legt globale
// Variablen `tf`/`tflite` an. esbuild fasst den Inhalt dieser Dateien nie
// an (siehe esbuild.config.mjs: copyTfliteRuntimeAssets() kopiert sie
// unverändert in den "wasm"-Ordner des Plugins).
//
// WICHTIG (Single-Thread erzwingen): tfjs-tflite wählt je nach erkannten
// Browser-Fähigkeiten automatisch zwischen mehreren WASM-Varianten
// (Baseline / SIMD / Threaded / SIMD+Threaded). Die "*_threaded"-Variante
// nutzt einen Web Worker (tflite_web_api_cc_simd_threaded.worker.js), der
// seine eigene Skript-URL SELBST auflöst (unabhängig von unserem
// wasmBaseUrl) – in Obsidians Electron-Renderer führte das zu
// fehlerhaften, doppelt aufgelösten app://-URLs und ERR_FILE_NOT_FOUND.
// Deshalb wird beim Laden explizit `numThreads: 1` übergeben, damit
// tfjs-tflite die Single-Thread-Variante ohne Worker wählt. Falls das
// Problem trotzdem auftritt, als zusätzliche Absicherung die vier
// "*_threaded*"-Dateien (tflite_web_api_cc_threaded.*,
// tflite_web_api_cc_simd_threaded.*) ersatzlos aus dem "wasm"-Ordner
// löschen, damit der Loader mangels Alternative auf
// tflite_web_api_cc_simd.js/.wasm (oder tflite_web_api_cc.js/.wasm)
// ausweicht.
//
// Ein- und Ausgabe von Modell/Labels laufen über vom Aufrufer
// bereitgestellte Ressourcen (siehe OcrModelSource) statt über Dateipfade,
// damit dieses Modul nichts über Obsidians Vault-API wissen muss – das
// eigentliche Lesen (per app.vault.adapter) übernimmt OcrController.
//
// TODO / Hinweis zur Modell-Ausgabe: Das exakte Ausgabeformat von
// digitalink.tflite-artigen Modellen ist nicht standardisiert. Die hier
// implementierte Greedy-CTC-Decodierung geht von [1, T, numClasses] mit
// "letzte Klasse = Blank" aus (siehe training/model.py für das mit der
// mitgelieferten Trainings-Pipeline erzeugte Format).

export interface OcrModelSource {
    model: string | ArrayBuffer;
    labels: string[];
    /** Vollständige URL zu tf.min.js (vom Obsidian-Adapter bereitgestellt, ohne Cache-Buster-Query). */
    tfJsUrl: string;
    /** Vollständige URL zu tf-tflite.min.js (vom Obsidian-Adapter bereitgestellt, ohne Cache-Buster-Query). */
    tfliteJsUrl: string;
    /** Basis-URL für WASM-/Worker-Dateien, mit genau einem abschließenden Slash, ohne Cache-Buster-Query. */
    wasmBaseUrl: string;
    wasmBuffer?: ArrayBuffer;
}

export interface OcrModelConfig {
    maxSequenceLength: number;
}

export interface OcrRecognitionResult {
    text: string;
    /** Gemittelte Konfidenz der Greedy-Decodierung, 0..1. */
    confidence: number;
}

const FEATURES_PER_POINT = 3; // [x, y, t] – siehe OcrStrokeCollector.buildNormalizedInk

// Statische UMD-Imports statt Laufzeit-<script>-Injection: esbuild bündelt
// diese fertigen Browser-Bundles unverändert mit in main.js. Dadurch
// erzeugt das Plugin zu keinem Zeitpunkt mehr ein <script>-Element zur
// Laufzeit (was von Obsidians Review als potenzielles Sicherheitsrisiko
// eingestuft wird), obwohl die Laufzeit weiterhin exakt dieselbe ist wie
// vorher (dieselben UMD-Dateien, nur anders eingebunden).
import "@tensorflow/tfjs/dist/tf.min.js";
import "@tensorflow/tfjs-tflite/dist/tf-tflite.min.js";

declare const tf: any;
declare const tflite: any;

function getRuntime(): { tf: any; tflite: any } {
    const w = window as any;
    if (!w.tf || !w.tflite) {
        throw new Error(
            "OCR: tf.min.js/tf-tflite.min.js wurden gebündelt, aber die " +
            "erwarteten globalen Variablen `tf`/`tflite` sind nicht vorhanden."
        );
    }
    return { tf: w.tf, tflite: w.tflite };
}

export class OcrModelRunner {
    private model: any | null = null;
    private tf: any | null = null;
    private labels: string[] = [];
    private loadingPromise: Promise<void> | null = null;
    private loadError: Error | null = null;

    constructor(private config: OcrModelConfig, private getSource: () => Promise<OcrModelSource>) { }

    /**
     * Lädt die tfjs/tfjs-tflite-Laufzeit (per <script>-Tag) und das Modell
     * selbst genau einmal, verzögert bis zum ersten recognize()-Aufruf.
     */
    private async ensureLoaded(): Promise<void> {
        if (this.model) return;
        if (this.loadError) throw this.loadError;
        if (!this.loadingPromise) {
            this.loadingPromise = this.loadInternal();
        }
        await this.loadingPromise;
    }

    private async loadInternal(): Promise<void> {
        const source = await this.getSource();
        if (!source.model) throw new Error("Kein Modell konfiguriert.");
        if (!source.labels || source.labels.length === 0) throw new Error("Keine Zeichentabelle konfiguriert.");

        // Original-Referenzen sichern
        const originalFetch = window.fetch;
        const originalCreateElement = document.createElement;
        const originalSAB = (window as any).SharedArrayBuffer;

        try {
            // 1. Thread-Worker Spoofing beibehalten
            (window as any).SharedArrayBuffer = undefined;

            // 2. Temporäre URL-Interzeptoren für den Obsidian app:// Bug
            const fixUrl = (url: string) => url.replace('app://obsidian.md/app://', 'app://');

            window.fetch = async (...args) => {
                if (typeof args[0] === 'string' && args[0].includes('app://obsidian.md/app://')) {
                    args[0] = fixUrl(args[0]);
                } else if (args[0] instanceof Request && args[0].url.includes('app://obsidian.md/app://')) {
                    args[0] = new Request(fixUrl(args[0].url), args[0]);
                }
                return originalFetch.apply(window, args as any);
            };

            document.createElement = function (tagName: string, options?: ElementCreationOptions) {
                const el = originalCreateElement.call(document, tagName, options);
                if (tagName.toLowerCase() === 'script') {
                    const originalSetAttribute = el.setAttribute.bind(el);
                    el.setAttribute = function (name: string, value: any) {
                        if (name === 'src' && typeof value === 'string' && value.includes('app://obsidian.md/app://')) {
                            value = fixUrl(value);
                        }
                        return originalSetAttribute(name, value);
                    };
                    Object.defineProperty(el, 'src', {
                        set(val: string) {
                            if (typeof val === 'string' && val.includes('app://obsidian.md/app://')) {
                                val = fixUrl(val);
                            }
                            this.setAttribute('src', val);
                        },
                        get() { return this.getAttribute('src') || ''; }
                    });
                }
                return el;
            };

            // 3. Laufzeit und Modell laden (die Interzeptoren greifen jetzt automatisch)
            const runtime = getRuntime();
            this.tf = runtime.tf;

            if (runtime.tflite.setWasmPath && source.wasmBaseUrl) {
                runtime.tflite.setWasmPath(source.wasmBaseUrl);
            }

            this.model = await runtime.tflite.loadTFLiteModel(source.model as any, {
                numThreads: 1,
                useThreads: false
            });
            this.labels = source.labels;

        } catch (error) {
            this.loadError = error instanceof Error ? error : new Error(String(error));
            throw this.loadError;
        } finally {
            // 4. Globale APIs zwingend wiederherstellen, egal ob Erfolg oder Fehler
            window.fetch = originalFetch;
            document.createElement = originalCreateElement;
            if (originalSAB !== undefined) {
                (window as any).SharedArrayBuffer = originalSAB;
            } else {
                delete (window as any).SharedArrayBuffer;
            }
        }
    }

    /**
     * Erkennt eine einzelne normalisierte Ink-Sequenz ([[x,y,t], ...]) und
     * liefert den erkannten Text samt Konfidenz zurück, oder null, falls
     * nichts Sinnvolles erkannt wurde.
     */
    async recognize(sequence: number[][]): Promise<OcrRecognitionResult | null> {
        if (sequence.length === 0) return null;
        await this.ensureLoaded();
        if (!this.model || !this.tf) return null;

        const tf = this.tf;
        // Tatsächliche (ungepaddete) Punktanzahl merken: Das Trainingsmodell
        // (siehe training/model.py) nimmt bewusst KEIN zeitliches
        // Downsampling vor (durchgängig stride=1), d. h. T_out == T_in.
        const validLength = Math.min(sequence.length, this.config.maxSequenceLength);
        const padded = this.padOrTruncate(sequence, this.config.maxSequenceLength);
        const input = tf.tensor([padded], [1, this.config.maxSequenceLength, FEATURES_PER_POINT]);
        try {
            const output = this.model.predict(input);
            const result = await this.decodeCtc(output, validLength);
            output.dispose?.();
            return result;
        } finally {
            input.dispose();
        }
    }

    private padOrTruncate(seq: number[][], len: number): number[][] {
        if (seq.length >= len) return seq.slice(0, len);
        const padded = seq.slice();
        while (padded.length < len) padded.push(new Array(FEATURES_PER_POINT).fill(0));
        return padded;
    }

    /** Greedy-CTC-Decoding: siehe Hinweis am Dateianfang. */
    private async decodeCtc(output: any, validLength: number): Promise<OcrRecognitionResult> {
        const data = (await output.array()) as number[][][];
        const allFrames = data[0] ?? [];
        const frames = allFrames.slice(0, validLength);
        const blankIndex = this.labels.length; // Annahme: letzte Klasse = CTC-Blank

        let prevClass = -1;
        let text = "";
        let confSum = 0;
        let confCount = 0;

        // --- DEBUG: rohe Klassenfolge vor dem Collapsing ---
        const rawIndices: number[] = [];
        // --- Ende Debug ---

        for (const frame of frames) {
            let bestIdx = 0;
            let bestVal = -Infinity;
            for (let i = 0; i < frame.length; i++) {
                if (frame[i] > bestVal) {
                    bestVal = frame[i];
                    bestIdx = i;
                }
            }
            rawIndices.push(bestIdx); // DEBUG

            if (bestIdx !== blankIndex && bestIdx !== prevClass) {
                text += this.labels[bestIdx] ?? "";
                confSum += bestVal;
                confCount++;
            }
            prevClass = bestIdx;
        }

        console.log(`[OCR-Debug] Rohe Klassenindizes (blankIndex=${blankIndex}):`, rawIndices.join(","));

        return { text, confidence: confCount > 0 ? confSum / confCount : 0 };
    }

    /**
     * Setzt NUR das geladene Modell/die Labels dieser Instanz zurück (z. B.
     * bei geändertem Modellpfad). Die bereits per <script>-Tag geladene
     * tfjs/tfjs-tflite-Laufzeit bleibt global bestehen (wird nicht erneut
     * nachgeladen).
     */
    async reset(): Promise<void> {
        this.model?.dispose?.();
        this.model = null;
        this.tf = null;
        this.labels = [];
        this.loadingPromise = null;
        this.loadError = null;
    }

    async destroy(): Promise<void> {
        await this.reset();
    }
}

// Neue Hilfsfunktion, die das script-Element zurückgibt
function loadScriptAndGetElement(url: string): Promise<HTMLScriptElement> {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-ocr-runtime-src="${url}"]`);
        if (existing) {
            if (existing.getAttribute("data-ocr-runtime-loaded") === "true") {
                resolve(existing as HTMLScriptElement);
                return;
            }
            existing.addEventListener("load", () => resolve(existing as HTMLScriptElement));
            existing.addEventListener("error", () => reject(new Error(`Skript konnte nicht geladen werden: ${url}`)));
            return;
        }
        const script = document.createElement("script");
        script.src = url;
        script.async = true;
        script.setAttribute("data-ocr-runtime-src", url);
        script.addEventListener("load", () => {
            script.setAttribute("data-ocr-runtime-loaded", "true");
            resolve(script);
        });
        script.addEventListener("error", () => reject(new Error(`Skript konnte nicht geladen werden: ${url}`)));
        document.head.appendChild(script);
    });
}