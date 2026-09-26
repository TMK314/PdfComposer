export const VIEW_TYPE_PDFCOMPOSE = "pdfcompose-view";

export const PDFCOMPOSE_FILE_EXTENSION_MARKER = "pdfcompose";

// Feste Seitenmaße in Punkten (1 Punkt = 1/72 Zoll), genutzt für Leerseiten.
export const PAGE_SIZES: Record<"A4" | "Letter", { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  Letter: { width: 612, height: 792 },
};

export const DEFAULT_RENDER_SCALE = 1.5;
