// Generischer, verlustfreier Text-Kompressor (LZW) mit ASCII-sicherer
// Ausgabe. Dient als zweite Kompressionsstufe nach der strukturellen
// Kodierung in VectorSerializer.ts.

function lzwCompress(input: string): number[] {
    const dict = new Map<string, number>();
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
    let dictSize = 256;
    let w = "";
    const result: number[] = [];

    for (const c of input) {
        const wc = w + c;
        if (dict.has(wc)) {
            w = wc;
        } else {
            result.push(dict.get(w)!);
            dict.set(wc, dictSize++);
            w = c;
        }
    }
    if (w !== "") result.push(dict.get(w)!);
    return result;
}

function lzwDecompress(codes: number[]): string {
    if (codes.length === 0) return "";
    const dict = new Map<number, string>();
    for (let i = 0; i < 256; i++) dict.set(i, String.fromCharCode(i));
    let dictSize = 256;

    let w = dict.get(codes[0])!;
    let result = w;
    for (let i = 1; i < codes.length; i++) {
        const k = codes[i];
        let entry: string;
        if (dict.has(k)) {
            entry = dict.get(k)!;
        } else if (k === dictSize) {
            entry = w + w[0];
        } else {
            throw new Error("Ungültige komprimierte Vektordaten (LZW-Code außerhalb des Wörterbuchs).");
        }
        result += entry;
        dict.set(dictSize++, w + entry[0]);
        w = entry;
    }
    return result;
}

// Variable-Length-Encoding (Varint) für die LZW-Codes, damit kleine Codes
// (die häufigsten) nur 1 Byte statt fester 2–3 Bytes belegen.
function packVarints(codes: number[]): Uint8Array {
    const bytes: number[] = [];
    for (let n of codes) {
        while (n >= 0x80) {
            bytes.push((n & 0x7f) | 0x80);
            n >>>= 7;
        }
        bytes.push(n);
    }
    return new Uint8Array(bytes);
}

function unpackVarints(bytes: Uint8Array): number[] {
    const codes: number[] = [];
    let n = 0;
    let shift = 0;
    for (const b of bytes) {
        n |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) {
            codes.push(n >>> 0);
            n = 0;
            shift = 0;
        } else {
            shift += 7;
        }
    }
    return codes;
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** Komprimiert einen beliebigen Text zu einem reinen ASCII-String (Base64). */
export function compressText(input: string): string {
    if (input.length === 0) return "";
    const codes = lzwCompress(input);
    const packed = packVarints(codes);
    return bytesToBase64(packed);
}

/** Kehrt compressText() um. */
export function decompressText(compressed: string): string {
    if (compressed.length === 0) return "";
    const bytes = base64ToBytes(compressed);
    const codes = unpackVarints(bytes);
    return lzwDecompress(codes);
}