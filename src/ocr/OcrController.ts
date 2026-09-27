// OcrController.ts
//
// Orchestriert die OCR-Erkennung für eine Seite: filtert die relevanten
// Striche, gruppiert sie zu Wörtern, lädt bei Bedarf Modell/Labels/WASM
// über die Obsidian-Vault-Adapter-API (funktioniert auf Desktop UND
// Mobile – bewusst kein `fs`, kein `@tensorflow/tfjs-node`) und liefert
// erkannte Wörter samt Bounding-Box zurück.

import { App } from "obsidian";
import { VectorObject } from "../types";
import { collectEligibleStrokes, groupStrokesIntoWords, buildNormalizedInk } from "./OcrStrokeCollector";
import { OcrModelRunner, OcrModelSource } from "./OcrModelRunner";
import { OcrWordEntry } from "./OcrBlockParser";

/** Minimale Teilmenge der Plugin-Einstellungen, die OCR benötigt. */
export interface OcrSettingsSlice {
    ocrModelPath: string;
    ocrLabelsPath: string;
    ocrWasmPath: string;
    ocrMaxSequenceLength: number;
    ocrMinConfidence: number;
    ocrLineGapFactor: number;
    ocrWordGapFactor: number;
    /** Multiplikator für den Fragment-Rettungs-Durchlauf, siehe WordGroupingOptions.fragmentRescueFactor. */
    ocrFragmentRescueFactor: number;
    /** Ziel-Punktabstand für die Interpolation vereinfachter Striche, als
     *  Bruchteil der Wort-Bounding-Box (0,02 = 2 % der längeren Kante). */
    ocrResampleSpacing: number;
}

export class OcrController {
    private runner: OcrModelRunner | null = null;
    private runnerSignature: string | null = null;

    constructor(private app: App, private getSettings: () => OcrSettingsSlice) { }

    /**
     * Liest Modell und Labels über die Vault-Adapter-API ein. `readBinary`
     * liefert ein ArrayBuffer (kein Fetch/CORS nötig – wichtig für
     * Offline-/Mobile-Betrieb), `getResourcePath` erzeugt eine für die
     * Obsidian-Webview gültige URL für den Ordner, der tf.min.js,
     * tf-tflite.min.js und die WASM-Binärdateien enthält (siehe
     * OcrModelRunner.ts: diese werden per <script>-Tag geladen, nicht
     * gebündelt).
     *
     * Hinweis: getResourcePath ist eigentlich für einzelne Dateien gedacht;
     * für einen Ordner-Pfad liefert es dennoch eine gültige URL-Konstruktion
     * (es wird nicht geprüft, ob der Pfad existiert).
     */
    private async loadModelSource(): Promise<OcrModelSource> {
        const settings = this.getSettings();

        if (!settings.ocrModelPath) {
            throw new Error(
                "OCR: Kein Modellpfad in den Einstellungen hinterlegt."
            );
        }

        if (!settings.ocrLabelsPath) {
            throw new Error(
                "OCR: Kein Pfad zur Zeichentabelle in den Einstellungen hinterlegt."
            );
        }

        if (!settings.ocrWasmPath) {
            throw new Error(
                "OCR: Kein Pfad zu den tfjs-tflite-WASM-Dateien in den Einstellungen hinterlegt."
            );
        }

        const adapter = this.app.vault.adapter;

        const modelBytes = await adapter.readBinary(settings.ocrModelPath);
        const labelsRaw = await adapter.read(settings.ocrLabelsPath);
        const labels = labelsRaw.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);

        const cleanResourceUrl = (path: string): string => adapter.getResourcePath(path).split("?")[0];
        const wasmPath = settings.ocrWasmPath.replace(/\/+$/, "");

        const tfJsUrl = cleanResourceUrl(`${wasmPath}/tf.min.js`);
        const tfliteJsUrl = cleanResourceUrl(`${wasmPath}/tf-tflite.min.js`);
        const wasmBaseUrl = cleanResourceUrl(`${wasmPath}/`).replace(/\/*$/, "/");

        // Kein wasmBuffer mehr
        return {
            model: modelBytes,
            labels,
            tfJsUrl,
            tfliteJsUrl,
            wasmBaseUrl,  // optional – wird nicht verwendet, kann aber bleiben
        };
    }

    /** Signatur der aktuell relevanten Einstellungen, um ein Modell-Reload bei Pfadänderung auszulösen. */
    private currentSignature(settings: OcrSettingsSlice): string {
        return [settings.ocrModelPath, settings.ocrLabelsPath, settings.ocrWasmPath, settings.ocrMaxSequenceLength].join("|");
    }

    private async ensureRunner(): Promise<OcrModelRunner> {
        const settings = this.getSettings();
        const signature = this.currentSignature(settings);
        if (this.runner && this.runnerSignature === signature) {
            return this.runner;
        }
        await this.runner?.destroy();
        this.runner = new OcrModelRunner(
            { maxSequenceLength: settings.ocrMaxSequenceLength },
            () => this.loadModelSource()
        );
        this.runnerSignature = signature;
        return this.runner;
    }

    /**
     * Einfacher, nicht-kryptografischer Hash über die OCR-relevanten Striche
     * einer Seite, um unveränderte Seiten bei "OCR erneut ausführen"
     * überspringen zu können.
     */
    public computeStrokeHash(objects: VectorObject[]): string {
        const strokes = collectEligibleStrokes(objects);
        const summary = strokes.map(s => [
            s.id,
            s.points.length,
            s.points[0]?.x.toFixed(2),
            s.points[0]?.y.toFixed(2),
            s.points[s.points.length - 1]?.x.toFixed(2),
            s.points[s.points.length - 1]?.y.toFixed(2),
        ]);
        const str = JSON.stringify(summary);
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = (hash * 31 + str.charCodeAt(i)) | 0;
        }
        return hash.toString(36);
    }

    /** Erkennt alle Wörter einer Seite anhand ihrer Stift-Striche. */
    public async recognizePage(objects: VectorObject[]): Promise<OcrWordEntry[]> {
        const settings = this.getSettings();
        const strokes = collectEligibleStrokes(objects);
        if (strokes.length === 0) return [];

        const groups = groupStrokesIntoWords(strokes, {
            lineGapFactor: settings.ocrLineGapFactor,
            wordGapFactor: settings.ocrWordGapFactor,
            fragmentRescueFactor: settings.ocrFragmentRescueFactor,
        });

        // --- DEBUG: Gruppengrößen sichtbar machen ---
        for (const g of groups) {
            const totalPoints = g.strokes.reduce((sum, s) => sum + s.points.length, 0);
            if (totalPoints > settings.ocrMaxSequenceLength) {
                console.warn(
                    `[OCR-Debug] Gruppe überschreitet ocrMaxSequenceLength (${settings.ocrMaxSequenceLength}) ` +
                    `→ wird abgeschnitten! (${totalPoints} Punkte)`
                );
            }
        }
        // --- Ende Debug ---

        const runner = await this.ensureRunner();
        const results: OcrWordEntry[] = [];
        for (const group of groups) {
            const ink = buildNormalizedInk(group.strokes, group.bounds, settings.ocrResampleSpacing);
            const recognized = await runner.recognize(ink);
            if (!recognized || !recognized.text.trim()) continue;
            if (recognized.confidence < settings.ocrMinConfidence) continue;
            results.push({
                text: recognized.text,
                confidence: recognized.confidence,
                x: group.bounds.x,
                y: group.bounds.y,
                width: group.bounds.width,
                height: group.bounds.height,
            });
        }
        return results;
    }

    /** Erzwingt beim nächsten Aufruf ein Neuladen des Modells (z. B. nach Änderung der Einstellungen). */
    public async invalidate(): Promise<void> {
        await this.runner?.destroy();
        this.runner = null;
        this.runnerSignature = null;
    }

    public async destroy(): Promise<void> {
        await this.runner?.destroy();
        this.runner = null;
        this.runnerSignature = null;
    }
}