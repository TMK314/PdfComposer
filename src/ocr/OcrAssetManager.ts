// OcrAssetManager.ts
//
// Lädt OCR-Ressourcen (Modell, Zeichentabelle) bequem per Klick aus den
// Einstellungen in den Vault. Nutzt Obsidians requestUrl (kein CORS-Problem,
// funktioniert auf Desktop UND Mobile), keine externen Abhängigkeiten.
//
// WICHTIG: Es gibt keinen offiziellen, öffentlichen Direkt-Download-Link für
// das von Google ML Kit intern genutzte "digitalink.tflite" – das Modell
// wird proprietär über Play Services / die ML-Kit-Runtime verteilt, nicht
// als einzelne Datei veröffentlicht. Diese Klasse lädt daher, was auch immer
// unter den in den Einstellungen hinterlegten URLs liegt (z. B. ein selbst
// trainiertes/konvertiertes, kompatibles Modell, das ihr z. B. auf
// GitHub Releases oder Hugging Face hostet).

import { App, requestUrl } from "obsidian";

export class OcrAssetManager {
    constructor(private app: App) {}

    /** Lädt eine Binärdatei (z. B. .tflite) von `url` und speichert sie unter `vaultPath`. */
    async downloadBinary(url: string, vaultPath: string): Promise<void> {
        const response = await requestUrl({ url, method: "GET" });
        await this.ensureParentFolder(vaultPath);
        await this.app.vault.adapter.writeBinary(vaultPath, response.arrayBuffer);
    }

    /** Lädt eine Textdatei (z. B. labels.txt) von `url` und speichert sie unter `vaultPath`. */
    async downloadText(url: string, vaultPath: string): Promise<void> {
        const response = await requestUrl({ url, method: "GET" });
        await this.ensureParentFolder(vaultPath);
        await this.app.vault.adapter.write(vaultPath, response.text);
    }

    private async ensureParentFolder(vaultPath: string): Promise<void> {
        const folder = vaultPath.split("/").slice(0, -1).join("/");
        if (!folder) return;
        if (!(await this.app.vault.adapter.exists(folder))) {
            await this.app.vault.adapter.mkdir(folder);
        }
    }
}