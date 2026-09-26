// OcrStrokeCollector.ts
//
// Sammelt die für OCR relevanten Vektorobjekte einer Seite (nur von Hand
// gezeichnete Freihand-Striche, KEINE Textmarker) und gruppiert sie
// heuristisch-geometrisch zu "Wörtern". Formen, Linien/Pfeile, Textmarker,
// Textblöcke und PDF-Anmerkungen werden bewusst NICHT berücksichtigt, da
// sie entweder bereits digitalen Text enthalten (PDF/Textblock/Anmerkung)
// oder keinen erkennbaren Text darstellen (Formen, Textmarker).

import { FreehandObject, VectorObject, StrokePoint } from "../types";

export interface StrokeBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface WordGroup {
    strokes: FreehandObject[];
    bounds: StrokeBounds;
}

export interface WordGroupingOptions {
    /** Faktor relativ zur MEDIAN-Strichhöhe, ab dem zwei Striche als "verschiedene Zeile" gelten (Vergleich der vertikalen Strichmitten). */
    lineGapFactor: number;
    /** Faktor relativ zur MEDIAN-Strichbreite, ab dem innerhalb einer Zeile ein neues Wort beginnt. */
    wordGapFactor: number;
    /**
     * Multiplikator auf lineGap/wordGap für einen zweiten Rettungs-Durchlauf:
     * kleine, nach dem ersten Durchlauf isoliert gebliebene Fragmente
     * (höchstens FRAGMENT_MAX_STROKES Striche – z. B. ein i-Punkt oder ein
     * einzeln angesetzter Buchstabenstrich) werden der naheliegendsten
     * Bounding Box zugeordnet, sofern der Abstand innerhalb dieses
     * (großzügigeren) Vielfachen liegt. Muss > 1.0 sein, sonst hat der
     * Durchlauf keine Wirkung. Normale, bereits im ersten Durchlauf
     * gebildete Cluster werden davon nicht berührt.
     */
    fragmentRescueFactor: number;
}

/** Cluster mit höchstens dieser Strichanzahl gelten als "Fragment" und sind für den Rettungs-Durchlauf zugelassen. */
const FRAGMENT_MAX_STROKES = 2;

/**
 * Liefert nur die für OCR relevanten Objekte einer Seite: von Hand
 * gezeichnete, NICHT als Textmarker markierte Freihand-Striche.
 */
export function collectEligibleStrokes(objects: VectorObject[]): FreehandObject[] {
    return objects.filter(
        (o): o is FreehandObject => o.type === "freehand" && o.highlighter !== true
    );
}

function strokeBounds(stroke: FreehandObject): StrokeBounds {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of stroke.points) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

function mergeBounds(list: StrokeBounds[]): StrokeBounds {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of list) {
        minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x + b.width);
        minY = Math.min(minY, b.y); maxY = Math.max(maxY, b.y + b.height);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

class DisjointSet {
    private parent: number[];
    constructor(n: number) {
        this.parent = Array.from({ length: n }, (_, i) => i);
    }
    find(x: number): number {
        while (this.parent[x] !== x) {
            this.parent[x] = this.parent[this.parent[x]];
            x = this.parent[x];
        }
        return x;
    }
    union(a: number, b: number): void {
        const ra = this.find(a), rb = this.find(b);
        if (ra !== rb) this.parent[ra] = rb;
    }
}

/** 0, wenn sich die Intervalle überlappen/berühren; sonst der positive Abstand. */
function intervalGap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
    if (aEnd < bStart) return bStart - aEnd;
    if (bEnd < aStart) return aStart - bEnd;
    return 0;
}

// ------------------------------------------------------------------
//  Gruppierung: Zeilen -> Wörter
// ------------------------------------------------------------------

/** Striche innerhalb dieses Höhenbereichs (relativ zum Median) bilden die Zeilen; alles andere wird über Bänder zugeordnet. */
const NORMAL_HEIGHT_MIN = 0.45;
const NORMAL_HEIGHT_MAX = 1.55;

interface StrokeInfo {
    stroke: FreehandObject;
    order: number;
    bounds: StrokeBounds;
    top: number;
    bottom: number;
    cy: number;
}

interface LineCluster {
    members: StrokeInfo[];
    /** Band der Zeile: Median von Ober-/Unterkante der "normalen" Striche. */
    top: number;
    bottom: number;
    medH: number;
    medW: number;
    /** Anzahl der Striche, aus denen die Statistik stammt (klein = unzuverlässig). */
    coreCount: number;
}

function toStrokeInfo(stroke: FreehandObject, order: number): StrokeInfo {
    const bounds = strokeBounds(stroke);
    return {
        stroke,
        order,
        bounds,
        top: bounds.y,
        bottom: bounds.y + bounds.height,
        cy: bounds.y + bounds.height / 2,
    };
}

function makeLine(members: StrokeInfo[], core: StrokeInfo[]): LineCluster {
    return {
        members,
        top: median(core.map(i => i.top)),
        bottom: median(core.map(i => i.bottom)),
        medH: median(core.map(i => i.bounds.height || 1)) || 1,
        medW: median(core.map(i => i.bounds.width || 1)) || 1,
        coreCount: core.length,
    };
}

function minHorizontalGap(info: StrokeInfo, line: LineCluster): number {
    let best = Infinity;
    const a0 = info.bounds.x;
    const a1 = a0 + info.bounds.width;
    for (const m of line.members) {
        const g = intervalGap(a0, a1, m.bounds.x, m.bounds.x + m.bounds.width);
        if (g < best) {
            best = g;
            if (best === 0) break;
        }
    }
    return best;
}

/**
 * Schritt 1+2: Bildet Zeilen aus Strichen "normaler" Größe (Union-Find über
 * Mittelpunkt-Nähe mit begrenzter horizontaler Reichweite, damit auch
 * schräge Zeilen als Kette zusammenhängen) und ordnet danach hohe Striche
 * (Ober-/Unterlängen) sowie kleine Striche (i-Punkte, Kommas) per
 * Band-Überlappung der passendsten Zeile zu. Striche, die zu keiner Zeile
 * passen (z. B. eine Überschrift in doppelter Größe), werden rekursiv mit
 * eigenen Größenstatistiken gruppiert.
 */
function buildLines(infos: StrokeInfo[], options: WordGroupingOptions, depth: number): LineCluster[] {
    if (infos.length === 0) return [];

    const medH = median(infos.map(i => i.bounds.height || 1)) || 1;
    const medW = median(infos.map(i => i.bounds.width || 1)) || 1;

    let normal = infos.filter(i => {
        const h = i.bounds.height || 1;
        return h >= medH * NORMAL_HEIGHT_MIN && h <= medH * NORMAL_HEIGHT_MAX;
    });
    if (normal.length === 0) normal = infos;
    const normalSet = new Set(normal);
    const others = infos.filter(i => !normalSet.has(i));

    const lineGap = medH * options.lineGapFactor;
    const wordGap = medW * options.wordGapFactor;
    const lineReach = Math.max(wordGap * 4, medH * 3);

    const sorted = [...normal].sort((a, b) => a.cy - b.cy);
    const uf = new DisjointSet(sorted.length);
    for (let a = 0; a < sorted.length; a++) {
        const ba = sorted[a].bounds;
        for (let b = a + 1; b < sorted.length; b++) {
            if (sorted[b].cy - sorted[a].cy > lineGap) break; // nach cy sortiert -> alle weiteren noch ferner
            const bb = sorted[b].bounds;
            if (intervalGap(ba.x, ba.x + ba.width, bb.x, bb.x + bb.width) <= lineReach) uf.union(a, b);
        }
    }

    const groups = new Map<number, StrokeInfo[]>();
    sorted.forEach((info, i) => {
        const root = uf.find(i);
        const list = groups.get(root) ?? [];
        list.push(info);
        groups.set(root, list);
    });
    const lines = Array.from(groups.values()).map(members => makeLine(members, members));

    const leftovers: StrokeInfo[] = [];
    for (const info of others) {
        const isTiny = (info.bounds.height || 1) < medH * NORMAL_HEIGHT_MIN;
        let best: LineCluster | null = null;
        let bestScore = -Infinity;

        for (const line of lines) {
            const hGap = minHorizontalGap(info, line);
            if (hGap > lineReach * 1.5) continue;

            const overlap = Math.max(0, Math.min(info.bottom, line.bottom) - Math.max(info.top, line.top));
            const band = Math.max(1, line.bottom - line.top);
            const frac = overlap / band;
            const dyGap = overlap > 0 ? 0 : Math.max(line.top - info.bottom, info.top - line.bottom);

            const fits = frac >= 0.3 || (isTiny && dyGap <= line.medH * 0.8);
            if (!fits) continue;

            const score = frac - 0.25 * (dyGap / line.medH) - 0.02 * (hGap / Math.max(line.medW, 1));
            if (score > bestScore) {
                bestScore = score;
                best = line;
            }
        }

        if (best) best.members.push(info);
        else leftovers.push(info);
    }

    if (leftovers.length > 0) {
        if (depth < 2 && leftovers.length < infos.length) {
            lines.push(...buildLines(leftovers, options, depth + 1));
        } else {
            for (const l of leftovers) lines.push(makeLine([l], [l]));
        }
    }

    return lines;
}

/**
 * Wählt den Wortabstand einer Zeile: Basis ist der Einstellungswert; gibt es
 * in der Abstandsverteilung der Zeile eine klare Lücke (Sprung >= 2,2x
 * zwischen "Buchstabenabstand" und "Wortabstand"), wird deren geometrische
 * Mitte verwendet - begrenzt auf 0,6x bis 1,8x der Basis.
 */
function adaptiveWordGap(gaps: number[], base: number): number {
    const positive = gaps.filter(g => g > 0).sort((a, b) => a - b);
    if (positive.length < 4) return base;

    let bestRatio = 1;
    let threshold = base;
    for (let k = 0; k < positive.length - 1; k++) {
        const lo = Math.max(positive[k], base * 0.05);
        const hi = positive[k + 1];
        const ratio = hi / lo;
        if (ratio >= 2.2 && ratio > bestRatio && hi >= base * 0.5) {
            bestRatio = ratio;
            threshold = Math.sqrt(lo * hi);
        }
    }
    return Math.max(base * 0.6, Math.min(base * 1.8, threshold));
}

/** Schritt 3: teilt die Striche einer Zeile (von links nach rechts) an Lücken in Wörter. */
function splitLineIntoWords(
    line: LineCluster,
    globalMedW: number,
    options: WordGroupingOptions
): { words: StrokeInfo[][]; threshold: number } {
    const sorted = [...line.members].sort((a, b) => a.bounds.x - b.bounds.x);
    const localW = line.coreCount >= 3 ? line.medW : globalMedW;
    const base = Math.max(1e-3, localW * options.wordGapFactor);

    const gaps: number[] = [];
    let runMax = sorted[0].bounds.x + sorted[0].bounds.width;
    for (let i = 1; i < sorted.length; i++) {
        gaps.push(Math.max(0, sorted[i].bounds.x - runMax));
        runMax = Math.max(runMax, sorted[i].bounds.x + sorted[i].bounds.width);
    }
    const threshold = adaptiveWordGap(gaps, base);

    const words: StrokeInfo[][] = [[sorted[0]]];
    runMax = sorted[0].bounds.x + sorted[0].bounds.width;
    for (let i = 1; i < sorted.length; i++) {
        const s = sorted[i];
        if (s.bounds.x - runMax > threshold) words.push([s]);
        else words[words.length - 1].push(s);
        runMax = Math.max(runMax, s.bounds.x + s.bounds.width);
    }
    return { words, threshold };
}

/**
 * Schritt 4: kleine, isoliert gebliebene Fragmente (i-Punkt, Komma, einzeln
 * angesetzter Strich) werden dem näheren Nachbarwort zugeschlagen, sofern der
 * Abstand innerhalb von threshold * rescueFactor liegt. Nur wirklich KLEINE
 * Fragmente (<= 0,7x Zeilenhöhe) - echte Einzelbuchstaben wie "I" oder "l"
 * bleiben eigenständige Wörter.
 */
function rescueFragments(
    words: StrokeInfo[][],
    line: LineCluster,
    threshold: number,
    rescueFactor: number
): StrokeInfo[][] {
    if (rescueFactor <= 1.0 || words.length < 2) return words;

    const list = words.map(w => ({ strokes: w, bounds: mergeBounds(w.map(i => i.bounds)) }));
    const maxGap = threshold * rescueFactor;

    let changed = true;
    while (changed) {
        changed = false;
        for (let i = 0; i < list.length; i++) {
            const c = list[i];
            if (c.strokes.length > FRAGMENT_MAX_STROKES) continue;
            if (Math.max(c.bounds.width, c.bounds.height) > line.medH * 0.7) continue;

            const prev = list[i - 1];
            const next = list[i + 1];
            const gp = prev ? intervalGap(c.bounds.x, c.bounds.x + c.bounds.width, prev.bounds.x, prev.bounds.x + prev.bounds.width) : Infinity;
            const gn = next ? intervalGap(c.bounds.x, c.bounds.x + c.bounds.width, next.bounds.x, next.bounds.x + next.bounds.width) : Infinity;
            const target = gp <= gn ? prev : next;
            if (!target || Math.min(gp, gn) > maxGap) continue;

            target.strokes.push(...c.strokes);
            target.bounds = mergeBounds([target.bounds, c.bounds]);
            list.splice(i, 1);
            changed = true;
            break;
        }
    }
    return list.map(c => c.strokes);
}

/**
 * Gruppiert Freihand-Striche zu "Wörtern": erst Zeilen (mit Bändern, damit
 * Ober-/Unterlängen und Punkte der richtigen Zeile zugeordnet werden), dann
 * je Zeile Wörter (zeilenlokaler, adaptiver Wortabstand), dann Rettung kleiner
 * Fragmente. Die Ergebnisse sind in Lesereihenfolge sortiert.
 *
 * Designentscheidung bleibt: im Zweifel eher zu fein (ein Wort in mehrere
 * Boxen) als zu grob gruppieren.
 */
export function groupStrokesIntoWords(
    strokes: FreehandObject[],
    options: WordGroupingOptions
): WordGroup[] {
    if (strokes.length === 0) return [];

    const all = strokes.map((s, i) => toStrokeInfo(s, i));
    const globalMedH = median(all.map(i => i.bounds.height || 1)) || 1;
    const globalMedW = median(all.map(i => i.bounds.width || 1)) || 1;

    // Unterstreichungen/Trennlinien (sehr lang und flach) sind kein Text und würden
    // ganze Zeilen zu einem "Wort" verschmelzen.
    const infos = all.filter(i =>
        !(i.bounds.width >= globalMedW * 6 && i.bounds.height <= globalMedH * 0.35)
    );
    if (infos.length === 0) return [];

    const lines = buildLines(infos, options, 0);
    lines.sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom));

    const groups: WordGroup[] = [];
    for (const line of lines) {
        if (line.members.length === 0) continue;
        const { words, threshold } = splitLineIntoWords(line, globalMedW, options);
        const rescued = rescueFragments(words, line, threshold, options.fragmentRescueFactor);
        for (const word of rescued) {
            word.sort((a, b) => a.order - b.order);
            groups.push({
                strokes: word.map(i => i.stroke),
                bounds: mergeBounds(word.map(i => i.bounds)),
            });
        }
    }
    return groups;
}

/**
 * Baut aus den Strichen einer Wortgruppe eine normalisierte Ink-Sequenz für
 * das Modell: [x, y, t] pro Punkt, x/y relativ zur Gruppen-Bounding-Box auf
 * die längere Kante normalisiert (Seitenverhältnis bleibt erhalten), t auf
 * 0..1 über die Gesamtdauer der Gruppe normalisiert. Mehrere Striche werden
 * zeitlich sortiert aneinandergereiht (Stift-Striche eines Worts werden i. d.
 * R. auch in dieser Reihenfolge gezeichnet).
 *
 * WICHTIG: Das exakte Eingabeformat von digitalink.tflite (Featureanzahl,
 * ggf. zusätzliches Pen-Up-Bit, Padding-Wert) ist nicht in Kurzform
 * dokumentiert. Diese Funktion setzt exakt das vom Nutzer vorgegebene
 * Format [x, y, t] um. Falls `model.inputs` in OcrModelRunner eine andere
 * Feature-Anzahl je Zeitschritt erwartet, hier anpassen.
 */
export function buildNormalizedInk(
    strokes: FreehandObject[],
    bounds: StrokeBounds,
    resampleSpacing: number = 0.02
): number[][] {
    let minT = Infinity, maxT = -Infinity;
    for (const stroke of strokes) {
        for (const p of stroke.points) {
            minT = Math.min(minT, p.t);
            maxT = Math.max(maxT, p.t);
        }
    }
    const tSpan = Math.max(1, maxT - minT);
    const scale = Math.max(bounds.width, bounds.height, 1);

    const allPoints: NormalizedPoint[] = [];
    for (const stroke of strokes) {
        const normalized: NormalizedPoint[] = (stroke.points as StrokePoint[]).map(p => ({
            x: (p.x - bounds.x) / scale,
            y: (p.y - bounds.y) / scale,
            t: (p.t - minT) / tSpan,
        }));
        const resampled = resampleNormalizedPoints(normalized, resampleSpacing);
        allPoints.push(...resampled);
    }
    allPoints.sort((a, b) => a.t - b.t);
    return allPoints.map(p => [p.x, p.y, p.t]);
}

interface NormalizedPoint {
    x: number;
    y: number;
    t: number;
}

/**
 * Interpoliert entlang einer Punktfolge (bereits normalisiert, x/y i. d. R.
 * in [0,1]) zusätzliche Zwischenpunkte per linearer Bogenlängen-Abtastung,
 * sodass aufeinanderfolgende Punkte höchstens `spacing` (in denselben
 * normalisierten Einheiten) auseinanderliegen. x, y und t werden linear
 * zwischen den beiden umgebenden Originalpunkten interpoliert.
 *
 * Rekonstruiert NICHT die durch Douglas-Peucker entfernte tatsächliche
 * Krümmung – zwischen zwei erhaltenen Punkten wird eine Gerade angenommen.
 * Das ist dieselbe Näherung, die Douglas-Peucker selbst beim Entscheiden,
 * welche Punkte "entbehrlich" sind, zugrunde legt (Toleranz = maximale
 * Abweichung von genau dieser Geraden) – die Interpolation macht die
 * Näherung also nicht schlechter als sie durch die Vereinfachung ohnehin
 * schon ist, gleicht aber die MODELLSEITIG erwartete Punktdichte wieder an.
 *
 * WICHTIG: Für ein damit konsistentes Modell muss exakt dieselbe Funktion
 * (Portierung nach Python) auf bereits Douglas-Peucker-vereinfachte
 * Trainingsstriche angewendet werden – siehe README-Ergänzung weiter unten.
 */
function resampleNormalizedPoints(points: NormalizedPoint[], spacing: number): NormalizedPoint[] {
    if (points.length < 2 || spacing <= 0) return points;

    const result: NormalizedPoint[] = [points[0]];
    let carry = 0; // bereits "verbrauchte" Distanz aus dem vorherigen Segment

    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        const segLength = Math.hypot(dx, dy);
        if (segLength === 0) continue;

        let distanceAlongSegment = spacing - carry;
        while (distanceAlongSegment < segLength) {
            const frac = distanceAlongSegment / segLength;
            result.push({
                x: prev.x + dx * frac,
                y: prev.y + dy * frac,
                t: prev.t + (curr.t - prev.t) * frac,
            });
            distanceAlongSegment += spacing;
        }
        carry = distanceAlongSegment - segLength;
    }

    const last = points[points.length - 1];
    const lastResult = result[result.length - 1];
    if (lastResult.x !== last.x || lastResult.y !== last.y || lastResult.t !== last.t) {
        result.push(last);
    }
    return result;
}