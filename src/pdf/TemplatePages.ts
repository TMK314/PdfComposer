// Definiert eingebaute "Leerseiten"-Vorlagen (blanko, kariert, liniert – je
// mit/ohne Rand) direkt im Code. Es werden bewusst KEINE PDF-Dateien im Vault
// erzeugt; die Vorlagen werden zur Laufzeit auf ein Canvas gezeichnet und
// über dieselbe Pipeline wie echte PDF-Seiten (Annotations-/Text-/Highlight-
// Ebenen) eingehängt.

import { BuiltinTemplateId } from "../types";

export interface BuiltinTemplateMeta {
    id: BuiltinTemplateId;
    label: string;
}

export const BUILTIN_TEMPLATES: BuiltinTemplateMeta[] = [
    { id: "blank", label: "Blank" },
    { id: "grid", label: "Grid (5 mm)" },
    { id: "grid-margin", label: "Grid (5 mm) with margin" },
    { id: "lines", label: "Lined" },
    { id: "lines-margin", label: "Lined with margin" },
];

const MM = 72 / 25.4;          // Punkte pro Millimeter
const GRID_SIZE = 5 * MM;      // 5 mm Kästchengröße
const LINE_SPACING = 8 * MM;   // Zeilenabstand bei "liniert"
const MARGIN = 20 * MM;        // Randbreite bei "mit Rand"-Varianten

/**
 * Zeichnet die gewählte Vorlage auf einen bereits in Pixelgröße
 * (widthPt*scale x heightPt*scale) initialisierten Canvas-Context.
 * widthPt/heightPt sind die Seitenmaße in PDF-Punkten (unskaliert).
 */
export function drawTemplatePattern(
    ctx: CanvasRenderingContext2D,
    template: BuiltinTemplateId,
    widthPt: number,
    heightPt: number,
    scale: number,
    dark: boolean = false
): void {
    const bg = dark ? "#1e1e1e" : "#ffffff";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, widthPt * scale, heightPt * scale);

    const gridColor = dark ? "#3a5a78" : "#b8d4f0";
    const marginColor = dark ? "#a85050" : "#e08080";

    switch (template) {
        case "blank":
            return;
        case "grid":
            drawGrid(ctx, widthPt, heightPt, scale, 0, gridColor, marginColor);
            return;
        case "grid-margin":
            drawGrid(ctx, widthPt, heightPt, scale, MARGIN, gridColor, marginColor);
            return;
        case "lines":
            drawLines(ctx, widthPt, heightPt, scale, 0, gridColor, marginColor);
            return;
        case "lines-margin":
            drawLines(ctx, widthPt, heightPt, scale, MARGIN, gridColor, marginColor);
            return;
    }
}

function drawGrid(ctx: CanvasRenderingContext2D, widthPt: number, heightPt: number, scale: number, margin: number, gridColor: string, marginColor: string): void {
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = Math.max(0.5, 0.5 * scale);

    const left = margin, right = widthPt - margin;
    const top = margin, bottom = heightPt - margin;

    for (let x = left; x <= right + 0.01; x += GRID_SIZE) {
        ctx.beginPath();
        ctx.moveTo(x * scale, top * scale);
        ctx.lineTo(x * scale, bottom * scale);
        ctx.stroke();
    }
    for (let y = top; y <= bottom + 0.01; y += GRID_SIZE) {
        ctx.beginPath();
        ctx.moveTo(left * scale, y * scale);
        ctx.lineTo(right * scale, y * scale);
        ctx.stroke();
    }

    if (margin > 0) drawMarginFrame(ctx, widthPt, heightPt, scale, margin, marginColor);
}

function drawLines(ctx: CanvasRenderingContext2D, widthPt: number, heightPt: number, scale: number, margin: number, gridColor: string, marginColor: string): void {
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = Math.max(0.5, 0.5 * scale);

    const left = margin, right = widthPt - margin;
    const top = margin + LINE_SPACING, bottom = heightPt - margin;

    for (let y = top; y <= bottom + 0.01; y += LINE_SPACING) {
        ctx.beginPath();
        ctx.moveTo(left * scale, y * scale);
        ctx.lineTo(right * scale, y * scale);
        ctx.stroke();
    }

    if (margin > 0) drawMarginFrame(ctx, widthPt, heightPt, scale, margin, marginColor);
}

function drawMarginFrame(ctx: CanvasRenderingContext2D, widthPt: number, heightPt: number, scale: number, margin: number, marginColor: string): void {
    ctx.strokeStyle = marginColor;
    ctx.lineWidth = Math.max(0.75, 0.75 * scale);
    ctx.beginPath();
    ctx.moveTo(margin * scale, 0);
    ctx.lineTo(margin * scale, heightPt * scale);
    ctx.stroke();
}