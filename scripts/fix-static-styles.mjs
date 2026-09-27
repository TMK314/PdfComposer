// scripts/fix-static-styles.mjs
//
// Wandelt zwei Muster automatisch in setCssStyles(...) um:
//   1. Aufeinanderfolgende Zeilen  `x.style.prop = value;`
//      (gleiches x, direkt untereinander) -> ein x.setCssStyles({ ... });
//   2. `Object.assign(x.style, { ... });` -> `x.setCssStyles({ ... });`
//
// WICHTIG: Das ist ein regexbasierter Codemod, kein echter Parser. Er
// deckt den weit überwiegenden Teil der Fälle ab, aber ungewöhnliche
// Schreibweisen (mehrzeilige Werte, Kommentare zwischen den Zeilen,
// `(x.style as any).prop = ...`) bitte danach manuell prüfen - der Diff
// zeigt genau, wo etwas verändert wurde.

import fs from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
    console.error("Usage: node fix-static-styles.mjs <file1> <file2> ...");
    process.exit(1);
}

// Erkennt eine einzelne "x.style.prop = value;"-Zeile (kein "as any"-Cast).
const SINGLE_RE = /^(\s*)([A-Za-z_$][\w$.?]*)\.style\.([A-Za-z][\w]*)\s*=\s*(.+?);\s*$/;

// Erkennt "(x.style as any).prop = value;"
const CAST_RE = /^(\s*)\(([A-Za-z_$][\w$.?]*)\.style as any\)\.([A-Za-z][\w]*)\s*=\s*(.+?);\s*$/;

function convertSingleRuns(text) {
    const lines = text.split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
        const m = SINGLE_RE.exec(lines[i]) || CAST_RE.exec(lines[i]);
        if (!m) { out.push(lines[i]); i++; continue; }

        const [, indent, target] = m;
        const isCast = CAST_RE.test(lines[i]);
        const group = [];
        let j = i;
        while (j < lines.length) {
            const mm = SINGLE_RE.exec(lines[j]) || CAST_RE.exec(lines[j]);
            if (!mm) break;
            if (mm[2] !== target) break;
            group.push(mm);
            j++;
        }

        if (group.length === 1 && !isCast) {
            // Einzelne Zeile: trotzdem umwandeln (Regel greift auch bei einer Property).
        }

        const props = group.map(mm => `${mm[3]}: ${mm[4]}`).join(", ");
        const needsCast = group.some((_, idx) => CAST_RE.test(lines[i + idx]));
        const call = needsCast
            ? `${indent}${target}.setCssStyles({ ${props} } as any);`
            : `${indent}${target}.setCssStyles({ ${props} });`;
        out.push(call);
        i = j;
    }

    return out.join("\n");
}

// Object.assign(x.style, { ... }); - auch über mehrere Zeilen hinweg,
// per Klammer-Tiefenzählung statt Regex (die Objektliteral-Inhalte sind
// zu variabel für eine einzelne Regex).
function convertObjectAssign(text) {
    const marker = /Object\.assign\(\s*([A-Za-z_$][\w$.?]*)\.style\s*,\s*/g;
    let result = "";
    let lastIndex = 0;
    let m;
    while ((m = marker.exec(text)) !== null) {
        const target = m[1];
        const objStart = m.index + m[0].length; // Position direkt nach "Object.assign(x.style, "
        // Tiefe ab der öffnenden { des Objektliterals zählen.
        let depth = 0;
        let k = objStart;
        let objEnd = -1;
        for (; k < text.length; k++) {
            const c = text[k];
            if (c === "{") depth++;
            else if (c === "}") {
                depth--;
                if (depth === 0) { objEnd = k + 1; break; }
            }
        }
        if (objEnd === -1) continue; // nicht gefunden -> unverändert lassen

        // Nach dem Objekt sollte ")" und optional ";" folgen.
        let closeParen = objEnd;
        while (closeParen < text.length && /\s/.test(text[closeParen])) closeParen++;
        if (text[closeParen] !== ")") continue;
        let afterParen = closeParen + 1;

        const objLiteral = text.slice(objStart, objEnd);
        result += text.slice(lastIndex, m.index);
        result += `${target}.setCssStyles(${objLiteral})`;
        lastIndex = afterParen;
        marker.lastIndex = afterParen;
    }
    result += text.slice(lastIndex);
    return result;
}

for (const file of files) {
    const original = fs.readFileSync(file, "utf8");
    let updated = convertObjectAssign(original);
    updated = convertSingleRuns(updated);
    if (updated !== original) {
        fs.writeFileSync(file, updated, "utf8");
        console.log(`Updated: ${file}`);
    } else {
        console.log(`No changes: ${file}`);
    }
}