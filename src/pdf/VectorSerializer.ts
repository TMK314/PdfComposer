import {
    VectorObject,
    FreehandObject,
    LineObject,
    ArrowObject,
    PolygonObject,
    RectangleObject,
    TriangleObject,
    EllipseObject,
    DiamondObject,
    StrokePoint,
    LinePoint,
    LineSegmentKind,
    PressureCurve,
    PressureSettings,
} from "../types";
import { compressText, decompressText } from "./VectorCompression";

const PRECISION = 100; // 2 Nachkommastellen – reduziert Zahlenlänge spürbar

function round(n: number): number {
    return Math.round(n * PRECISION) / PRECISION;
}

const SEGMENT_CODES: Record<LineSegmentKind, number> = { straight: 0, curve: 1, step: 2 };
const SEGMENT_NAMES: LineSegmentKind[] = ["straight", "curve", "step"];

/** Dedupliziert Werte (Farben, Breiten) und liefert kurze Indizes zurück. */
class ValueTable<T> {
    private values: T[] = [];
    private index = new Map<string, number>();

    add(value: T): number {
        const key = JSON.stringify(value);
        const existing = this.index.get(key);
        if (existing !== undefined) return existing;
        const idx = this.values.length;
        this.values.push(value);
        this.index.set(key, idx);
        return idx;
    }

    toArray(): T[] {
        return this.values;
    }
}

interface EncodedPayload {
    c: string[];  // Farbtabelle
    w: number[];  // Breitentabelle
    o: any[][];   // kompakte Objekt-Tupel, positionell statt über Schlüsselnamen
}

/**
 * Kodiert eine Liste von Vektorobjekten (typischerweise: alle Objekte
 * einer Seite) zu einer Liste komprimierter ASCII-Strings – EIN String
 * pro Objekt. Dadurch landet im Frontmatter (YAML-Array) jeder Strich/
 * jede Form auf einer eigenen Zeile: ändert sich nur ein Objekt, ändert
 * sich in Git auch nur eine einzelne Zeile statt eines langen Blobs für
 * die gesamte Seite.
 */
export function encodeAnnotations(objects: VectorObject[]): string[] {
    return objects.map((obj) => {
        const colors = new ValueTable<string>();
        const widths = new ValueTable<number>();
        const tuple = encodeObject(obj, colors, widths);
        const payload: EncodedPayload = {
            c: colors.toArray(),
            w: widths.toArray(),
            o: [tuple],
        };
        return compressText(JSON.stringify(payload));
    });
}

/**
 * Kehrt encodeAnnotations() um. Akzeptiert sowohl das neue Format (ein
 * String pro Objekt) als auch – für bereits gespeicherte Dateien – das
 * alte Format (ein einzelner String mit ALLEN Objekten einer Seite in
 * einem gemeinsamen Payload). Jeder Chunk wird generisch als Liste von
 * Tupeln behandelt, damit beide Formate ohne Unterscheidung funktionieren.
 */
export function decodeAnnotations(data: string | string[] | undefined): VectorObject[] {
    if (!data) return [];
    const chunks = Array.isArray(data) ? data : [data];
    const result: VectorObject[] = [];
    for (const chunk of chunks) {
        if (!chunk) continue;
        const payload: EncodedPayload = JSON.parse(decompressText(chunk));
        for (const tuple of payload.o) {
            result.push(decodeObject(tuple, payload.c, payload.w));
        }
    }
    return result;
}

function encodeObject(obj: VectorObject, colors: ValueTable<string>, widths: ValueTable<number>): any[] {
    switch (obj.type) {
        case "freehand": {
            const points = obj.points.map((p) => [
                round(p.x),
                round(p.y),
                p.p !== undefined ? round(p.p) : null,
                Math.round(p.t),
            ]);
            const curveCode = obj.pressureCurve === "linear" ? 0 :
                obj.pressureCurve === "quadratic" ? 1 :
                    obj.pressureCurve === "sqrt" ? 2 : 3;
            return [
                0,
                obj.id,
                obj.highlighter ? 1 : 0,
                colors.add(obj.color),
                obj.pressureEnabled ? 1 : 0,
                round(obj.pressureMinFactor),
                curveCode,
                widths.add(round(obj.strokeWidth)),
                points,
            ];
        }
        case "line":
        case "arrow": {
            const points = obj.points.map((p) => [
                round(p.x), round(p.y),
                p.segment ? SEGMENT_CODES[p.segment] : 0,
            ]);
            const base: any[] = [
                obj.type === "line" ? 1 : 2,
                obj.id,
                colors.add(obj.color),
                widths.add(round(obj.width)),
            ];
            if (obj.type === "arrow") {
                base.push(obj.arrowStart ? 1 : 0, obj.arrowEnd ? 1 : 0);
            }
            base.push(points as any);
            base.push(obj.isHighlighter ? 1 : 0);
            if (obj.type === "arrow") {
                base.push(obj.arrowSize !== undefined ? round(obj.arrowSize) : null);
            }
            // NEU: Beschriftung + Endpunkt-Bindungen, immer am Ende angehängt
            // (bei "line" direkt nach dem highlighter-Flag, bei "arrow" nach
            // arrowSize) - ältere Dateien haben diese Felder einfach nicht.
            base.push(obj.startBinding ? [obj.startBinding.objectId, round(obj.startBinding.ax), round(obj.startBinding.ay)] : null);
            base.push(obj.endBinding ? [obj.endBinding.objectId, round(obj.endBinding.ax), round(obj.endBinding.ay)] : null);
            return base;
        }
        case "polygon": {
            const points = obj.points.map((p) => [
                round(p.x),
                round(p.y),
                p.segment ? SEGMENT_CODES[p.segment] : 0,
            ]);
            return [
                3,
                obj.id,
                colors.add(obj.strokeColor),
                widths.add(round(obj.strokeWidth)),
                obj.fillColor !== undefined ? colors.add(obj.fillColor) : -1,
                obj.fillOpacity !== undefined ? round(obj.fillOpacity) : null,
                points,
                obj.isHighlighter ? 1 : 0,
            ];
        }
        case "rectangle": {
            return [
                4,
                obj.id,
                colors.add(obj.strokeColor),
                widths.add(round(obj.strokeWidth)),
                obj.fillColor !== undefined ? colors.add(obj.fillColor) : -1,
                obj.fillOpacity !== undefined ? round(obj.fillOpacity) : null,
                round(obj.x),
                round(obj.y),
                round(obj.width),
                round(obj.height),
                obj.rotation !== undefined ? round(obj.rotation) : 0,
                obj.isHighlighter ? 1 : 0,
            ];
        }
        case "triangle": {
            const w = obj.width ?? obj.size ?? 0;
            const h = obj.height ?? obj.size ?? 0;
            return [
                5,
                obj.id,
                obj.variant === "right" ? 1 : 0,
                colors.add(obj.strokeColor),
                widths.add(round(obj.strokeWidth)),
                obj.fillColor !== undefined ? colors.add(obj.fillColor) : -1,
                obj.fillOpacity !== undefined ? round(obj.fillOpacity) : null,
                round(obj.x),
                round(obj.y),
                round(w),
                round(h),
                obj.rotation !== undefined ? round(obj.rotation) : 0,
                obj.isHighlighter ? 1 : 0,
            ];
        }
        case "ellipse": {
            return [
                6,
                obj.id,
                colors.add(obj.strokeColor),
                widths.add(round(obj.strokeWidth)),
                obj.fillColor !== undefined ? colors.add(obj.fillColor) : -1,
                obj.fillOpacity !== undefined ? round(obj.fillOpacity) : null,
                round(obj.cx),
                round(obj.cy),
                round(obj.rx),
                round(obj.ry),
                obj.rotation !== undefined ? round(obj.rotation) : 0,
                obj.isHighlighter ? 1 : 0,
            ];
        }
        case "diamond": {
            return [
                7,
                obj.id,
                colors.add(obj.strokeColor),
                widths.add(round(obj.strokeWidth)),
                obj.fillColor !== undefined ? colors.add(obj.fillColor) : -1,
                obj.fillOpacity !== undefined ? round(obj.fillOpacity) : null,
                round(obj.x),
                round(obj.y),
                round(obj.width),
                round(obj.height),
                obj.rotation !== undefined ? round(obj.rotation) : 0,
                obj.isHighlighter ? 1 : 0,
            ];
        }
    }
}

function decodeObject(tuple: any[], colors: string[], widths: number[]): VectorObject {
    const tag = tuple[0];
    switch (tag) {
        case 0: {
            const [
                ,
                id,
                highlighterFlag,
                colorIdx,
                pressureEnabledFlag,
                pressureMinFactor,
                curveCode,
                strokeWidthIdx,
                points
            ] = tuple;
            const strokePoints: StrokePoint[] = points.map((p: any[]) => ({
                x: p[0],
                y: p[1],
                p: p[2] === null ? undefined : p[2],
                w: 0,
                t: p[3] ?? 0,
            }));
            const curve: PressureCurve = curveCode === 0 ? "linear" :
                curveCode === 1 ? "quadratic" :
                    curveCode === 2 ? "sqrt" : "ease";
            return {
                id,
                type: "freehand",
                points: strokePoints,
                color: colors[colorIdx],
                highlighter: highlighterFlag === 1,
                pressureEnabled: pressureEnabledFlag === 1,
                pressureMinFactor: pressureMinFactor,
                pressureCurve: curve,
                strokeWidth: widths[strokeWidthIdx],
            } as FreehandObject;
        }
        case 1:
        case 2: {
            const isArrowTag = tag === 2;
            const [, id, colorIdx, widthIdx, ...rest] = tuple;
            const arrowStart = isArrowTag ? rest[0] === 1 : undefined;
            const arrowEnd = isArrowTag ? rest[1] === 1 : undefined;
            const rawPoints = isArrowTag ? rest[2] : rest[0];
            const highlighterFlag = isArrowTag ? rest[3] : rest[1];
            const rawArrowSize = isArrowTag ? rest[4] : undefined;
            // NEU: Beschriftung + Bindungen (fehlen bei älteren Dateien -> undefined)
            const rawLabel = isArrowTag ? rest[5] : rest[2];
            const rawStartBinding = isArrowTag ? rest[6] : rest[3];
            const rawEndBinding = isArrowTag ? rest[7] : rest[4];

            const linePoints: LinePoint[] = rawPoints.map((p: any[]) => ({
                x: p[0], y: p[1],
                segment: SEGMENT_NAMES[p[2]],
            }));
            const isHighlighter = highlighterFlag === 1;

            const label = rawLabel
                ? { text: rawLabel[0], fontSize: rawLabel[1] ?? undefined, color: rawLabel[2] ?? undefined, mode: rawLabel[3] }
                : undefined;
            const startBinding = rawStartBinding
                ? { objectId: rawStartBinding[0], ax: rawStartBinding[1], ay: rawStartBinding[2] }
                : undefined;
            const endBinding = rawEndBinding
                ? { objectId: rawEndBinding[0], ax: rawEndBinding[1], ay: rawEndBinding[2] }
                : undefined;

            if (isArrowTag) {
                const arrowSize = (typeof rawArrowSize === "number") ? rawArrowSize : undefined;
                return {
                    id, type: "arrow",
                    color: colors[colorIdx], width: widths[widthIdx],
                    arrowStart, arrowEnd, points: linePoints,
                    isHighlighter, arrowSize,
                    label, startBinding, endBinding,
                } as ArrowObject;
            }
            return {
                id, type: "line", color: colors[colorIdx], width: widths[widthIdx], points: linePoints, isHighlighter,
                label, startBinding, endBinding,
            } as LineObject;
        }
        case 3: {
            const [, id, strokeColorIdx, strokeWidthIdx, fillColorIdx, fillOpacity, points, highlighterFlag, rawLabel] = tuple;
            return {
                id, type: "polygon",
                strokeColor: colors[strokeColorIdx], strokeWidth: widths[strokeWidthIdx],
                fillColor: fillColorIdx === -1 ? undefined : colors[fillColorIdx],
                fillOpacity: fillOpacity === null ? undefined : fillOpacity,
                points: points.map((p: any[]) => ({
                    x: p[0],
                    y: p[1],
                    segment: p.length >= 3 ? SEGMENT_NAMES[p[2]] : undefined,
                })),
                isHighlighter: highlighterFlag === 1,
                label: rawLabel ? { text: rawLabel[0], fontSize: rawLabel[1] ?? undefined, color: rawLabel[2] ?? undefined } : undefined,
            } as PolygonObject;
        }
        case 4: {
            const [, id, strokeColorIdx, strokeWidthIdx, fillColorIdx, fillOpacity, x, y, width, height, rotation, highlighterFlag, rawLabel] = tuple;
            return {
                id, type: "rectangle",
                strokeColor: colors[strokeColorIdx], strokeWidth: widths[strokeWidthIdx],
                fillColor: fillColorIdx === -1 ? undefined : colors[fillColorIdx],
                fillOpacity: fillOpacity === null ? undefined : fillOpacity,
                x, y, width, height, rotation: rotation || undefined,
                isHighlighter: highlighterFlag === 1,
                label: rawLabel ? { text: rawLabel[0], fontSize: rawLabel[1] ?? undefined, color: rawLabel[2] ?? undefined } : undefined,
            } as RectangleObject;
        }
        case 5: {
            if (tuple.length >= 13) {
                const [, id, variantCode, strokeColorIdx, strokeWidthIdx, fillColorIdx, fillOpacity,
                    x, y, width, height, rotation, highlighterFlag, rawLabel] = tuple;
                return {
                    id, type: "triangle",
                    variant: variantCode === 1 ? "right" : "equilateral",
                    strokeColor: colors[strokeColorIdx], strokeWidth: widths[strokeWidthIdx],
                    fillColor: fillColorIdx === -1 ? undefined : colors[fillColorIdx],
                    fillOpacity: fillOpacity === null ? undefined : fillOpacity,
                    x, y, width, height, rotation: rotation || undefined,
                    isHighlighter: highlighterFlag === 1,
                    label: rawLabel ? { text: rawLabel[0], fontSize: rawLabel[1] ?? undefined, color: rawLabel[2] ?? undefined } : undefined,
                } as TriangleObject;
            }
            const [, id, variantCode, strokeColorIdx, strokeWidthIdx, fillColorIdx, fillOpacity,
                x, y, size, rotation, highlighterFlag] = tuple;
            return {
                id, type: "triangle",
                variant: variantCode === 1 ? "right" : "equilateral",
                strokeColor: colors[strokeColorIdx], strokeWidth: widths[strokeWidthIdx],
                fillColor: fillColorIdx === -1 ? undefined : colors[fillColorIdx],
                fillOpacity: fillOpacity === null ? undefined : fillOpacity,
                x, y, width: size, height: size, rotation: rotation || undefined,
                isHighlighter: highlighterFlag === 1,
            } as TriangleObject;
        }
        case 6: {
            const [, id, strokeColorIdx, strokeWidthIdx, fillColorIdx, fillOpacity, cx, cy, rx, ry, rotation, highlighterFlag, rawLabel] = tuple;
            return {
                id, type: "ellipse",
                strokeColor: colors[strokeColorIdx], strokeWidth: widths[strokeWidthIdx],
                fillColor: fillColorIdx === -1 ? undefined : colors[fillColorIdx],
                fillOpacity: fillOpacity === null ? undefined : fillOpacity,
                cx, cy, rx, ry, rotation: rotation || undefined,
                isHighlighter: highlighterFlag === 1,
                label: rawLabel ? { text: rawLabel[0], fontSize: rawLabel[1] ?? undefined, color: rawLabel[2] ?? undefined } : undefined,
            } as EllipseObject;
        }
        case 7: {
            const [, id, strokeColorIdx, strokeWidthIdx, fillColorIdx, fillOpacity, x, y, width, height, rotation, highlighterFlag, rawLabel] = tuple;
            return {
                id, type: "diamond",
                strokeColor: colors[strokeColorIdx], strokeWidth: widths[strokeWidthIdx],
                fillColor: fillColorIdx === -1 ? undefined : colors[fillColorIdx],
                fillOpacity: fillOpacity === null ? undefined : fillOpacity,
                x, y, width, height, rotation: rotation || undefined,
                isHighlighter: highlighterFlag === 1,
                label: rawLabel ? { text: rawLabel[0], fontSize: rawLabel[1] ?? undefined, color: rawLabel[2] ?? undefined } : undefined,
            } as DiamondObject;
        }
        default:
            throw new Error(`Unbekannter Vektorobjekt-Typ-Tag: ${tag}`);
    }
}