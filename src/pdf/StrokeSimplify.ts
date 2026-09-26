import { StrokePoint } from "../types";

function perpendicularDistance(
    point: { x: number; y: number },
    lineStart: { x: number; y: number },
    lineEnd: { x: number; y: number }
): number {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) {
        return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
    }
    const t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lengthSq;
    const projX = lineStart.x + t * dx;
    const projY = lineStart.y + t * dy;
    return Math.hypot(point.x - projX, point.y - projY);
}

/**
 * Ramer-Douglas-Peucker mit zweitem Kriterium: Ein Punkt bleibt auch dann
 * erhalten, wenn seine Strichbreite (Druck) stark von der linearen
 * Interpolation zwischen den Endpunkten abweicht. Ohne das gingen
 * Druckverläufe auf geraden Abschnitten verloren, und die Breite lief später
 * mit sichtbaren Knicken zwischen weit entfernten Punkten.
 *
 * Bewertet wird pro Punkt max(Lagefehler / tolerance, Breitenfehler / widthTolerance);
 * geteilt wird am Punkt mit dem größten Wert, sofern er über 1 liegt.
 */
function douglasPeucker(points: StrokePoint[], tolerance: number, widthTolerance: number): StrokePoint[] {
    const n = points.length;
    if (n < 3) return points;

    const first = points[0];
    const last = points[n - 1];
    const tol = Math.max(tolerance, 1e-6);

    // Kumulierte Bogenlänge -> Position des Punkts entlang des Abschnitts (0..1)
    const cum: number[] = new Array(n);
    cum[0] = 0;
    for (let i = 1; i < n; i++) {
        cum[i] = cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    const total = cum[n - 1];

    let maxScore = 0;
    let maxIndex = 0;
    for (let i = 1; i < n - 1; i++) {
        const geom = perpendicularDistance(points[i], first, last) / tol;
        let wErr = 0;
        if (Number.isFinite(widthTolerance)) {
            const frac = total > 0 ? cum[i] / total : i / (n - 1);
            const interpolated = first.w + (last.w - first.w) * frac;
            wErr = Math.abs(points[i].w - interpolated) / widthTolerance;
        }
        const score = Math.max(geom, wErr);
        if (score > maxScore) {
            maxScore = score;
            maxIndex = i;
        }
    }

    if (maxScore > 1) {
        const left = douglasPeucker(points.slice(0, maxIndex + 1), tolerance, widthTolerance);
        const right = douglasPeucker(points.slice(maxIndex), tolerance, widthTolerance);
        return left.slice(0, -1).concat(right);
    }
    return [first, last];
}

/**
 * Vereinfacht einen frisch gezeichneten Strich. Die visuelle Rundung
 * übernimmt beim Rendern die Bézier-Interpolation. tolerance ist in
 * PDF-Punkten. Bei Strichen mit Druckverlauf wird zusätzlich die Breite
 * berücksichtigt (Toleranz = 8 % der Breitenspanne des Strichs).
 */
export function simplifyStroke(points: StrokePoint[], tolerance: number = 0.6): StrokePoint[] {
    if (points.length < 3) return points;

    let minW = Infinity, maxW = -Infinity;
    for (const p of points) {
        if (p.w < minW) minW = p.w;
        if (p.w > maxW) maxW = p.w;
    }
    const range = maxW - minW;
    const widthTolerance = range > 0.05 ? Math.max(0.04, range * 0.08) : Infinity;

    return douglasPeucker(points, tolerance, widthTolerance);
}