export function splitHexAlpha(hex: string): { rgb: string; alpha: number } {
    if (/^#[0-9a-fA-F]{8}$/.test(hex)) {
        return { rgb: hex.slice(0, 7), alpha: parseInt(hex.slice(7, 9), 16) / 255 };
    }
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
        return { rgb: hex, alpha: 1 };
    }
    return { rgb: "#000000", alpha: 1 };
}

export function combineHexAlpha(rgb: string, alpha: number): string {
    const clamped = Math.max(0, Math.min(1, alpha));
    // Bei voller Deckkraft bleibt es beim kompakten 6-stelligen Hex – das
    // hilft zusätzlich der Farb-Deduplizierung in VectorSerializer.ts.
    if (clamped >= 0.999) return rgb;
    const a = Math.round(clamped * 255).toString(16).padStart(2, "0");
    return `${rgb}${a}`;
}

function hexToHsl(hex: string): { h: number; s: number; l: number; a: number } {
    const { rgb, alpha } = splitHexAlpha(hex);
    const r = parseInt(rgb.slice(1, 3), 16) / 255;
    const g = parseInt(rgb.slice(3, 5), 16) / 255;
    const b = parseInt(rgb.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
        s = d / (1 - Math.abs(2 * l - 1));
        switch (max) {
            case r: h = ((g - b) / d) % 6; break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s, l, a: alpha };
}

function hslToHex(h: number, s: number, l: number, a: number): string {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
    return combineHexAlpha(`#${toHex(r)}${toHex(g)}${toHex(b)}`, a);
}

/**
 * Invertiert die Helligkeit (Lightness) einer Hex-Farbe (inkl. Alpha),
 * ohne Sättigung und Farbton zu verändern.
 */
export function invertLightness(hex: string): string {
    const { h, s, l, a } = hexToHsl(hex);
    return hslToHex(h, s, 1 - l, a);
}

/**
 * Liefert die für die Anzeige zu verwendende Farbe. Die gespeicherte
 * Farbe (storedColor) bleibt dabei immer unangetastet – invert
 * entscheidet nur, ob für die aktuelle Darstellung eine
 * helligkeits-invertierte Variante berechnet wird.
 */
export function resolveDisplayColor(storedColor: string, invert: boolean): string {
    return invert ? invertLightness(storedColor) : storedColor;
}