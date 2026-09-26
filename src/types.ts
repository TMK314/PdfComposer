// Datenmodell für PDF-Compose-Dokumente.
// Diese Typen bilden 1:1 die Struktur des Frontmatters einer .md-Datei ab,
// die mit "pdfcompose: true" markiert ist.

export const CURRENT_PDFCOMPOSE_VERSION = 1;

/** Zuordnung von Kurz-Namen (z. B. "main") zu Vault-relativen PDF-Pfaden. */
export interface DocumentSources {
    [key: string]: string;
}

export interface PdfPageDefinition {
    id: string;
    type?: "pdf";
    src: string;
    srcPage: number;
    rotate?: 0 | 90 | 180 | 270;
    invert?: boolean;
}

export type BuiltinTemplateId = "blank" | "grid" | "grid-margin" | "lines" | "lines-margin";

export type ColorMode = "original" | "light" | "dark";

export interface BlankPageDefinition {
    id: string;
    type: "blank";
    template?: BuiltinTemplateId;
    size?: "A4" | "Letter" | { width: number; height: number };
    invert?: boolean;
}

export type PageDefinition = PdfPageDefinition | BlankPageDefinition;

export interface TextBlockMeta {
    id: string;
    pageId: string;
    x: number;
    y: number;
    width: number;
    fontScale: number;
}

export interface PdfAnnotationMeta {
    id: string;
    pageId: string;
    color: string;
    rects: { x: number; y: number; width: number; height: number }[];
    y: number;
    width: number;
    connector: "none" | "straight" | "curve" | "step";
    fontScale: number;
}

export interface OcrMeta {
    id: string;
    pageId: string;
    hash: string;
    words: { text: string; confidence: number; x: number; y: number; width: number; height: number }[];
}

export interface PdfComposeDocument {
    version: number;
    sources: DocumentSources;
    pages: PageDefinition[];
    annotations: Record<string, string[]>;
    colorMode: ColorMode;
    textBlocks?: TextBlockMeta[];
    pdfAnnotations?: PdfAnnotationMeta[];
    ocrBlocks?: OcrMeta[];
    shapeLabels?: ShapeLabelMeta[];
    savePdfText?: boolean;
    created?: string;
}

export function isPdfPage(page: PageDefinition): page is PdfPageDefinition {
    return page.type === undefined || page.type === "pdf";
}

export function isBlankPage(page: PageDefinition): page is BlankPageDefinition {
    return page.type === "blank";
}


export interface StrokePoint {
    x: number;
    y: number;
    p?: number; // Druck, 0–1, sofern vom Eingabegerät geliefert
    t: number;
    w: number; // berechnete Strichbreite, abhängig von Druck und Stifttyp
}

export interface FreehandObject {
    id: string;
    type: "freehand";
    points: StrokePoint[];
    color: string;
    highlighter?: boolean;
    pressureEnabled: boolean;
    pressureMinFactor: number;
    pressureCurve: PressureCurve;
    strokeWidth: number;
}

export type LineSegmentKind = "straight" | "curve" | "step";

export interface LinePoint {
    x: number;
    y: number;
    /** Verbindungsart VOM vorherigen Punkt ZU diesem. Beim ersten Punkt ohne Bedeutung. */
    segment?: LineSegmentKind;
}

export interface LineObject {
    id: string;
    type: "line";
    points: LinePoint[];
    color: string;
    width: number;
    isHighlighter?: boolean;
    label?: LineLabel;
    /** Bindung des ERSTEN Punktes (points[0]) an eine Form. */
    startBinding?: EndpointBinding;
    /** Bindung des LETZTEN Punktes an eine Form. */
    endBinding?: EndpointBinding;
}

export interface ArrowObject extends Omit<LineObject, "type"> {
    type: "arrow";
    arrowStart?: boolean;
    arrowEnd?: boolean;
    arrowSize?: number;
}

export type AnnotationTool =
    | "none"
    // alle Stift‑IDs
    | "pen-fineliner"
    | "pen-fountain"
    | "pen-pencil"
    | "pen-fineliner-red"
    | "pen-charcoal"
    | "pen-brush"
    | "pen-highlighter-yellow"
    | "pen-highlighter-blue"
    // übrige Werkzeuge
    | "eraser"
    | "line"
    | "arrow"
    | "polygon"
    | "rectangle"
    | "triangle-equilateral"
    | "triangle-right"
    | "ellipse"
    | "diamond"
    | "text"
    | "select-rect"
    | "select-lasso";

export type ArrowSide = "end" | "start" | "both";
export type SelectionMode = "touch" | "contain";
export type PressureCurve = "linear" | "quadratic" | "sqrt" | "ease";

export interface PressureSettings {
    enabled: boolean;
    minFactor: number;
    curve: PressureCurve;
}

export type PenToolId = Extract<AnnotationTool,
    | "pen-fineliner"
    | "pen-fountain"
    | "pen-pencil"
    | "pen-fineliner-red"
    | "pen-charcoal"
    | "pen-brush"
    | "pen-highlighter-yellow"
    | "pen-highlighter-blue"
>;

export interface PenPreset {
    id: PenToolId;
    label: string;
    icon: string;
    color: string;
    strokeWidth: number;
    pressure: PressureSettings;
    highlighter: boolean;
}

export const DEFAULT_PEN_PRESETS: PenPreset[] = [
    {
        id: "pen-fineliner",
        label: "Fineliner",
        icon: "pen-tool",
        color: "#000000",
        strokeWidth: 1.5,
        highlighter: false,
        pressure: { enabled: false, minFactor: 0, curve: "ease" },
    },
    {
        id: "pen-fountain",
        label: "Fountain pen",
        icon: "feather",
        color: "#1a5fb4",
        strokeWidth: 2.0,
        highlighter: false,
        pressure: { enabled: true, minFactor: 0.4, curve: "ease" },
    },
    {
        id: "pen-pencil",
        label: "Pencil",
        icon: "pencil",
        color: "#6b6b6b",
        strokeWidth: 2.0,
        highlighter: false,
        pressure: { enabled: true, minFactor: 0.25, curve: "ease" },
    },
    {
        id: "pen-fineliner-red",
        label: "Red fineliner",
        icon: "pen-tool",
        color: "#e03131",
        strokeWidth: 1.5,
        highlighter: false,
        pressure: { enabled: false, minFactor: 0, curve: "ease" },
    },
    {
        id: "pen-charcoal",
        label: "Charcoal",
        icon: "pencil",
        color: "#000000B3",
        strokeWidth: 5.0,
        highlighter: false,
        pressure: { enabled: true, minFactor: 0.1, curve: "ease" },
    },
    {
        id: "pen-brush",
        label: "Brush",
        icon: "brush",
        color: "#2b8a3e",
        strokeWidth: 5.0,
        highlighter: false,
        pressure: { enabled: true, minFactor: 0.08, curve: "ease" },
    },
    {
        id: "pen-highlighter-yellow",
        label: "Yellow highlighter",
        icon: "highlighter",
        color: "#fcc419",
        strokeWidth: 12,
        highlighter: true,
        pressure: { enabled: false, minFactor: 0, curve: "ease" },
    },
    {
        id: "pen-highlighter-blue",
        label: "Blue highlighter",
        icon: "highlighter",
        color: "#4dabf7",
        strokeWidth: 12,
        highlighter: true,
        pressure: { enabled: false, minFactor: 0, curve: "linear" },
    },
];

export function clonePenPresets(): PenPreset[] {
    return DEFAULT_PEN_PRESETS.map(p => ({ ...p, pressure: { ...p.pressure } }));
}

export function isPenTool(tool: AnnotationTool): tool is PenToolId {
    return tool === "pen-fineliner"
        || tool === "pen-fountain"
        || tool === "pen-pencil"
        || tool === "pen-fineliner-red"
        || tool === "pen-charcoal"
        || tool === "pen-brush"
        || tool === "pen-highlighter-yellow"
        || tool === "pen-highlighter-blue";
}

export interface ShapeLabel {
    text: string;
    fontSize?: number; // px/pt in page coordinate space, default 14
    color?: string;    // hex, default '#1a1a1a'
}

export interface ShapeLabelMeta {
    id: string;       // == shapeId
    pageId: string;
    shapeId: string;
    fontSize?: number;
    color?: string;
    mode?: "inline" | "box";
}

export interface LineLabel {
    text: string;
    fontSize?: number;
    color?: string;
    /** 'inline' = Text liegt direkt auf der Linie (Linie wird an der Stelle unterbrochen).
     *  'box'    = Text erscheint in einer kleinen Box, die die Linie an dieser Stelle überdeckt. */
    mode: "inline" | "box";
}

export interface EndpointBinding {
    /** ID der Form, an die dieser Linien-/Pfeil-Endpunkt gebunden ist. */
    objectId: string;
    /** Relative Position (0..1) im un-rotierten Bounding-Box-Koordinatensystem der Zielform. */
    ax: number;
    ay: number;
}

export interface ShapeStyle {
    strokeColor: string;
    strokeWidth: number;
    fillColor?: string;
    fillOpacity?: number;
    isHighlighter?: boolean;
    /** Optionaler Text, mittig in der Form dargestellt. */
    label?: ShapeLabel;
}

export interface PolygonObject extends ShapeStyle {
    id: string;
    type: "polygon";
    points: LinePoint[];
}

export interface RectangleObject extends ShapeStyle {
    id: string;
    type: "rectangle";
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
}

export type TriangleVariant = "equilateral" | "right";

export interface TriangleObject extends ShapeStyle {
    id: string;
    type: "triangle";
    variant: TriangleVariant;
    x: number;
    y: number;
    /** @deprecated Seit Einführung von width/height nicht mehr verwendet; bleibt für Rückwärtskompatibilität mit älteren Dateien. */
    size?: number;
    width: number;
    height: number;
    rotation?: number;
}

export interface EllipseObject extends ShapeStyle {
    id: string;
    type: "ellipse";
    cx: number;
    cy: number;
    rx: number;
    ry: number;
    rotation?: number;
}

export interface DiamondObject extends ShapeStyle {
    id: string;
    type: "diamond";
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
}

export type VectorObject =
    | FreehandObject
    | LineObject
    | ArrowObject
    | PolygonObject
    | RectangleObject
    | TriangleObject
    | EllipseObject
    | DiamondObject;

export function isFreehand(o: VectorObject): o is FreehandObject { return o.type === "freehand"; }
export function isLine(o: VectorObject): o is LineObject { return o.type === "line"; }
export function isArrow(o: VectorObject): o is ArrowObject { return o.type === "arrow"; }
export function isPolygon(o: VectorObject): o is PolygonObject { return o.type === "polygon"; }
export function isRectangle(o: VectorObject): o is RectangleObject { return o.type === "rectangle"; }
export function isTriangle(o: VectorObject): o is TriangleObject { return o.type === "triangle"; }
export function isEllipse(o: VectorObject): o is EllipseObject { return o.type === "ellipse"; }
export function isDiamond(o: VectorObject): o is DiamondObject { return o.type === "diamond"; }

export interface ToolGroup<T extends AnnotationTool = AnnotationTool> {
    id: string;
    activeTool: T;
    tools: T[];
    isOpen: boolean;
    autoCloseOnUse: boolean; // true = klappt bei Nutzung zu, false = bleibt offen
}

// Metadaten für Icons & Beschriftungen der Werkzeuge
export const TOOL_METADATA: Record<string, { label: string; icon: string }> = {
    "none": { label: "Pointer", icon: "mouse-pointer" },
    "select-rect": { label: "Rectangle selection", icon: "box-select" },
    "select-lasso": { label: "Lasso selection", icon: "lasso" },
    // Pens
    "pen-fineliner": { label: "Fineliner", icon: "pen-tool" },
    "pen-fountain": { label: "Fountain pen", icon: "feather" },
    "pen-pencil": { label: "Pencil", icon: "pencil" },
    "pen-fineliner-red": { label: "Red fineliner", icon: "pen-tool" },
    "pen-charcoal": { label: "Charcoal", icon: "pencil" },
    "pen-brush": { label: "Brush", icon: "brush" },
    "pen-highlighter-yellow": { label: "Yellow highlighter", icon: "highlighter" },
    "pen-highlighter-blue": { label: "Blue highlighter", icon: "highlighter" },
    // Others
    "eraser": { label: "Eraser", icon: "eraser" },
    "rectangle": { label: "Rectangle", icon: "square" },
    "diamond": { label: "Diamond", icon: "diamond" },
    "ellipse": { label: "Circle / ellipse", icon: "circle" },
    "line": { label: "Line", icon: "minus" },
    "arrow": { label: "Arrow", icon: "arrow-right" },
    "triangle-equilateral": { label: "Equilateral triangle", icon: "triangle" },
    "polygon": { label: "Polygon", icon: "hexagon" },
    "triangle-right": { label: "Right triangle", icon: "triangle" },
};

export type TemplateSelection =
    | { kind: "builtin"; templateId: BuiltinTemplateId; size: "A4" | "Letter" }
    | { kind: "file"; filePath: string; sourceName: string; page?: number };

export type InsertPositionMode = "end" | "before" | "after";

export interface InsertPosition {
    mode: InsertPositionMode;
    targetPageId?: string;
}

export type AddPageResult =
    | { kind: "blank"; template: BuiltinTemplateId; size: "A4" | "Letter"; position?: InsertPosition }
    | { kind: "pdf"; sourceName: string; sourcePath: string; isNewSource: boolean; pages: number[]; position?: InsertPosition }
    | { kind: "templates"; entries: TemplateSelection[]; position?: InsertPosition };

export interface FilterTargets {
    strokes: boolean;
    highlighters: boolean;
    shapes: boolean;
    annotations: boolean;
    textBlocks: boolean;
}