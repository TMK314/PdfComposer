// FuzzySearch.ts
//
// Gemeinsame Hilfsfunktionen für die fehlertolerante Volltextsuche über
// PDF-Text, OCR-erkannte Handschrift, Textblöcke und PDF-Anmerkungen.
// Die Toleranz wird über eine maximale Levenshtein-Distanz gesteuert, die
// für OCR-Treffer bewusst größer gewählt werden kann als für PDF-Text.

export type SearchResultCategory = "pdf" | "ocr" | "textblock" | "annotation";

export interface SearchResultItem {
    category: SearchResultCategory;
    pageId: string;
    pageIndex: number;
    snippet: { before: string; match: string; after: string };
    /** Trefferrechtecke zur Hervorhebung auf der Seite; leer bei Textblöcken/Anmerkungen. */
    matches: { x: number; y: number; width: number; height: number }[];
    /** Levenshtein-Distanz dieses Treffers (bei OCR: Grundlage der Untergruppierung). */
    distance: number;
    blockId?: string
}

/** Klassische Levenshtein-Distanz (Editierdistanz) zwischen zwei Strings. */
export function levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // Ersetzen
                    matrix[i][j - 1] + 1,     // Einfügen
                    matrix[i - 1][j] + 1      // Löschen
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

export interface FuzzyTextMatch {
    /** Tatsächlich gefundenes Wort/Wortfolge (Original-Groß-/Kleinschreibung). */
    text: string;
    /** Levenshtein-Distanz zur Suchanfrage (0 = exakter Treffer, case-insensitive). */
    distance: number;
    /** Zeichenindex des Treffers innerhalb des übergebenen Textes. */
    charIndex: number;
}

const WORD_REGEX = /[\p{L}\p{N}]+/gu;

/**
 * Tokenisiert `text` in Wörter und vergleicht jede Folge von Wörtern
 * (Anzahl = Wortanzahl der Suchanfrage) mit `query` per Levenshtein-Distanz
 * (case-insensitive). Liefert alle Treffer mit Distanz <= maxDistance,
 * aufsteigend nach Distanz sortiert. maxDistance = 0 entspricht einem
 * exakten (case-insensitiven) Wort-/Phrasentreffer.
 */
export function findFuzzyTextMatches(
    text: string,
    query: string,
    baseMaxDistance: number
): FuzzyTextMatch[] {
    const trimmedQuery = query.trim();
    if (!trimmedQuery || !text) return [];
    const queryLower = trimmedQuery.toLowerCase();
    const queryWordCount = queryLower.split(/\s+/).length;

    const words: { text: string; index: number }[] = [];
    WORD_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_REGEX.exec(text)) !== null) {
        words.push({ text: m[0], index: m.index });
    }

    const matches: FuzzyTextMatch[] = [];

    // 1. Wortfolge-Fuzzy-Suche (wie gehabt)
    const maxAllowedDistance = Math.ceil((baseMaxDistance / 5) * queryWordCount);
    for (let i = 0; i + queryWordCount <= words.length; i++) {
        const slice = words.slice(i, i + queryWordCount);
        const candidateLower = slice.map(w => w.text.toLowerCase()).join(" ");
        const distance = levenshteinDistance(candidateLower, queryLower);
        if (distance <= maxAllowedDistance) {
            matches.push({
                text: slice.map(w => w.text).join(" "),
                distance,
                charIndex: slice[0].index,
            });
        }
    }

    // 2. Teilstring-Suche (nur wenn query ein einzelnes Wort ist)
    if (queryWordCount === 1) {
        const querySingle = queryLower;
        for (const word of words) {
            const wordLower = word.text.toLowerCase();
            // Prüfen, ob query als Teilstring vorkommt
            const indexInWord = wordLower.indexOf(querySingle);
            if (indexInWord !== -1) {
                // Position im Gesamttext
                const charIndex = word.index + indexInWord;
                // Vermeiden von Duplikaten: Prüfen, ob bereits ein Match mit gleichem charIndex existiert
                const alreadyExists = matches.some(m => m.charIndex === charIndex && m.text === querySingle);
                if (!alreadyExists) {
                    matches.push({
                        text: querySingle, // oder das gefundene Wort? Besser den gefundenen Teilstring
                        distance: 0,
                        charIndex,
                    });
                }
            }
        }
    }

    matches.sort((a, b) => a.distance - b.distance);
    return matches;
}

/**
 * Wie findFuzzyTextMatches, arbeitet aber direkt auf einer Liste bereits
 * segmentierter "Wörter" (z. B. OCR-erkannte Wörter mit eigener Bounding
 * Box) statt auf einem Fließtext. Gibt für jeden Treffer die beteiligten
 * Wort-Indizes zurück, damit der Aufrufer die zugehörigen Bounding-Boxen
 * zusammenführen kann.
 */
export function findFuzzyWordSequenceMatches<T extends { text: string }>(
    words: T[],
    query: string,
    maxDistance: number
): { distance: number; startIndex: number; endIndex: number; text: string }[] {
    const trimmedQuery = query.trim();
    if (!trimmedQuery || words.length === 0) return [];
    const queryLower = trimmedQuery.toLowerCase();
    const queryWordCount = queryLower.split(/\s+/).length;

    const matches: { distance: number; startIndex: number; endIndex: number; text: string }[] = [];
    for (let i = 0; i + queryWordCount <= words.length; i++) {
        const slice = words.slice(i, i + queryWordCount);
        const candidateLower = slice.map(w => w.text.toLowerCase()).join(" ");
        const distance = levenshteinDistance(candidateLower, queryLower);
        if (distance <= maxDistance) {
            matches.push({
                distance,
                startIndex: i,
                endIndex: i + queryWordCount - 1,
                text: slice.map(w => w.text).join(" "),
            });
        }
    }
    matches.sort((a, b) => a.distance - b.distance);
    return matches;
}