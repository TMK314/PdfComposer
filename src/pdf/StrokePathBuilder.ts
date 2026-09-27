// StrokePathBuilder.ts
//
// Gemeinsame Geometrie-Erzeugung für Freihand-Striche mit variabler
// (druckabhängiger) Strichbreite. Wird sowohl von der Live-Ansicht
// (PdfComposeView, SVG im Browser) als auch vom PDF-Export
// (PdfExporter, pdf-lib) verwendet, damit ein exportiertes PDF exakt
// denselben Strichverlauf zeigt wie die Bearbeitungsansicht.
//
// KERNPROBLEM & LÖSUNG:
// Ein Strich mit variabler Breite wird als "Ribbon" (linke + rechte
// Versatzkontur um die Mittellinie) gezeichnet. An scharfen Spitzen
// (Zeichenrichtung kehrt nahezu um) überschneiden sich die beiden
// Konturseiten lokal - ohne Gegenmaßnahme entsteht dort eine sichtbar
// auf Breite 0 zulaufende Einschnürung. Ein früherer Ansatz hat die
// Breite an solchen Stellen künstlich gegen 0 verjüngt, um die
// Überschneidung zu vermeiden - das erzeugte aber genau die sichtbare
// Einschnürung. Stattdessen wird hier:
//
//   1. der Strich VOR der Ribbon-Berechnung nachverdichtet
//      (resampleForRibbon): zusätzliche Punkte werden so eingefügt,
//      dass der Abstand zweier aufeinanderfolgender Punkte nie größer
//      als etwa der halbe lokale Radius ist. Das begrenzt die räumliche
//      Ausdehnung einer eventuellen Selbstüberschneidung auf einen sehr
//      kleinen, lokalen Bereich - unabhängig davon, wie weit zwei
//      ORIGINALE (durch Douglas-Peucker vereinfachte) Punkte
//      auseinanderliegen.
//   2. an JEDEM (auch nachverdichteten) Punkt ein voller Kreis mit dem
//      dortigen Radius in denselben Pfad gezeichnet ("Stamping", wie ein
//      Rundkopf-/Rundgelenk-Pinsel). Da der gesamte Pfad in einem Zug
//      mit der Füllregel "nonzero" gefüllt wird, deckt jeder zusätzliche
//      geschlossene Kreisumlauf jede Stelle ab, an der die Ribbon-Kontur
//      lokal eine Wickelzahl von 0 hätte. In Kombination mit Schritt 1
//      ist der Abstand zwischen zwei Kreisen immer klein genug, dass
//      keine Lücke entstehen kann.
//
// Als Nebeneffekt werden Ecken/Spitzen dadurch automatisch rund statt
// spitz/kantig - genau das gewünschte weichere Erscheinungsbild.

export interface RibbonPoint {
    x: number;
    y: number;
    w: number;
}

/** Minimale Teilmenge von StrokePoint, die für die Ribbon-Berechnung benötigt wird. */
export interface RibbonInputPoint {
    x: number;
    y: number;
    w: number;
}

interface Pt { x: number; y: number; }

/** Faktor für Tangentenlänge in centripetalControlPoints: 0 = Polyline, 0.5 = maximal weich. */
const TANGENT_HANDLE_FACTOR = 0.5;

/** Reine (zustandslose) Variante von PdfComposeView.cornerSharpnessFactor. */
function cornerSharpnessFactor(prev: Pt, curr: Pt, next: Pt): number {
    const inX = curr.x - prev.x, inY = curr.y - prev.y;
    const outX = next.x - curr.x, outY = next.y - curr.y;
    const inLen = Math.hypot(inX, inY);
    const outLen = Math.hypot(outX, outY);
    if (inLen < 1e-6 || outLen < 1e-6) return 1;
    const cos = Math.max(-1, Math.min(1, (inX * outX + inY * outY) / (inLen * outLen)));
    if (cos <= 0) return 0;
    return cos * cos * cos;
}

/**
 * Tangenten-Handles für einen kubischen Bezier-Übergang p1→p2.
 *
 * Richtung: gemittelter Nachbarvektor (p0→p2 für c1, p1→p3 für c2).
 * Länge:    proportional zur Länge des aktuellen Segments p1→p2
 *           (Faktor 0.4), nicht zur Nachbardistanz. Siehe ausführlicher
 *           Kommentar in PdfComposeView.centripetalControlPoints.
 */
export function centripetalControlPoints(
    p0: Pt, p1: Pt, p2: Pt, p3: Pt,
    applyCornerDamping: boolean = false,
    handleFactor: number = TANGENT_HANDLE_FACTOR,
): { c1: Pt; c2: Pt } {
    let d1x = p2.x - p0.x;
    let d1y = p2.y - p0.y;
    let d2x = p3.x - p1.x;
    let d2y = p3.y - p1.y;

    if (Math.hypot(d1x, d1y) < 1e-9) {
        d1x = p2.x - p1.x;
        d1y = p2.y - p1.y;
    }
    if (Math.hypot(d2x, d2y) < 1e-9) {
        d2x = p2.x - p1.x;
        d2y = p2.y - p1.y;
    }

    const n1 = Math.hypot(d1x, d1y) || 1;
    const n2 = Math.hypot(d2x, d2y) || 1;
    d1x /= n1; d1y /= n1;
    d2x /= n2; d2y /= n2;

    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const handleLen = segLen * handleFactor;

    let damp1 = 1, damp2 = 1;
    if (applyCornerDamping) {
        damp1 = cornerSharpnessFactor(p0, p1, p2);
        damp2 = cornerSharpnessFactor(p1, p2, p3);
    }

    return {
        c1: { x: p1.x + d1x * handleLen * damp1, y: p1.y + d1y * handleLen * damp1 },
        c2: { x: p2.x - d2x * handleLen * damp2, y: p2.y - d2y * handleLen * damp2 },
    };
}

/** SVG-Pfad-Fragment für einen vollen Kreis (Radius r, Mittelpunkt x/y) - dient als Rundkappen-/Rundgelenk-"Stempel". */
function circleStamp(x: number, y: number, r: number): string {
    if (r <= 0.01) return "";
    return ` M ${x - r} ${y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
}

/** Ab welchem Winkel (Cosinus zwischen Ein-/Ausgangsrichtung) ein Knick als "scharf" gilt und einen echten Rundungs-Bogen statt reiner Bezier-Glättung bekommt. Kleinerer Wert = mehr Knicke gelten als scharf (0.85 ≈ 32°). */
const SHARP_CORNER_COS_THRESHOLD = 0.85;

interface OffsetPoint { x: number; y: number; }

interface OffsetContour {
    nodes: OffsetPoint[];
    /** Schlüssel = Knotenindex; die Kante VON diesem Knoten ZUM NÄCHSTEN ist ein Kreisbogen (statt einer Bezier-Kurve). */
    arcAfter: Map<number, { radius: number; sweepFlag: 0 | 1 }>;
}

/**
 * Baut die Offset-Kontur einer Seite (side = +1 links, -1 rechts). An
 * scharfen Knicken (sharpAt[i]) werden statt eines einzelnen, gemittelten
 * Normalen-Offsets ZWEI Punkte erzeugt (Offset der eingehenden bzw.
 * ausgehenden Segmentrichtung) und über einen echten Kreisbogen verbunden -
 * ein "round join" mit individuellem Radius (= lokale Strichbreite/2), wie
 * ihn stroke-linejoin:round bei fester Breite liefert.
 *
 * Ersetzt die früheren Kreis-"Stempel": statt eines kompletten, separaten,
 * sich überlappenden Unterpfads pro Knick reicht EIN zusätzlicher
 * Bogenbefehl in derselben Kontur - deutlich billiger, und da Radius und
 * Sweep-Richtung exakt dem fehlenden Eckenstück entsprechen, sieht die Ecke
 * dabei tatsächlich rund aus statt nur "nicht ganz gerade".
 */
function buildOffsetContour(dense: RibbonPoint[], sharpAt: boolean[], side: 1 | -1): OffsetContour {
    const nodes: OffsetPoint[] = [];
    const arcAfter = new Map<number, { radius: number; sweepFlag: 0 | 1 }>();

    for (let i = 0; i < dense.length; i++) {
        const prev = dense[i - 1] ?? dense[i];
        const next = dense[i + 1] ?? dense[i];
        const r = dense[i].w / 2;

        if (sharpAt[i]) {
            let inX = dense[i].x - prev.x, inY = dense[i].y - prev.y;
            let outX = next.x - dense[i].x, outY = next.y - dense[i].y;
            const inLen = Math.hypot(inX, inY) || 1; inX /= inLen; inY /= inLen;
            const outLen = Math.hypot(outX, outY) || 1; outX /= outLen; outY /= outLen;

            // Normale = 90°-Rotation der jeweiligen Segmentrichtung.
            const nInX = -inY * side, nInY = inX * side;
            const nOutX = -outY * side, nOutY = outX * side;

            nodes.push({ x: dense[i].x + nInX * r, y: dense[i].y + nInY * r });
            const inIndex = nodes.length - 1;
            nodes.push({ x: dense[i].x + nOutX * r, y: dense[i].y + nOutY * r });

            // Drehrichtung des Knicks: dasselbe Vorzeichen gilt (die 90°-
            // Rotation kommutiert mit der Drehung zwischen Ein- und
            // Ausgangsrichtung) für BEIDE Konturseiten - ein Kreuzprodukt genügt.
            const cross = inX * outY - inY * outX;
            arcAfter.set(inIndex, { radius: r, sweepFlag: cross >= 0 ? 1 : 0 });
        } else {
            let dx = next.x - prev.x, dy = next.y - prev.y;
            const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
            const nx = -dy * side, ny = dx * side;
            nodes.push({ x: dense[i].x + nx * r, y: dense[i].y + ny * r });
        }
    }
    return { nodes, arcAfter };
}

/** Kehrt eine Offset-Kontur um (für die Rückseite des Ribbons) und verschiebt dabei die Bogen-Markierungen korrekt auf die neuen Kantenindizes - eine naive Array-Umkehr würde den Bogen am falschen Knoten belassen. */
function reverseOffsetContour(contour: OffsetContour): OffsetContour {
    const n = contour.nodes.length;
    const nodes = [...contour.nodes].reverse();
    const arcAfter = new Map<number, { radius: number; sweepFlag: 0 | 1 }>();
    for (const [fromIdx, info] of contour.arcAfter) {
        // Kante (fromIdx -> fromIdx+1) liegt nach der Umkehr bei (n-2-fromIdx -> n-1-fromIdx).
        arcAfter.set(n - 2 - fromIdx, info);
    }
    return { nodes, arcAfter };
}

/** Baut die Pfaddaten einer Offset-Kontur: Bezier-Glättung zwischen normalen Ankern, echte Kreisbögen an den als "arc" markierten Kanten (scharfe Knicke). */
function offsetContourToPathData(contour: OffsetContour, includeMoveTo: boolean): string {
    const { nodes, arcAfter } = contour;
    if (nodes.length === 0) return "";
    if (nodes.length === 1) {
        return `${includeMoveTo ? "M" : "L"} ${nodes[0].x} ${nodes[0].y}`;
    }

    let d = includeMoveTo ? `M ${nodes[0].x} ${nodes[0].y}` : `L ${nodes[0].x} ${nodes[0].y}`;
    for (let i = 0; i < nodes.length - 1; i++) {
        const arc = arcAfter.get(i);
        if (arc) {
            d += ` A ${arc.radius} ${arc.radius} 0 0 ${arc.sweepFlag} ${nodes[i + 1].x} ${nodes[i + 1].y}`;
            continue;
        }
        const p0 = nodes[i - 1] ?? nodes[i];
        const p1 = nodes[i];
        const p2 = nodes[i + 1];
        const p3 = nodes[i + 2] ?? p2;
        const { c1, c2 } = centripetalControlPoints(p0, p1, p2, p3, false);
        d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
    }
    return d;
}

function ptDist(a: Pt, b: Pt): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Abstand eines Punkts zur Geraden durch a-b. */
function distToLine(p: Pt, a: Pt, b: Pt): number {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return ptDist(p, a);
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Hermite-Interpolation der Breite über ein Segment (t in 0..1). */
function hermiteWidth(w0: number, w1: number, m0: number, m1: number, t: number): number {
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * w0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * w1 + (t3 - t2) * m1;
}

/** Monotone Steigung (Fritsch-Carlson-artig): an Extrema 0, sonst begrenzt -> kein Überschwingen. */
function widthSlope(prev: number, cur: number, next: number): number {
    const dPrev = cur - prev;
    const dNext = next - cur;
    if (dPrev * dNext <= 0) return 0;
    const avg = (dPrev + dNext) / 2;
    const limit = 3 * Math.min(Math.abs(dPrev), Math.abs(dNext));
    return Math.sign(avg) * Math.min(Math.abs(avg), limit);
}

/**
 * Tastet die Mittellinie mit derselben Catmull-Rom-Kurve ab, die auch der
 * gleichmäßige Strich verwendet (Faktor 0.4), und interpoliert die Breite
 * dazwischen monoton kubisch. Erst aus diesen dichten Punkten wird die
 * Ribbon-Kontur gebaut - dadurch sind Verlauf UND Breitenwechsel glatt,
 * auch zwischen weit auseinanderliegenden (vereinfachten) Stützpunkten.
 */
function sampleSmoothedStroke(points: RibbonInputPoint[]): RibbonPoint[] {
    const pts: RibbonPoint[] = [];
    for (const p of points) {
        const last = pts[pts.length - 1];
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-6) {
            last.w = Math.max(last.w, p.w);
        } else {
            pts.push({ x: p.x, y: p.y, w: p.w });
        }
    }
    if (pts.length < 2) return pts;

    const out: RibbonPoint[] = [{ ...pts[0] }];
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] ?? pts[i];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[i + 2] ?? p2;

        const segLen = ptDist(p1, p2);
        const avgRadius = (p1.w + p2.w) / 4;
        const { c1, c2 } = centripetalControlPoints(p0, p1, p2, p3, false, 0.4);

        // Gerades Segment mit konstanter Breite braucht keine Unterteilung
        const deviation = Math.max(distToLine(c1, p1, p2), distToLine(c2, p1, p2));
        const flat = deviation < 0.25 && Math.abs(p2.w - p1.w) < 0.05;
        const step = flat
            ? Math.max(avgRadius, 0.5) * 6
            : Math.min(2.5, Math.max(0.6, avgRadius * 0.8));
        const n = Math.min(64, Math.max(1, Math.ceil(segLen / step)));

        if (n > 1) {
            const m1 = widthSlope(p0.w, p1.w, p2.w);
            const m2 = widthSlope(p1.w, p2.w, p3.w);
            const wMin = Math.min(p1.w, p2.w), wMax = Math.max(p1.w, p2.w);
            for (let s = 1; s < n; s++) {
                const t = s / n;
                const mt = 1 - t;
                const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
                const w = hermiteWidth(p1.w, p2.w, m1, m2, t);
                out.push({
                    x: a * p1.x + b * c1.x + c * c2.x + d * p2.x,
                    y: a * p1.y + b * c1.y + c * c2.y + d * p2.y,
                    w: Math.max(wMin, Math.min(wMax, w)),
                });
            }
        }
        out.push({ ...p2 });
    }
    return out;
}

/**
 * Scharfe Ecken über ein Fenster von etwa einem Radius erkennen statt nur über
 * die direkten Nachbarn - bei sehr dichten Punkten (Sensorrauschen) ergäben
 * sich sonst viele Pseudo-Ecken.
 */
function computeSharpFlags(dense: RibbonPoint[]): boolean[] {
    const flags: boolean[] = new Array(dense.length).fill(false);
    for (let i = 1; i < dense.length - 1; i++) {
        const look = Math.max(0.5, dense[i].w * 0.4);

        let a = i - 1;
        while (a > 0 && ptDist(dense[i], dense[a]) < look) a--;
        let b = i + 1;
        while (b < dense.length - 1 && ptDist(dense[i], dense[b]) < look) b++;

        const inX = dense[i].x - dense[a].x, inY = dense[i].y - dense[a].y;
        const outX = dense[b].x - dense[i].x, outY = dense[b].y - dense[i].y;
        const inLen = Math.hypot(inX, inY) || 1;
        const outLen = Math.hypot(outX, outY) || 1;
        const cos = (inX * outX + inY * outY) / (inLen * outLen);
        flags[i] = cos < SHARP_CORNER_COS_THRESHOLD;
    }
    return flags;
}

export function buildVariableWidthPathData(points: RibbonInputPoint[]): string {
    if (points.length === 0) return "";
    if (points.length === 1) {
        return circleStamp(points[0].x, points[0].y, points[0].w / 2).trimStart();
    }

    const dense = sampleSmoothedStroke(points);
    if (dense.length < 2) {
        // Alle Punkte identisch -> ein Punkt
        const r = Math.max(...points.map(p => p.w)) / 2;
        return circleStamp(points[0].x, points[0].y, r).trimStart();
    }

    const sharpAt = computeSharpFlags(dense);

    const left = buildOffsetContour(dense, sharpAt, 1);
    const right = reverseOffsetContour(buildOffsetContour(dense, sharpAt, -1));

    let d = offsetContourToPathData(left, true);
    d += " " + offsetContourToPathData(right, false);
    d += " Z";

    // Kreis-"Stempel" (siehe Kopfkommentar) - bei dichten Punkten ausgedünnt (Abstand >= 1/4 Breite),
    // an Enden und scharfen Ecken immer gesetzt. Hält Pfadlänge und Renderaufwand im Rahmen.
    let lastStamp: RibbonPoint | null = null;
    for (let i = 0; i < dense.length; i++) {
        const p = dense[i];
        const mandatory = i === 0 || i === dense.length - 1 || sharpAt[i];
        if (!mandatory && lastStamp && ptDist(p, lastStamp) < Math.max(0.5, p.w * 0.25)) continue;
        d += circleStamp(p.x, p.y, p.w / 2);
        lastStamp = p;
    }

    return d;
}

/** true, wenn alle Breiten (annähernd) identisch sind - dann genügt ein einfacher Stroke mit fester Breite statt der teureren Ribbon-Geometrie. */
export function isUniformWidth(widths: number[]): boolean {
    if (widths.length === 0) return true;
    return widths.every(w => Math.abs(w - widths[0]) < 0.01);
}

/** Geglättete Mittellinie eines Freihand-Strichs (Catmull-Rom als Bézier) - Gegenstück zu PdfComposeView.smoothFreehandPathData. */
export function buildSmoothCenterlinePathData(points: { x: number; y: number }[]): string {
    if (points.length === 0) return "";
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
    if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;

    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] ?? points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] ?? p2;
        const { c1, c2 } = centripetalControlPoints(p0, p1, p2, p3, false, 0.4);
        d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
    }
    return d;
}