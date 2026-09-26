// PdfComposeView.ts
import { ItemView, TFile, WorkspaceLeaf, ViewStateResult, Command, Component, Menu, Notice, MarkdownRenderer, Platform, CachedMetadata } from "obsidian";
import {
    PdfAnnotationEntry,
    PdfAnnotationRect,
    ConnectorStyle,
    parsePdfAnnotations,
    groupPdfAnnotationsByPage,
    upsertPdfAnnotation,
    removePdfAnnotation,
    extractAllPdfAnnotations,
} from "../parser/PdfAnnotationParser";
import PdfComposePlugin from "../main";
import { VIEW_TYPE_PDFCOMPOSE, DEFAULT_RENDER_SCALE, PAGE_SIZES } from "../view/constants";
import { parseFrontmatter, FrontmatterParseError } from "../parser/FrontmatterParser";
import { drawTemplatePattern } from "../pdf/TemplatePages";
import {
    PageDefinition,
    PdfComposeDocument,
    PdfPageDefinition,
    BlankPageDefinition,
    isBlankPage,
    isPdfPage,
    VectorObject,
    FreehandObject,
    LineObject,
    ArrowObject,
    LinePoint,
    LineSegmentKind,
    PolygonObject,
    RectangleObject,
    TriangleObject,
    EllipseObject,
    DiamondObject,
    ShapeLabel,
    LineLabel,
    EndpointBinding,
    StrokePoint,
    AnnotationTool,
    SelectionMode,
    ArrowSide,
    TOOL_METADATA,
    PenPreset,
    PenToolId,
    PressureCurve,
    DEFAULT_PEN_PRESETS,
    clonePenPresets,
    isPenTool,
    AddPageResult,
    PressureSettings,
    FilterTargets,
    ColorMode,
    InsertPosition,
    InsertPositionMode,
} from "../types";
import {
    TextBlockEntry,
    parseTextBlocks,
    groupTextBlocksByPage,
    upsertTextBlock,
    removeTextBlock,
    extractAllTextBlocks,
} from "../parser/TextBlockParser";
import { PdfPageRenderer, TextItemWithPosition } from "../pdf/PdfPageRenderer";
import { encodeAnnotations, decodeAnnotations } from "../pdf/VectorSerializer";
import { simplifyStroke } from "../pdf/StrokeSimplify";
import { splitHexAlpha, combineHexAlpha, resolveDisplayColor, invertLightness as invertLightnessSafe } from "../pdf/ColorUtils";
import {
    PdfComposeUI,
    AddSourceModal,
    AddPageModal,
    TextDisplayModal,
    TextBlockEditModal,
    PdfAnnotationEditModal,
    ChangeSourcePathModal,
    SourceDeleteModal,
    ExportPdfModal,
    LabelEditModal,
} from "./PdfComposeUI";
import { UndoManager, UndoableCommand } from "../undo/UndoManager";
import { OcrController } from "../ocr/OcrController";
import {
    OcrBlockEntry,
    OcrWordEntry,
    parseOcrBlocks,
    groupOcrBlocksByPage,
    upsertOcrBlock,
    removeOcrBlock,
    extractAllOcrBlocks,
    extractOcrBlockContents,
}
    from "../ocr/OcrBlockParser";
import { findFuzzyTextMatches, findFuzzyWordSequenceMatches, FuzzyTextMatch, SearchResultItem, SearchResultCategory } from "../search/FuzzySearch";
import { exportPdfComposeToPdf } from "../pdf/PdfExporter";
import { buildVariableWidthPathData, isUniformWidth } from "../pdf/StrokePathBuilder";
import * as YAML from 'js-yaml';
import { compressText } from "../pdf/VectorCompression";
import { decompressMetaArray } from "../parser/FrontmatterParser";
import {
    ShapeLabelEntry, parseShapeLabels, groupShapeLabelsByPage,
    upsertShapeLabel, removeShapeLabel, extractAllShapeLabels,
} from "../parser/ShapeLabelParser";

interface PdfComposeViewState {
    file?: string;
    [key: string]: unknown;
}

export class PdfComposeView extends ItemView {
    private plugin: PdfComposePlugin;
    private renderer: PdfPageRenderer;
    public currentFile: TFile | null = null;
    private ui: PdfComposeUI;

    private sidebarEl!: HTMLElement;
    private sidebarListEl!: HTMLElement;
    private draggingPageId: string | null = null;
    private foundPageIds: Set<string> = new Set();
    private searchResults: { pageId: string, text: string, pageIndex: number, matches: { x: number, y: number, width: number, height: number }[] }[] = [];
    private currentSearchIndex: number = -1;
    public allMatches: { pageId: string, rect: { x: number, y: number, width: number, height: number } }[] = [];
    public currentMatchIndex: number = -1;

    private annotationsCache: Map<string, VectorObject[]> = new Map();
    private textBlocksCache: Map<string, TextBlockEntry[]> = new Map();
    private textBlockComponents: Map<string, Component> = new Map();
    private pageScales: Map<string, number> = new Map();
    private arrowMarkerCache: WeakMap<SVGSVGElement, Map<string, string>> = new WeakMap();
    private pdfAnnotationsCache: Map<string, PdfAnnotationEntry[]> = new Map();
    private pdfAnnotationComponents: Map<string, Component> = new Map();
    private pendingEraseAnnotationIds: Set<string> = new Set();

    // Werkzeug- und Stil-Zustände
    private currentTool: AnnotationTool = "none";
    private styleStrokeColor: string = "#e03131";
    private styleStrokeWidth: number = 2.5;
    private styleFillEnabled: boolean = false;
    private styleFillColor: string = "#e03131";
    private styleFillOpacity: number = 0.3;
    private styleSegmentKind: LineSegmentKind = "straight";
    private styleArrowSide: ArrowSide = "end";
    private styleArrowSize: number | undefined = undefined;
    private styleShapeHighlighter: boolean = false;
    private selectionMode: SelectionMode = "touch";
    private eraserTargets: FilterTargets = {
        strokes: true,
        highlighters: true,
        shapes: true,
        annotations: false,
        textBlocks: false,
    };

    // Zoom-Zustand (view-lokal, nicht Teil des Dokuments/Frontmatters)
    // Zoom-Zustand (view-lokal, nicht Teil des Dokuments/Frontmatters)
    private zoomLevel: number = 1;
    private static readonly ZOOM_MIN = 0.25;
    private static readonly ZOOM_MAX = 6;
    private static readonly ZOOM_STEP = 0.1;
    private static readonly MULTI_POINT_DOUBLE_CLICK_MS = 400;
    private static readonly MULTI_POINT_DOUBLE_CLICK_DIST = 6;

    // Schwellenwerte, ab denen die PDF-/Vorlagen-Canvases mit höherer
    // Bitmap-Auflösung neu gerastert werden. Innerhalb eines "Bandes"
    // übernimmt CSS "zoom" die (schnelle, aber irgendwann unscharfe)
    // Skalierung; beim Überschreiten eines Schwellenwerts wird die
    // jeweilige Seite scharf neu gezeichnet. Der max. Vergrößerungsfaktor
    // innerhalb eines Bandes ist damit auf ca. 1.3–1.5x begrenzt.
    private static readonly RASTER_ZOOM_THRESHOLDS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6];
    private static readonly MOBILE_MAX_RASTER_MULTIPLIER = 6;
    private static readonly MAX_RASTER_MULTIPLIER = 6;
    /** Aktuell gerasterter Auflösungsfaktor je Seite (Basis = DEFAULT_RENDER_SCALE). */
    private pageRasterMultiplier: Map<string, number> = new Map();
    /** Feste, zoomunabhängige CSS-Anzeigegröße je Seite in px. */
    private pageLogicalSize: Map<string, { width: number; height: number }> = new Map();
    /** Verhindert überlappende Neu-Rasterungen derselben Seite. */
    private rerasteringPageIds: Set<string> = new Set();
    /** Wird bei jedem (Re-)Mounten einer Seite erhöht - dient reRasterPage() dazu, veraltete (während des Aushängens/erneuten Einhängens abgeschlossene) Re-Raster-Ergebnisse zu erkennen und zu verwerfen. */
    private pageMountGeneration: Map<string, number> = new Map();

    // --- Seiten-Virtualisierung ---
    /** Beobachtet die Platzhalter aller Seiten und (de-)mountet Inhalte je nach Sichtbarkeit. */
    private pageObserver: IntersectionObserver | null = null;
    /** Der (immer vorhandene, größengleiche) Platzhalter-Wrapper je Seite. */
    private pagePlaceholders: Map<string, HTMLElement> = new Map();
    /** Seiten, deren tatsächlicher Inhalt aktuell im DOM eingehängt ist. */
    private mountedPageIds: Set<string> = new Set();
    /** Laufende Mount-Vorgänge, um doppeltes Rendern bei schnellem Scrollen zu vermeiden. */
    private pageMountPromises: Map<string, Promise<void>> = new Map();

    private shapeLabelsCache: Map<string, ShapeLabelEntry[]> = new Map();

    // Interaktions-Zustände (Pointer, Striche, Drag, Auswahl, etc.)
    private activeStroke: StrokePoint[] | null = null;
    private activeStrokeColor: string | null = null;
    private activeStrokePath: SVGPathElement | null = null;
    private activeStrokePageId: string | null = null;
    private activePointerId: number | null = null;
    private freehandRedrawScheduled: boolean = false;
    private manualPanPointerId: number | null = null;
    private manualPanStart: { x: number; y: number } | null = null;
    private manualPanScrollStart: { left: number; top: number } | null = null;
    private manualPanSvg: SVGSVGElement | null = null;

    private manualPanVelocity: { x: number; y: number } | null = null;
    private manualPanLastMoveTime: number = 0;
    private manualPanLastMovePos: { x: number; y: number } | null = null;
    private manualPanMomentumRafId: number | null = null;
    private static readonly MOMENTUM_MIN_VELOCITY = 0.02; // px/ms - unterhalb dessen die Animation stoppt
    private static readonly MOMENTUM_FRICTION = 0.95;     // Geschwindigkeits-Faktor je 16,67ms (60fps-Basis)

    // Touch-Tracking für Zwei-Finger-Pinch-Zoom (mobile) und um Zeichen-
    // Werkzeuge während eines aktiven Pinch-Gestus zu unterdrücken.
    private activeTouchPointers: Map<number, { x: number; y: number }> = new Map();
    private pinchStartDistance: number | null = null;
    private pinchStartZoom: number = 1;
    private pinchAnchor: ZoomAnchor | null = null;
    private isFullscreen: boolean = false;

    private eraserPointerId: number | null = null;
    private pendingEraseIds: Set<string> = new Set();
    private pendingEraseTextBlockIds: Set<string> = new Set();
    private lastErasePoint: { x: number; y: number } | null = null;

    private multiPoints: { x: number; y: number }[] | null = null;
    private multiPreviewEl: SVGElement | null = null;
    private multiPageId: string | null = null;
    private multiSvg: SVGSVGElement | null = null;
    private lastMultiPointClickTime: number = 0;
    private lastMultiPointClickPos: { x: number; y: number } | null = null;

    private dragStart: { x: number; y: number } | null = null;
    private dragPreviewEl: SVGElement | null = null;
    private dragPageId: string | null = null;
    private dragPointerId: number | null = null;
    private textDragStart: { x: number; y: number } | null = null;
    private textDragPreviewEl: SVGElement | null = null;
    private textDragPageId: string | null = null;
    private textDragPointerId: number | null = null;
    private currentCrossPageTargetId: string | null = null;

    private selectionPageId: string | null = null;
    private selectedIds: Set<string> = new Set();
    private selectedTextBlockIds: Set<string> = new Set();
    private selectedPdfAnnotationIds: Set<string> = new Set();
    private selectionDragStart: { x: number; y: number } | null = null;
    private selectionPreviewEl: SVGElement | null = null;
    private lassoPoints: { x: number; y: number }[] | null = null;
    private selectionPointerId: number | null = null;
    private isMovingSelection: boolean = false;
    private elevatedDragPageId: string | null = null;
    private elevatedDragOriginalStyles: Map<HTMLElement, { zIndex: string; overflow: string }> | null = null;
    private elevatedDragOriginalSvgStyles: Map<SVGSVGElement, string> | null = null;
    private eraserActivePageId: string | null = null;
    private moveOrigin: { x: number; y: number } | null = null;
    private moveSnapshot: Map<string, VectorObject> | null = null;
    private selectionTargets: FilterTargets = {
        strokes: true,
        highlighters: true,
        shapes: true,
        annotations: true,
        textBlocks: true,
    };

    private styleWriteDebounceTimer: number | null = null;
    private penPresets: Map<PenToolId, PenPreset> = new Map(
        clonePenPresets().map(p => [p.id, p])
    );
    private pendingStylePatch: Record<string, any> | null = null;

    private handleDragMode: "rotate" | "scale-corner" | null = null;
    private handleDragPointerId: number | null = null;
    private handleDragPivot: { x: number; y: number } | null = null;
    private handleDragStartVector: { x: number; y: number } | null = null;
    private handleDragTarget: SVGElement | null = null;
    private handleDragCornerIndex: number | null = null;
    private handleDragOriginalTransforms: Map<string, string> = new Map();
    private moveSelectionOriginalTransforms: Map<string, string> = new Map();
    private pointDragMode: {
        pageId: string;
        objectId: string;
        pointIndex: number;
        pointerId: number;
        originalPoint: LinePoint | null;
        isEndpoint: boolean;
        originalStartBinding?: EndpointBinding;
        originalEndBinding?: EndpointBinding;
    } | null = null;
    /** ID der Form, die gerade als Bindungsziel hervorgehoben wird (während ein Endpunkt darüber gezogen wird). */
    private currentBindHighlightId: string | null = null;
    /** Long-Press-Ersatz für das (auf Touch/Stift fehlende) contextmenu-Event auf Punkt-Handles, siehe startPointDrag(). */
    private pointLongPressTimer: number | null = null;
    private pointLongPressStartClient: { x: number; y: number } | null = null;
    private pendingScrollPageId: string | null = null;

    private clipboard: ClipboardContent | null = null;
    private static readonly ANNOTATION_COLOR_PALETTE = [
        "#ffd43b", "#74c0fc", "#63e6be", "#ff8787", "#b197fc", "#ffa94d", "#66d9e8", "#f783ac",
    ];

    private currentDocument: PdfComposeDocument | null = null;
    private suppressExpiries: number[] = [];
    private renderGeneration = 0;
    private pageWrapperList: HTMLElement[] = [];
    private intersectingPageIds: Set<string> = new Set();
    private rerasterTimer: number | null = null;
    private eraseBoundsCache: WeakMap<object, { minX: number; minY: number; maxX: number; maxY: number }> = new WeakMap();
    private handleDragAxisDeg: number = 0;
    private rangeSession: RangeSession | null = null;
    private rangeToolbarTouchedAt: number = 0;
    private lastPointerType: string = "mouse";
    private selectionChangeTimer: number | null = null;
    private pageClipboard: PageSnapshot[] = [];

    private undoManager: UndoManager = new UndoManager();
    private colorMode: ColorMode = "original";
    private pageIsDarkOriginal: Map<string, boolean> = new Map();

    private ocrCache: Map<string, OcrBlockEntry[]> = new Map();
    /** Zwischenspeicher: extrahierter PDF-Text je Seiten-ID (nur bei aktivem savePdfText genutzt). */
    private pdfTextCache: Map<string, string> = new Map();
    private ocrController: OcrController;
    private ocrLastInteractionAt: number = 0;
    private ocrBackgroundRunning: boolean = false;

    private ocrDebugLayers: Map<string, SVGSVGElement> = new Map();
    /** Seiten, für die OCR-Debug-Boxen aktiv sind – bleibt über Mount/Unmount hinweg bestehen. */
    private ocrDebugEnabledPageIds: Set<string> = new Set();
    private bezierDebugLayers: Map<string, SVGSVGElement> = new Map();
    private bezierDebugEnabledPageIds: Set<string> = new Set();

    private activeSmoothedPressure: number | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: PdfComposePlugin) {
        super(leaf);
        this.plugin = plugin;
        this.renderer = new PdfPageRenderer(this.app.vault);
        this.ocrController = new OcrController(this.app, () => this.plugin.settings);
        // UI wird später initialisiert (in onOpen)
        this.ui = null as any; // wird in onOpen gesetzt
    }

    getViewType(): string { return VIEW_TYPE_PDFCOMPOSE; }
    getDisplayText(): string { return this.currentFile?.basename ?? "PDF Compose"; }
    getIcon(): string { return "file-stack"; }

    async setState(state: PdfComposeViewState, result: ViewStateResult): Promise<void> {
        if (state?.file) {
            const file = this.app.vault.getAbstractFileByPath(state.file);
            if (file instanceof TFile) {
                if (this.currentFile?.path !== file.path) {
                    this.undoManager.clear();
                }
                this.currentFile = file;
                await this.renderDocument();
            }
        }
        await super.setState(state, result);
    }

    getState(): PdfComposeViewState {
        return { file: this.currentFile?.path };
    }

    getCommands(): Record<string, Command> {
        return {
            "switch-to-markdown": {
                id: "switch-to-markdown",
                name: "Als Markdown öffnen",
                callback: () => { this.plugin.openAsMarkdown(); },
            },
            "switch-to-compose": {
                id: "switch-to-compose",
                name: "Als PDF-Compose öffnen",
                callback: () => {
                    if (this.currentFile) {
                        this.plugin.maybeSwitchToComposeView(this.currentFile, true);
                    }
                },
            },
            "pdfcompose-undo": {
                id: "pdfcompose-undo",
                name: "PDF Compose: Undo",
                callback: () => { void this.undo(); },
            },
            "pdfcompose-redo": {
                id: "pdfcompose-redo",
                name: "PDF Compose: Redo",
                callback: () => { void this.redo(); },
            },
            "pdfcompose-ocr-current-page": {
                id: "pdfcompose-ocr-current-page",
                name: "OCR: recognize visible page",
                callback: () => {
                    const pageId = this.getCurrentVisiblePageId();
                    if (pageId) void this.runOcrForPage(pageId, { force: true });
                },
            },
            "pdfcompose-ocr-document": {
                id: "pdfcompose-ocr-document",
                name: "OCR: recognize entire document",
                callback: () => { void this.runOcrForDocument(); },
            },
            "pdfcompose-export-pdf": {
                id: "pdfcompose-export-pdf",
                name: "Export as PDF",
                callback: () => { void this.exportToPdf(); },
            },
        };
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1] as HTMLElement;
        this.ui = new PdfComposeUI(this.plugin, this, container);
        this.ui.buildLayout();
        this.ui.pagesContainerEl.style.overflowAnchor = "none";

        this.ui.buildAnnotationToolbar((tool) => this.setActiveTool(tool));
        this.ui.updateUndoRedoButtons(this.undoManager.canUndo(), this.undoManager.canRedo());
        this.ui.buildActionPanel({
            onCopy: () => this.copySelection(),
            onCut: () => this.cutSelection(),
            onDelete: () => this.deleteSelection(),
            onPaste: () => this.pasteClipboard(),
        });

        const moreOptionsPanel = this.ui.buildMoreOptionsMenu();

        this.ui.buildSaveButton(moreOptionsPanel, () => this.flushPendingChangesAndNotify());

        this.ui.buildInvertButton(moreOptionsPanel, () => {
            if (this.selectedIds.size > 0) {
                void this.invertSelectionColors();
            } else {
                void this.toggleInvertForVisiblePage();
            }
        });

        this.ui.buildColorModeControl(
            moreOptionsPanel,
            (mode) => { void this.setColorMode(mode); },
            (value) => { void this.setSavePdfText(value); },
        );

        // Schnellzugriff direkt im View statt nur in den Plugin-
        // Einstellungen: bestimmt, ob Finger-Eingaben auf der Zeichenfläche
        // als Werkzeug (Zeichnen/Radieren/Auswählen) oder als
        // Scrollen/Zoomen interpretiert werden.
        this.ui.buildStylusOnlyToggle(
            moreOptionsPanel,
            this.plugin.settings.restrictDrawingToStylus,
            (value) => { void this.setRestrictDrawingToStylus(value); },
        );

        this.ui.buildHorizontalLayoutToggle(
            moreOptionsPanel,
            this.plugin.settings.horizontalLayout,
            (value) => { void this.setHorizontalLayout(value); },
        );
        this.applyHorizontalLayout();

        this.ui.buildFullscreenToggle(moreOptionsPanel, () => this.toggleFullscreen());

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (leaf) => {
                if (this.isFullscreen && leaf?.view !== this) this.setFullscreen(false);
            })
        );

        this.ui.buildZoomControl({
            onZoomIn: () => this.zoomIn(),
            onZoomOut: () => this.zoomOut(),
            onZoomReset: () => this.resetZoom(),
        });
        this.applyZoom();
        this.updateActionButtonsState();

        this.registerTouchGestureHandlers();

        const resizeObserver = new ResizeObserver(() => {
            // Connectors neu zeichnen
            for (const [pageId, entries] of this.pdfAnnotationsCache.entries()) {
                for (const entry of entries) {
                    this.ui.updateConnector(pageId, entry);
                }
            }
        });
        resizeObserver.observe(this.ui.pagesContainerEl);
        // Registrieren, um Speicherlecks zu vermeiden
        this.register(() => resizeObserver.disconnect());

        // Event: Bei Änderungen der Markdown-Datei neu rendern
        this.registerEvent(
            this.app.metadataCache.on("changed", (file) => {
                if (!this.currentFile || file.path !== this.currentFile.path) return;
                if (this.consumeSuppressedChange()) return;
                void this.renderDocument();
            })
        );

        this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                this.cancelMultiPointDrawing();
                this.endRangeSession();
                return;
            }

            if (!(e.ctrlKey || e.metaKey)) return;
            if (!this.isViewFocused()) return;

            const key = e.key.toLowerCase();
            if (key === "z" && !e.shiftKey) {
                e.preventDefault();
                void this.undo();
            } else if (key === "y" || (key === "z" && e.shiftKey)) {
                e.preventDefault();
                void this.redo();
            } else if (key === "+" || key === "=") {
                e.preventDefault();
                this.zoomIn();
            } else if (key === "-") {
                e.preventDefault();
                this.zoomOut();
            } else if (key === "0") {
                e.preventDefault();
                this.resetZoom();
            }
        });

        this.registerDomEvent(
            this.ui.pagesContainerEl,
            "wheel",
            (e: WheelEvent) => {
                if (!(e.ctrlKey || e.metaKey)) return;
                e.preventDefault();
                if (e.deltaY < 0) {
                    this.zoomIn(e.clientX, e.clientY);
                } else if (e.deltaY > 0) {
                    this.zoomOut(e.clientX, e.clientY);
                }
            },
            { passive: false }
        );

        this.registerDomEvent(this.ui.pagesContainerEl, "pointerdown", () => {
            this.ocrLastInteractionAt = Date.now();
        });
        let scrollHighlightRaf: number | null = null;
        this.registerDomEvent(this.ui.pagesContainerEl, "scroll", () => {
            if (scrollHighlightRaf !== null) return;
            scrollHighlightRaf = window.requestAnimationFrame(() => {
                scrollHighlightRaf = null;
                this.updateCurrentPageHighlight();
            });
        });
        this.registerDomEvent(this.ui.pagesContainerEl, "pointermove", () => {
            this.ocrLastInteractionAt = Date.now();
        });
        this.registerInterval(
            window.setInterval(() => this.scheduleIdleOcrCheck(), this.plugin.settings.ocrIdleCheckIntervalMs)
        );

        let tap: { id: number; x: number; y: number; t: number } | null = null;
        this.registerDomEvent(this.ui.pagesContainerEl, "pointerdown", (e: PointerEvent) => {
            if (!this.rangeSession) return;
            if ((e.target as HTMLElement).closest(".pdfcompose-range-handle")) { tap = null; return; }
            tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() };
        }, { capture: true });
        this.registerDomEvent(this.ui.pagesContainerEl, "pointerup", (e: PointerEvent) => {
            if (!tap || tap.id !== e.pointerId) return;
            const wasTap = Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 8 && Date.now() - tap.t < 350;
            tap = null;
            if (wasTap && this.rangeSession && !this.rangeSession.dragging) this.endRangeSession();
        }, { capture: true });
    }

    async onClose(): Promise<void> {
        this.setFullscreen(false);
        this.pageObserver?.disconnect();
        this.pageObserver = null;
        this.cleanFile();
        this.pdfTextCache.clear();
        for (const comp of this.textBlockComponents.values()) comp.unload();
        this.textBlockComponents.clear();
        for (const comp of this.pdfAnnotationComponents.values()) comp.unload();
        this.pdfAnnotationComponents.clear();
        await this.renderer.destroy();
        await this.ocrController.destroy();
    }

    /**
    * Wird aufgerufen, wenn das Drei-Punkte-Menü (Pane-Menü) dieser View geöffnet wird.
    * Hier fügen wir den Eintrag "Als Markdown öffnen" hinzu.
    */
    onPaneMenu(menu: Menu, source: string): void {
        menu.addItem((item) => {
            item.setTitle("Open as Markdown")
                .setIcon("document")
                .onClick(() => {
                    this.plugin.openAsMarkdown();
                });
        });
        menu.addItem((item) => {
            item.setTitle("Export as PDF")
                .setIcon("download")
                .onClick(() => {
                    void this.exportToPdf();
                });
        });
        super.onPaneMenu?.(menu, source);
    }

    /** Wie PdfComposePlugin.pathExistsCaseInsensitive – siehe dort für die Begründung. */
    private pathExistsCaseInsensitive(path: string): boolean {
        if (this.app.vault.getAbstractFileByPath(path)) return true;
        const lower = path.toLowerCase();
        for (const file of this.app.vault.getAllLoadedFiles()) {
            if (file.path.toLowerCase() === lower) return true;
        }
        return false;
    }

    public async exportToPdf(): Promise<void> {
        if (!this.currentFile || !this.currentDocument) {
            new Notice("No document open to export.");
            return;
        }

        const pages = this.currentDocument.pages.map((p) => ({
            id: p.id,
            label: isPdfPage(p) ? `${p.src}: p. ${p.srcPage}` : "Blank page",
        }));

        new ExportPdfModal(this.app, pages, async (options) => {
            new Notice("Exporting PDF…");
            try {
                const bytes = await exportPdfComposeToPdf(
                    this.app, this.currentFile!, this.currentDocument!, this.renderer, options
                );
                const targetPath = await this.writePdfWithUniqueName(bytes);
                new Notice(`PDF exported: ${targetPath}`);
            } catch (error) {
                console.error("PdfComposePlugin: PDF export failed", error);
                new Notice(`PDF export failed: ${String(error)}`);
            }
        }).open();
    }

    /**
     * Schreibt die PDF-Bytes mit einem garantiert freien Dateinamen.
     *
     * Bewusst NICHT nur eine Vorab-Prüfung der Vault-Dateiliste: Obsidians
     * vault.createBinary() prüft zusätzlich auf Dateisystem-Ebene und wirft
     * "File already exists", wenn die Datei dort existiert, aber (noch) nicht
     * im Vault-Cache auftaucht – z. B. direkt nach einem vorherigen Export,
     * bevor der Vault-Index aktualisiert wurde, oder bei extern angelegten
     * Dateien. Deshalb: createBinary im Loop probieren und bei "File already
     * exists" einfach mit dem nächsten Suffix weitermachen.
     *
     * Liefert den tatsächlich geschriebenen Vault-Pfad zurück.
     */
    private async writePdfWithUniqueName(bytes: Uint8Array): Promise<string> {
        if (!this.currentFile) throw new Error("Kein aktuelles Dokument.");

        const folder = this.currentFile.parent?.path ?? "";
        const baseName = this.currentFile.basename;

        // Obergrenze rein defensiv – bei 1000 Namenskollisionen stimmt etwas
        // Grundsätzlicheres nicht (Endlosschleife wäre schlimmer als Fehler).
        const MAX_ATTEMPTS = 1000;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const suffix = attempt === 0 ? "" : ` (${attempt + 1})`;
            const fileName = `${baseName}${suffix}.pdf`;
            const candidatePath = folder ? `${folder}/${fileName}` : fileName;

            try {
                await this.app.vault.createBinary(candidatePath, bytes.buffer as ArrayBuffer);
                return candidatePath;
            } catch (err) {
                const msg = String(err);
                if (/file already exists/i.test(msg)) {
                    // Belegter Name (Vault-Cache und/oder Dateisystem) -> nächster Versuch.
                    continue;
                }
                // Anderer Fehler (z. B. Berechtigungen, ungültiger Pfad) -> weiterreichen.
                throw err;
            }
        }

        throw new Error(
            `Could not find a free filename after ${MAX_ATTEMPTS} attempts ` +
            `for "${baseName}.pdf".`
        );
    }

    private async setHorizontalLayout(value: boolean): Promise<void> {
        if (this.plugin.settings.horizontalLayout === value) return;

        // Capture BEFORE changing the setting. getCurrentVisiblePageId()
        // wählt die Achse anhand von settings.horizontalLayout - würde
        // das Setting zuerst geändert, würde die Suche auf der NEUEN Achse
        // laufen, während das DOM noch die ALTE Achse zeigt → falsche Seite.
        const previousPageId = this.getCurrentVisiblePageId();

        this.plugin.settings.horizontalLayout = value;
        await this.plugin.saveSettings();

        this.ui.pagesContainerEl.toggleClass("pdfcompose-horizontal", value);
        this.applyHorizontalLayoutStyles(value);

        // Synchronen Reflow erzwingen, damit scrollWidth / getBoundingClientRect
        // bereits die neue Geometrie liefern, BEVOR wir scrollen. Ohne das
        // arbeitet der anschließende Scroll noch auf den alten Scrollmaßen
        // und landet an der falschen Stelle - exakt das beobachtete
        // "scrollt nicht genau zur letzten aktiven Seite zurück".
        void this.ui.pagesContainerEl.offsetWidth;
        if (this.currentDocument) this.setupPageVirtualization(this.currentDocument);

        this.refreshConnectorsAfterLayoutChange();
        this.updateCurrentPageHighlight();

        if (previousPageId) {
            this.ui.scrollToPage(previousPageId, "auto");
        }
    }

    private applyHorizontalLayout(): void {
        if (!this.ui?.pagesContainerEl) return;
        const value = this.plugin.settings.horizontalLayout;
        this.ui.pagesContainerEl.toggleClass("pdfcompose-horizontal", value);
        this.applyHorizontalLayoutStyles(value);
        this.refreshConnectorsAfterLayoutChange();
        this.updateCurrentPageHighlight();
    }

    /**
     * Wendet Gap/Padding zusätzlich inline an. Die CSS-Regeln in styles.css
     * sind korrekt, aber ein Nutzer-Theme kann sie über höhere Spezifität
     * oder !important überstimmen - Inline-Styles gewinnen immer.
     */
    private applyHorizontalLayoutStyles(horizontal: boolean): void {
        const content = this.ui.pagesContentEl;
        if (content) {
            content.style.gap = horizontal ? "6px" : "24px";
            content.style.flexDirection = horizontal ? "row" : "column";
            content.style.alignItems = horizontal ? "flex-start" : "center";
        }
        const container = this.ui.pagesContainerEl;
        if (container) {
            container.style.padding = horizontal ? "56px 12px 12px 12px" : "80px 24px 24px 24px";
        }
    }

    // ============================================================
    //  RENDER-DOKUMENT
    // ============================================================
    /** Liest das Frontmatter direkt aus der Datei (der metadataCache hinkt eigenen Schreibvorgängen hinterher). */
    private async readDocumentFresh(): Promise<PdfComposeDocument> {
        if (!this.currentFile) throw new FrontmatterParseError("No file open.");
        try {
            const raw = await this.app.vault.read(this.currentFile);
            const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (match) {
                const fm = YAML.load(match[1]) as any;
                if (fm && typeof fm === "object") {
                    return parseFrontmatter({ frontmatter: fm } as unknown as CachedMetadata);
                }
            }
        } catch (e) {
            if (e instanceof FrontmatterParseError) throw e;
        }
        return parseFrontmatter(this.app.metadataCache.getFileCache(this.currentFile));
    }

    private async renderDocument(): Promise<void> {
        if (!this.currentFile || !this.ui.pagesContainerEl || !this.ui.sidebarListEl) return;
        const generation = ++this.renderGeneration;

        const scrollTargetPageId = this.pendingScrollPageId ?? this.getCurrentVisiblePageId();
        this.pendingScrollPageId = null;

        if (this.styleWriteDebounceTimer !== null) {
            window.clearTimeout(this.styleWriteDebounceTimer);
            this.styleWriteDebounceTimer = null;
            const pending = this.pendingStylePatch;
            this.pendingStylePatch = null;
            if (pending && this.selectionPageId && this.selectedIds.size > 0) {
                await this.applyStyleToSelection(pending);
            }
        }

        this.selectionPointerId = null;
        this.selectionDragStart = null;
        this.selectionPreviewEl?.remove();
        this.selectionPreviewEl = null;
        this.lassoPoints = null;
        this.isMovingSelection = false;
        this.moveOrigin = null;
        this.moveSnapshot = null;
        this.endRangeSession();

        this.ui.clearPages();
        this.resetTouchTracking();
        this.pageObserver?.disconnect();
        this.pageWrapperList = [];
        this.pagePlaceholders.clear();
        this.mountedPageIds.clear();
        this.intersectingPageIds.clear();
        this.annotationsCache.clear();

        let document: PdfComposeDocument;
        try {
            document = await this.readDocumentFresh();
            if (generation !== this.renderGeneration) return;
            this.currentDocument = document;
        } catch (error) {
            this.ui.renderError(error instanceof FrontmatterParseError ? error.message : String(error));
            return;
        }

        this.colorMode = document.colorMode;
        this.pdfTextCache.clear();
        this.ui.setSavePdfTextValue(document.savePdfText === true);
        this.pageIsDarkOriginal.clear();
        this.ui.setColorModeValue(this.colorMode);

        this.pageScales.clear();
        this.pageRasterMultiplier.clear();
        this.pageLogicalSize.clear();
        this.rerasteringPageIds.clear();

        const rawContent = await this.app.vault.cachedRead(this.currentFile);
        if (generation !== this.renderGeneration) return;
        this.textBlocksCache = groupTextBlocksByPage(parseTextBlocks(rawContent, document));
        this.pdfAnnotationsCache = groupPdfAnnotationsByPage(parsePdfAnnotations(rawContent, document));
        this.ocrCache = groupOcrBlocksByPage(parseOcrBlocks(rawContent, document));
        this.shapeLabelsCache = groupShapeLabelsByPage(parseShapeLabels(rawContent, document));
        this.bezierDebugEnabledPageIds.clear();
        this.bezierDebugLayers.clear();

        // Quellen IMMER anzeigen, auch bei leerem Dokument (erste Quelle!)
        this.ui.renderSourcesList(document.sources);

        this.ui.setMovePageHandler(this.movePagesToIndex.bind(this));
        this.ui.setScrollToPageHandler((pageId) => { void this.scrollToPageEnsureMounted(pageId); });
        this.ui.setPageActionHandlers({
            onDeletePages: this.deletePages.bind(this),
            onCopyPages: this.copyPages.bind(this),
            onRotatePages: this.rotatePages.bind(this),
            onPasteBefore: this.pastePagesBefore.bind(this),
            onPasteAfter: this.pastePagesAfter.bind(this),
            onInsertPageBefore: this.insertPagesBefore.bind(this),
            onInsertPageAfter: this.insertPagesAfter.bind(this),
            onShowText: this.showTextForPage.bind(this),
            onRunOcr: (pageId: string) => { void this.runOcrForPage(pageId, { force: true }); },
            onChangePageSource: this.changePageSource.bind(this),
            hasClipboard: () => this.pageClipboard.length > 0,
            onToggleOcrDebug: (pageId: string) => this.toggleOcrDebug(pageId),
        });
        this.ui.clearSelection();

        if (document.pages.length === 0) {
            this.ui.renderEmptyState();
            return;
        }

        const ok = await this.createPagePlaceholders(document, generation);
        if (!ok) return;

        // Thumbnails werden lazy gezeichnet (nur sichtbare Einträge)
        document.pages.forEach((page, index) => {
            this.ui.renderSidebarThumbnail(page, index, document, this.renderer, this.pageLogicalSize.get(page.id));
        });

        this.setupPageVirtualization(document);

        this.ui.updateAnnotationLayerInteractivity(this.currentTool);
        this.ui.updateSidebarHighlights(this.foundPageIds);
        await this.renderSelectionHandles();
        this.updateCurrentPageHighlight();

        if (document.savePdfText === true) {
            await this.extractAllPdfTextIntoCache();
        }

        if (scrollTargetPageId) {
            await this.forceMountPage(scrollTargetPageId);
            this.ui.scrollToPage(scrollTargetPageId, "auto");
        }
    }

    public async removeSource(sourceName: string): Promise<void> {
        if (!this.currentDocument) return;
        const sourcePath = this.currentDocument.sources[sourceName];
        if (sourcePath === undefined) return;
        const affected = this.currentDocument.pages.filter(p => isPdfPage(p) && p.src === sourceName);

        const removeEntry = () => this.modifyFrontmatterWithUndo(
            (fm) => { if (fm.sources) delete fm.sources[sourceName]; },
            (fm) => { if (!fm.sources) fm.sources = {}; fm.sources[sourceName] = sourcePath; },
            "remove-source"
        );

        if (affected.length === 0) {
            await removeEntry();
            return;
        }

        new SourceDeleteModal(this.app, sourceName, affected.length, async (result) => {
            if (result.mode === "delete-pages") {
                await this.deletePages(new Set(affected.map(p => p.id)));
                await removeEntry();
                return;
            }
            const template = result.template ?? "blank";
            const originals = new Map<string, any>(
                affected.map(p => [p.id, structuredClone(p)] as [string, any])
            );
            await this.modifyFrontmatterWithUndo(
                (fm) => {
                    for (const page of fm.pages as any[]) {
                        if (!originals.has(page.id)) continue;
                        page.type = "blank";
                        delete page.src;
                        delete page.srcPage;
                        delete page.rotate;
                        page.template = template;
                        page.size = "A4";
                    }
                    if (fm.sources) delete fm.sources[sourceName];
                },
                (fm) => {
                    if (!fm.sources) fm.sources = {};
                    fm.sources[sourceName] = sourcePath;
                    fm.pages = (fm.pages as any[]).map(page =>
                        originals.has(page.id) ? structuredClone(originals.get(page.id)) : page);
                },
                "remove-source-replace-pages"
            );
        }).open();
    }

    private async changePageSource(pageId: string): Promise<void> {
        if (!this.currentDocument) return;

        const page = this.currentDocument.pages.find(
            p => p.id === pageId
        );

        if (!page) return;

        const oldPage = JSON.parse(
            JSON.stringify(page)
        ) as PageDefinition;

        const cache =
            this.app.metadataCache.getFileCache(
                this.currentFile!
            );

        const doc = parseFrontmatter(cache);

        new AddPageModal(
            this.app,
            doc.sources,
            this.renderer,
            this.plugin.settings.templateFolder,
            async (result) => {
                await this.modifyFrontmatterWithUndo(
                    (fm) => {
                        const target =
                            (fm.pages as any[]).find(
                                (p: any) => p.id === pageId
                            );

                        if (!target) return;

                        if (result.kind === "blank") {
                            target.type = "blank";
                            delete target.src;
                            delete target.srcPage;
                            delete target.rotate;

                            target.template =
                                result.template;
                            target.size =
                                result.size;

                            return;
                        }

                        if (result.kind === "pdf") {
                            if (result.pages.length !== 1) {
                                throw new Error(
                                    "Es darf nur eine Seite ausgewählt werden."
                                );
                            }

                            if (result.isNewSource) {
                                if (!fm.sources) {
                                    fm.sources = {};
                                }

                                fm.sources[result.sourceName] =
                                    result.sourcePath;
                            }

                            target.type = "pdf";
                            target.src =
                                result.sourceName;
                            target.srcPage =
                                result.pages[0];

                            delete target.template;
                            delete target.size;

                            return;
                        }

                        if (result.kind === "templates") {
                            if (result.entries.length !== 1) {
                                throw new Error(
                                    "Es darf nur eine Vorlage ausgewählt werden."
                                );
                            }

                            const selection =
                                result.entries[0];

                            if (selection.kind === "builtin") {
                                target.type = "blank";

                                delete target.src;
                                delete target.srcPage;
                                delete target.rotate;

                                target.template =
                                    selection.templateId;
                                target.size =
                                    selection.size;
                            } else {
                                if (!fm.sources) fm.sources = {};
                                if (!(selection.sourceName in fm.sources)) {
                                    fm.sources[selection.sourceName] = selection.filePath;
                                }

                                target.type = "pdf";
                                target.src =
                                    selection.sourceName;
                                target.srcPage =
                                    selection.page ?? 1;

                                delete target.template;
                                delete target.size;
                            }
                        }
                    },
                    (fm) => {
                        const target =
                            (fm.pages as any[]).find(
                                (p: any) => p.id === pageId
                            );

                        if (!target) return;

                        Object.keys(target).forEach(
                            key => delete target[key]
                        );

                        Object.assign(
                            target,
                            JSON.parse(
                                JSON.stringify(oldPage)
                            )
                        );
                    },
                    "change-page-source"
                );
            },
            page
        ).open();
    }

    private async deletePages(ids: Set<string>): Promise<void> {
        if (!this.currentDocument) return;
        const removed: { page: PageDefinition; index: number }[] = [];
        this.currentDocument.pages.forEach((p, i) => { if (ids.has(p.id)) removed.push({ page: p, index: i }); });
        if (removed.length === 0) return;

        // Frontmatter-Seiten entfernen (mit Undo)
        await this.modifyFrontmatterWithUndo(
            (fm) => { fm.pages = fm.pages.filter((p: any) => !ids.has(p.id)); },
            (fm) => {
                for (const { page, index } of removed) {
                    const insertAt = Math.min(index, fm.pages.length);
                    fm.pages.splice(insertAt, 0, page);
                }
            },
            "delete-pages"
        );

        // ----- Vektorannotationen (Frontmatter) -----
        if (ids.size > 0) {
            await this.modifyFrontmatter((fm) => {
                for (const id of ids) delete fm.annotations[id];
            });
        }

        // ----- Metadaten für Textblöcke, Anmerkungen, OCR entfernen -----
        await this.updateFileAtomic(
            (fm) => {
                if (fm.textBlocks) fm.textBlocks = fm.textBlocks.filter((b: any) => !ids.has(b.pageId));
                if (fm.pdfAnnotations) fm.pdfAnnotations = fm.pdfAnnotations.filter((a: any) => !ids.has(a.pageId));
                if (fm.shapeLabels) fm.shapeLabels = fm.shapeLabels.filter((s: any) => !ids.has(s.pageId));
            },
            (body) => {
                // Body-Blöcke (Kommentare) müssen ebenfalls entfernt werden
                let content = body;
                for (const id of ids) {
                    const textBlocks = this.textBlocksCache.get(id) || [];
                    for (const b of textBlocks) {
                        content = removeTextBlock(content, b.id);
                    }
                    const annots = this.pdfAnnotationsCache.get(id) || [];
                    for (const a of annots) {
                        content = removePdfAnnotation(content, a.id);
                    }
                    const ocr = this.ocrCache.get(id) || [];
                    for (const o of ocr) {
                        content = removeOcrBlock(content, o.id);
                    }
                }
                return content;
            }
        );

        await this.reorderAllBodyBlocks();

        // Caches leeren
        for (const id of ids) {
            this.textBlocksCache.delete(id);
            this.pdfAnnotationsCache.delete(id);
            this.ocrCache.delete(id);
        }
    }

    /**
 * Bereinigt die Datei von verwaisten Annotationen (Seite existiert nicht mehr).
 * Gibt `true` zurück, wenn Änderungen vorgenommen wurden (Datei wurde gespeichert).
 */
    private async cleanFile(): Promise<void> {
        if (!this.currentFile) return;
        const cache = this.app.metadataCache.getFileCache(this.currentFile);
        let document: PdfComposeDocument;
        try {
            document = parseFrontmatter(cache);
            this.currentDocument = document;
        } catch {
            return;
        }
        const validPageIds = new Set(document.pages.map(p => p.id));
        let content = await this.app.vault.read(this.currentFile);
        let changed = false;

        // 1. Vektorannotationen (Frontmatter)
        const invalidVectorIds = Object.keys(document.annotations).filter(id => !validPageIds.has(id));
        if (invalidVectorIds.length > 0) {
            await this.modifyFrontmatter((fm) => {
                for (const id of invalidVectorIds) delete fm.annotations[id];
            });
            changed = true;
        }

        // 2. TextBlock-Metadaten
        const validTextMeta = (document.textBlocks || []).filter(m => validPageIds.has(m.pageId));
        if (validTextMeta.length !== (document.textBlocks || []).length) {
            await this.modifyFrontmatter((fm) => {
                fm.textBlocks = validTextMeta;
            });
            changed = true;
        }

        // 3. PDF-Anmerkungs-Metadaten
        const validAnnotMeta = (document.pdfAnnotations || []).filter(m => validPageIds.has(m.pageId));
        if (validAnnotMeta.length !== (document.pdfAnnotations || []).length) {
            await this.modifyFrontmatter((fm) => {
                fm.pdfAnnotations = validAnnotMeta;
            });
            changed = true;
        }

        // 4. OCR-Metadaten
        const validOcrMeta = (document.ocrBlocks || []).filter(m => validPageIds.has(m.pageId));
        if (validOcrMeta.length !== (document.ocrBlocks || []).length) {
            await this.modifyFrontmatter((fm) => {
                fm.ocrBlocks = validOcrMeta;
            });
            changed = true;
        }

        if (changed) {
            // Warte auf 'changed'-Event, das die View neu lädt
        }
    }

    private snapshotPage(page: PageDefinition): PageSnapshot {
        return {
            page: structuredClone(page),
            objects: this.getPageAnnotations(page.id).map(o => structuredClone(o)),
            textBlocks: (this.textBlocksCache.get(page.id) ?? []).map(b => ({ ...b })),
            pdfAnnotations: (this.pdfAnnotationsCache.get(page.id) ?? []).map(a => ({
                ...a, rects: a.rects.map(r => ({ ...r })),
            })),
            ocr: this.ocrCache.get(page.id)?.[0] ? structuredClone(this.ocrCache.get(page.id)![0]) : null,
        };
    }

    private copyPages(ids: Set<string>): void {
        if (!this.currentDocument) return;
        this.pageClipboard = this.currentDocument.pages
            .filter(p => ids.has(p.id))
            .map(p => this.snapshotPage(p));
    }

    /** Erzeugt aus einem Snapshot eine Seite mit komplett neuen IDs. */
    private instantiatePageSnapshot(snap: PageSnapshot): PreparedPage {
        const newPageId = crypto.randomUUID();
        const page: any = structuredClone(snap.page);
        page.id = newPageId;

        const idMap = new Map<string, string>();
        for (const o of snap.objects) idMap.set(o.id, crypto.randomUUID());

        const objects = snap.objects.map((o) => {
            const copy: any = structuredClone(o);
            copy.id = idMap.get(o.id);
            for (const key of ["startBinding", "endBinding"]) {
                const b = copy[key];
                if (!b) continue;
                const mapped = idMap.get(b.objectId);
                copy[key] = mapped ? { ...b, objectId: mapped } : undefined;
            }
            return copy as VectorObject;
        });

        const shapeLabels: ShapeLabelEntry[] = [];
        for (const o of objects) {
            const label: any = (o as any).label;
            if (label?.text?.trim()) {
                shapeLabels.push({
                    id: o.id, pageId: newPageId, shapeId: o.id,
                    fontSize: label.fontSize, color: label.color, mode: label.mode, text: label.text,
                });
            }
        }

        return {
            page,
            objects,
            shapeLabels,
            textBlocks: snap.textBlocks.map(b => ({ ...b, id: crypto.randomUUID(), pageId: newPageId })),
            pdfAnnotations: snap.pdfAnnotations.map(a => ({
                ...a, id: crypto.randomUUID(), pageId: newPageId, rects: a.rects.map(r => ({ ...r })),
            })),
            ocr: snap.ocr
                ? { ...snap.ocr, id: crypto.randomUUID(), pageId: newPageId, hash: this.ocrController.computeStrokeHash(objects) }
                : null,
        };
    }

    private async insertPreparedPages(prepared: PreparedPage[], targetId: string, where: "before" | "after"): Promise<void> {
        const newPages = prepared.map(p => p.page);
        await this.updateFileAtomic(
            (fm) => {
                const pages = fm.pages as any[];
                const idx = pages.findIndex((p: any) => p.id === targetId);
                if (idx === -1) {
                    if (where === "before") pages.unshift(...newPages); else pages.push(...newPages);
                } else {
                    pages.splice(where === "before" ? idx : idx + 1, 0, ...newPages);
                }
                if (!fm.annotations) fm.annotations = {};
                for (const p of prepared) {
                    if (p.objects.length > 0) fm.annotations[p.page.id] = encodeAnnotations(p.objects);
                    if (p.textBlocks.length > 0) {
                        fm.textBlocks = fm.textBlocks ?? [];
                        for (const { markdown: _m, ...meta } of p.textBlocks) fm.textBlocks.push(meta);
                    }
                    if (p.pdfAnnotations.length > 0) {
                        fm.pdfAnnotations = fm.pdfAnnotations ?? [];
                        for (const { markdown: _m, ...meta } of p.pdfAnnotations) fm.pdfAnnotations.push(meta);
                    }
                    if (p.ocr) {
                        fm.ocrBlocks = fm.ocrBlocks ?? [];
                        fm.ocrBlocks.push({ id: p.ocr.id, pageId: p.ocr.pageId, hash: p.ocr.hash, words: p.ocr.words });
                    }
                    if (p.shapeLabels.length > 0) {
                        fm.shapeLabels = fm.shapeLabels ?? [];
                        for (const l of p.shapeLabels) {
                            fm.shapeLabels.push({
                                id: l.id, pageId: l.pageId, shapeId: l.shapeId,
                                fontSize: l.fontSize, color: l.color, mode: l.mode,
                            });
                        }
                    }
                }
            },
            (body) => {
                let b = body;
                for (const p of prepared) {
                    for (const t of p.textBlocks) b = upsertTextBlock(b, t);
                    for (const a of p.pdfAnnotations) b = upsertPdfAnnotation(b, a);
                    if (p.ocr) b = upsertOcrBlock(b, p.ocr);
                    for (const l of p.shapeLabels) b = upsertShapeLabel(b, l);
                }
                return b;
            },
            false // nicht unterdrücken: die View muss die neuen Seiten rendern
        );
        this.pendingScrollPageId = newPages[0]?.id ?? null;
    }

    private async pasteClipboardPages(targetId: string, where: "before" | "after"): Promise<void> {
        if (this.pageClipboard.length === 0) return;
        const prepared = this.pageClipboard.map(s => this.instantiatePageSnapshot(s));
        const newIds = new Set(prepared.map(p => p.page.id));

        await this.insertPreparedPages(prepared, targetId, where);

        this.pushUndo({
            label: "paste-pages",
            undo: async () => { await this.deletePages(newIds); },
            redo: async () => { await this.insertPreparedPages(prepared, targetId, where); },
        });
    }

    private async rotatePages(ids: Set<string>): Promise<void> {
        if (!this.currentDocument) return;
        const prior = new Map<string, 0 | 90 | 180 | 270>();
        for (const p of this.currentDocument.pages) {
            if (ids.has(p.id) && p.type !== "blank") {
                prior.set(p.id, (p as PdfPageDefinition).rotate ?? 0);
            }
        }
        if (prior.size === 0) return;

        await this.modifyFrontmatterWithUndo(
            (fm) => {
                for (const page of fm.pages) {
                    if (ids.has(page.id) && page.type !== "blank") {
                        const current = page.rotate || 0;
                        page.rotate = ((current + 90) % 360) as 0 | 90 | 180 | 270;
                    }
                }
            },
            (fm) => {
                for (const page of fm.pages) {
                    if (prior.has(page.id)) page.rotate = prior.get(page.id);
                }
            },
            "rotate-pages"
        );
    }

    private async pastePagesBefore(targetId: string): Promise<void> {
        await this.pasteClipboardPages(targetId, "before");
    }

    private async pastePagesAfter(targetId: string): Promise<void> {
        await this.pasteClipboardPages(targetId, "after");
    }

    /** Wandelt ein AddPageResult (aus AddPageModal) in eine Liste neuer Seiten-Objekte um. */
    private buildNewPagesFromAddResult(result: AddPageResult): any[] {
        if (result.kind === "blank") {
            return [{
                id: crypto.randomUUID(),
                type: "blank" as const,
                template: result.template,
                size: result.size,
            }];
        }
        if (result.kind === "pdf") {
            return result.pages.map((pg: number) => ({
                id: crypto.randomUUID(),
                src: result.sourceName,
                srcPage: pg,
            }));
        }
        if (result.kind === "templates") {
            const pages: any[] = [];
            for (const sel of result.entries) {
                if (sel.kind === "builtin") {
                    pages.push({
                        id: crypto.randomUUID(),
                        type: "blank" as const,
                        template: sel.templateId,
                        size: sel.size,
                    });
                } else {
                    pages.push({
                        id: crypto.randomUUID(),
                        src: sel.sourceName,
                        srcPage: sel.page ?? 1,
                    });
                }
            }
            return pages;
        }
        return [];
    }

    // ============================================================
    //  OCR (Handschrifterkennung für Stift-Striche)
    // ============================================================

    /** Aktueller OCR-Block einer Seite (es wird immer höchstens einer je Seite gepflegt). */
    private getOcrEntryForPage(pageId: string): OcrBlockEntry | undefined {
        return (this.ocrCache.get(pageId) ?? [])[0];
    }

    /** Führt OCR für eine einzelne Seite aus (überspringt unveränderte Seiten, außer force=true). */
    public async runOcrForPage(pageId: string, options: { silent?: boolean; force?: boolean } = {}): Promise<void> {
        if (!this.currentFile || !this.plugin.settings.ocrEnabled) return;
        const objects = this.getPageAnnotations(pageId);
        const hash = this.ocrController.computeStrokeHash(objects);
        const existing = this.getOcrEntryForPage(pageId);

        // Prüfen, ob der Block noch tatsächlich im Body steht. Wurde der
        // Kommentar manuell gelöscht, reicht ein übereinstimmender Hash NICHT
        // zum Überspringen – sonst wird er nie wiederhergestellt.
        let blockExistsInBody = false;
        if (existing) {
            try {
                const raw = await this.app.vault.read(this.currentFile);
                blockExistsInBody = extractOcrBlockContents(raw).has(existing.id);
            } catch { /* ignore */ }
        }

        if (!options.force && existing && existing.hash === hash && blockExistsInBody) return;

        if (!options.silent) new Notice("OCR running…");
        let words;
        try {
            words = await this.ocrController.recognizePage(objects);
        } catch (error) {
            if (!options.silent) new Notice(`OCR failed: ${String(error)}`);
            else console.error("PdfComposePlugin: OCR failed", error);
            return;
        }

        const entry: OcrBlockEntry = {
            id: existing?.id ?? crypto.randomUUID(),
            pageId,
            hash,
            words,
        };
        await this.saveOcrBlockRaw(entry);
        if (!options.silent) new Notice(`OCR completed: ${words.length} word(s) recognized.`);
    }

    /** Führt OCR für alle Seiten mit Stift-Strichen im Dokument aus. */
    public async runOcrForDocument(): Promise<void> {
        if (!this.currentDocument || !this.plugin.settings.ocrEnabled) return;
        let processed = 0;
        for (const page of this.currentDocument.pages) {
            const objects = this.getPageAnnotations(page.id);
            const hasEligibleStrokes = objects.some(o => o.type === "freehand" && o.highlighter !== true);
            if (!hasEligibleStrokes) continue;
            await this.runOcrForPage(page.id, { silent: true });
            processed++;
        }
        new Notice(processed > 0
            ? `OCR: ${processed} page(s) fully re-recognized.`
            : "OCR: No pages with stylus strokes found.");
    }

    public async runOcrForDocumentForce(): Promise<void> {
        if (!this.currentDocument || !this.plugin.settings.ocrEnabled) return;
        let processed = 0;
        for (const page of this.currentDocument.pages) {
            const objects = this.getPageAnnotations(page.id);
            const hasEligibleStrokes = objects.some(o => o.type === "freehand" && o.highlighter !== true);
            if (!hasEligibleStrokes) continue;
            await this.runOcrForPage(page.id, { silent: true, force: true });
            processed++;
        }
        new Notice(processed > 0
            ? `OCR: ${processed} page(s) fully re-recognized.`
            : "OCR: No pages with stylus strokes found.");
    }

    /**
     * Aktualisiert OCR für alle Seiten, deren Stift-Striche sich seit der
     * letzten Erkennung geändert haben (oder für die noch nie OCR lief).
     * Wird automatisch vor jeder Volltextsuche aufgerufen (siehe
     * _performSearch), sofern ocrRunOnSearch aktiv ist.
     */
    private async ensureOcrUpToDate(): Promise<void> {
        if (!this.currentDocument || !this.plugin.settings.ocrEnabled) return;
        for (const page of this.currentDocument.pages) {
            const objects = this.getPageAnnotations(page.id);
            const strokes = objects.filter(o => o.type === "freehand" && o.highlighter !== true);
            if (strokes.length === 0) continue;
            await this.runOcrForPage(page.id, { silent: true });
        }
    }

    private async saveOcrBlockRaw(entry: OcrBlockEntry): Promise<void> {
        await this.updateFileAtomic(
            (fm) => {
                if (!fm.ocrBlocks) fm.ocrBlocks = [];
                const idx = fm.ocrBlocks.findIndex((o: any) => o.id === entry.id);
                const meta = {
                    id: entry.id,
                    pageId: entry.pageId,
                    hash: entry.hash,
                    words: entry.words,
                };
                if (idx === -1) fm.ocrBlocks.push(meta);
                else fm.ocrBlocks[idx] = meta;
            },
            (body) => upsertOcrBlock(body, entry)
        );
        // Cache aktualisieren
        this.ocrCache.set(entry.pageId, [entry]); // es wird nur ein Block pro Seite gepflegt
    }

    private async deleteOcrBlockRaw(entry: OcrBlockEntry): Promise<void> {
        await this.updateFileAtomic(
            (fm) => {
                if (fm.ocrBlocks) {
                    fm.ocrBlocks = fm.ocrBlocks.filter((o: any) => o.id !== entry.id);
                }
            },
            (body) => removeOcrBlock(body, entry.id)
        );
        this.ocrCache.delete(entry.pageId);
    }

    private async removeOcrBlockForPage(pageId: string): Promise<void> {
        const entries = this.ocrCache.get(pageId) ?? [];
        if (entries.length === 0) return;
        const entry = entries[0];
        await this.deleteOcrBlockRaw(entry);
    }

    /**
     * Periodisch (siehe onOpen) aufgerufen. Prüft, ob der Hauptthread gerade
     * frei ist (requestIdleCallback) und der Nutzer kurz nicht interagiert
     * hat, und stößt in diesem Fall einen Hintergrund-OCR-Durchlauf an.
     */
    private scheduleIdleOcrCheck(): void {
        if (!this.plugin.settings.ocrEnabled || !this.plugin.settings.ocrBackgroundEnabled) return;
        if (this.ocrBackgroundRunning) return;
        if (Date.now() - this.ocrLastInteractionAt < this.plugin.settings.ocrIdleQuietMs) return;

        const runIdle = () => { void this.runIdleOcrPass(); };
        const w = window as any;
        if (typeof w.requestIdleCallback === "function") {
            w.requestIdleCallback(runIdle, { timeout: 2000 });
        } else {
            window.setTimeout(runIdle, 0);
        }
    }

    /** Erkennt im Hintergrund höchstens EINE geänderte Seite pro Durchlauf, um die UI reaktionsfähig zu halten. */
    private async runIdleOcrPass(): Promise<void> {
        if (this.ocrBackgroundRunning) return;
        if (!this.currentDocument || !this.plugin.settings.ocrEnabled || !this.plugin.settings.ocrBackgroundEnabled) return;
        if (Date.now() - this.ocrLastInteractionAt < this.plugin.settings.ocrIdleQuietMs) return;

        this.ocrBackgroundRunning = true;
        try {
            for (const page of this.currentDocument.pages) {
                const objects = this.getPageAnnotations(page.id);
                const strokes = objects.filter(o => o.type === "freehand" && o.highlighter !== true);
                if (strokes.length === 0) continue;
                const hash = this.ocrController.computeStrokeHash(objects);
                const existing = this.getOcrEntryForPage(page.id);
                if (existing && existing.hash === hash) continue;

                await this.runOcrForPage(page.id, { silent: true });
                break;
            }
        } catch (error) {
            console.error("PdfComposePlugin: Background OCR failed", error);
        } finally {
            this.ocrBackgroundRunning = false;
        }
    }

    private async showTextForPage(pageId: string): Promise<void> {
        if (!this.currentDocument) return;
        const page = this.currentDocument.pages.find(p => p.id === pageId);
        if (!page || !isPdfPage(page)) return;
        const sourcePath = this.currentDocument.sources[page.src];
        if (!sourcePath) return;
        try {
            const text = await this.renderer.getPageText(sourcePath, page.srcPage);
            new TextDisplayModal(this.app, text).open();
        } catch (err) {
            new Notice(`Could not load text: ${err}`);
        }
    }

    /** Springt zur ersten im Compose-Dokument vorhandenen Seite, die auf `sourceName`/`srcPageNumber` verweist (Ziel eines internen PDF-Links). */
    private async jumpToSourcePage(sourceName: string, srcPageNumber: number): Promise<void> {
        if (!this.currentDocument) return;
        const target = this.currentDocument.pages.find(
            p => isPdfPage(p) && p.src === sourceName && p.srcPage === srcPageNumber
        );
        if (target) {
            this.ui.scrollToPage(target.id);
        } else {
            new Notice(`Page ${srcPageNumber} of source "${sourceName}" is not contained in this Compose document.`);
        }
    }

    // ============================================================
    //  EINZELNE SEITE RENDERN / SEITEN-VIRTUALISIERUNG
    // ============================================================

    /** Hängt den Inhalt einer Seite in einen bereits vorhandenen Platzhalter ein (siehe createPagePlaceholders/mountPage). */
    private async renderSinglePage(page: PageDefinition, doc: PdfComposeDocument, wrapper: HTMLElement): Promise<void> {
        const body = this.ui.hydratePagePlaceholder(wrapper);
        const canvasSlot = this.ui.createCanvasSlot(body);

        if (isBlankPage(page)) {
            await this.renderBlankTemplatePage(page, doc, canvasSlot, body);
        } else if (isPdfPage(page)) {
            await this.renderPdfPage(page, doc, canvasSlot, body);
        }
        if (this.ocrDebugEnabledPageIds.has(page.id)) {
            this.renderOcrDebugForPage(page.id);
        }
        if (this.ocrDebugEnabledPageIds.has(page.id)) {
            this.renderOcrDebugForPage(page.id);
        }
        if (this.bezierDebugEnabledPageIds.has(page.id)) {
            this.renderBezierDebugForPage(page.id);
        }
    }

    /**
     * Legt für jede Seite einen größengleichen Platzhalter an. Für PDF-
     * Seiten wird dafür nur die Viewport-Größe abgefragt (billig, das
     * Dokument ist ohnehin gecacht), OHNE die Seite zu rastern.
     */
    private async createPagePlaceholders(doc: PdfComposeDocument, generation: number): Promise<boolean> {
        this.pagePlaceholders.clear();
        this.mountedPageIds.clear();
        this.pageMountPromises.clear();
        this.intersectingPageIds.clear();
        this.pageWrapperList = [];

        // Schnelle Schätzung: Größe je (Quelle, Rotation) nur einmal abfragen.
        const estimateCache = new Map<string, Promise<{ width: number; height: number }>>();
        const estimate = (page: PageDefinition) => {
            if (isBlankPage(page)) return this.computePageLogicalSize(page, doc);
            const key = `${page.src}|${page.rotate ?? 0}`;
            let p = estimateCache.get(key);
            if (!p) {
                p = this.computePageLogicalSize(page, doc);
                estimateCache.set(key, p);
            }
            return p;
        };
        const sizes = await Promise.all(doc.pages.map(estimate));
        if (generation !== this.renderGeneration) return false;

        doc.pages.forEach((page, index) => {
            const { width, height } = sizes[index];
            this.pageLogicalSize.set(page.id, { width, height });
            const annotWidth = this.getAnnotationColumnWidth(page.id);
            const wrapper = this.ui.createPagePlaceholder(page.id, index, width, height, annotWidth);
            this.pagePlaceholders.set(page.id, wrapper);
            this.pageWrapperList.push(wrapper);
        });

        void this.refinePlaceholderSizes(doc, generation);
        return true;
    }

    /** Ermittelt im Hintergrund die exakten Seitengrößen und korrigiert nicht gemountete Platzhalter. */
    private async refinePlaceholderSizes(doc: PdfComposeDocument, generation: number): Promise<void> {
        const pdfPages = doc.pages.filter(isPdfPage);
        const BATCH = 6;
        for (let i = 0; i < pdfPages.length; i += BATCH) {
            if (generation !== this.renderGeneration) return;
            const batch = pdfPages.slice(i, i + BATCH);
            const sizes = await Promise.all(batch.map(p => this.computePageLogicalSize(p, doc)));
            if (generation !== this.renderGeneration) return;
            batch.forEach((page, j) => {
                const known = this.pageLogicalSize.get(page.id);
                const s = sizes[j];
                if (known && Math.abs(known.width - s.width) < 0.5 && Math.abs(known.height - s.height) < 0.5) return;
                this.pageLogicalSize.set(page.id, s);
                if (!this.mountedPageIds.has(page.id)) {
                    const wrapper = this.pagePlaceholders.get(page.id);
                    if (wrapper) this.ui.updatePlaceholderSize(wrapper, s.width, s.height);
                }
            });
            await new Promise<void>((r) => window.setTimeout(r, 0));
        }
    }

    /**
     * Breite der Anmerkungsspalte für die Platzhalter-Reservierung. Muss EXAKT
     * zur Formel in renderPdfAnnotationsForPage() passen, sonst schiebt das
     * Mounten einer Seite die nachfolgenden Seiten horizontal weg.
     */
    private getAnnotationColumnWidth(pageId: string): number {
        const entries = this.pdfAnnotationsCache.get(pageId) ?? [];
        if (entries.length === 0) return 0;
        let maxWidth = 220;
        for (const entry of entries) maxWidth = Math.max(maxWidth, entry.width);
        return (maxWidth + 20) * DEFAULT_RENDER_SCALE;
    }

    /** Ermittelt die feste Anzeigegröße einer Seite, OHNE sie zu rastern (für Platzhalter bei der Seiten-Virtualisierung). */
    private async computePageLogicalSize(page: PageDefinition, doc: PdfComposeDocument): Promise<{ width: number; height: number }> {
        if (isBlankPage(page)) {
            const size = typeof page.size === "object" ? page.size : PAGE_SIZES[page.size ?? "A4"];
            return { width: size.width * DEFAULT_RENDER_SCALE, height: size.height * DEFAULT_RENDER_SCALE };
        }
        const sourcePath = doc.sources[page.src];
        if (!sourcePath) {
            return { width: PAGE_SIZES.A4.width * DEFAULT_RENDER_SCALE, height: PAGE_SIZES.A4.height * DEFAULT_RENDER_SCALE };
        }
        try {
            return await this.renderer.getPageViewportSize(sourcePath, page.srcPage, DEFAULT_RENDER_SCALE, page.rotate ?? 0);
        } catch {
            return { width: PAGE_SIZES.A4.width * DEFAULT_RENDER_SCALE, height: PAGE_SIZES.A4.height * DEFAULT_RENDER_SCALE };
        }
    }

    /**
     * Baut den IntersectionObserver auf, der Seiten in der Nähe des
     * sichtbaren Bereichs automatisch ein- ("mounten") und weit entfernte
     * Seiten wieder aushängt ("unmounten"). rootMargin definiert dabei die
     * Vorlade-/Behalte-Zone (aktuell: ca. eine Container-Höhe über/unter
     * dem sichtbaren Bereich) - groß genug, um Ruckler beim Ein-/Aushängen
     * zu vermeiden, klein genug, um bei langen Dokumenten wirklich Speicher
     * zu sparen.
     */
    private setupPageVirtualization(doc: PdfComposeDocument): void {
        this.pageObserver?.disconnect();
        this.intersectingPageIds.clear();
        const horizontal = this.plugin.settings.horizontalLayout;

        this.pageObserver = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const pageId = (entry.target as HTMLElement).dataset.pageId;
                    if (!pageId) continue;
                    if (entry.isIntersecting) {
                        this.intersectingPageIds.add(pageId);
                        void this.mountPage(pageId, doc);
                    } else {
                        this.intersectingPageIds.delete(pageId);
                        this.unmountPage(pageId);
                    }
                }
            },
            { root: this.ui.pagesContainerEl, rootMargin: horizontal ? "0px 100%" : "100% 0px", threshold: 0 }
        );

        for (const wrapper of this.pagePlaceholders.values()) {
            this.pageObserver.observe(wrapper);
        }
    }

    private async mountPage(pageId: string, doc: PdfComposeDocument): Promise<void> {
        if (this.mountedPageIds.has(pageId)) return;
        const existing = this.pageMountPromises.get(pageId);
        if (existing) { await existing; return; }

        const wrapper = this.pagePlaceholders.get(pageId);
        const page = doc.pages.find(p => p.id === pageId);
        if (!wrapper || !page) return;
        const generation = this.renderGeneration;

        const promise = (async () => {
            this.pageMountGeneration.set(pageId, (this.pageMountGeneration.get(pageId) ?? 0) + 1);
            await this.renderSinglePage(page, doc, wrapper);
            if (generation !== this.renderGeneration) return;
            this.mountedPageIds.add(pageId);

            if (this.allMatches.length > 0) {
                this.ui.renderAllHighlights(this.allMatches);
                if (this.currentMatchIndex >= 0) this.ui.setActiveHighlight(this.currentMatchIndex, false);
            }
            if (pageId === this.selectionPageId && this.selectedIds.size > 0) {
                this.ui.updateSelectionHighlight(pageId, this.selectedIds, this.selectedTextBlockIds, this.selectedPdfAnnotationIds);
                await this.renderSelectionHandles();
            }
            this.ui.updateAnnotationLayerInteractivity(this.currentTool);
        })();

        this.pageMountPromises.set(pageId, promise);
        try {
            await promise;
        } finally {
            this.pageMountPromises.delete(pageId);
            // Wurde die Seite während des Mountens wieder aus dem Sichtbereich gescrollt,
            // hätte sonst niemand mehr ein Unmount ausgelöst.
            window.setTimeout(() => {
                if (this.mountedPageIds.has(pageId) && !this.intersectingPageIds.has(pageId)) {
                    this.unmountPage(pageId);
                }
            }, 2500);
        }
    }

    private unmountPage(pageId: string, force: boolean = false): void {
        if (!this.mountedPageIds.has(pageId)) return;
        if (this.pageMountPromises.has(pageId)) return;
        if (!force) {
            if (pageId === this.activeStrokePageId) return;
            if (pageId === this.selectionPageId && this.selectedIds.size > 0) return;
            if (pageId === this.dragPageId || pageId === this.textDragPageId || pageId === this.multiPageId) return;
            if (pageId === this.eraserActivePageId) return;
            if (pageId === this.rangeSession?.pageId) return;
        }

        const wrapper = this.pagePlaceholders.get(pageId);
        const size = this.pageLogicalSize.get(pageId);
        if (!wrapper || !size) return;

        if (this.rangeSession?.pageId === pageId) this.endRangeSession();

        const annotWidth = this.getAnnotationColumnWidth(pageId);

        for (const entry of this.textBlocksCache.get(pageId) ?? []) {
            this.textBlockComponents.get(entry.id)?.unload();
            this.textBlockComponents.delete(entry.id);
        }
        for (const entry of this.pdfAnnotationsCache.get(pageId) ?? []) {
            this.pdfAnnotationComponents.get(entry.id)?.unload();
            this.pdfAnnotationComponents.delete(entry.id);
        }

        this.ui.annotationLayers.delete(pageId);
        this.ui.highlightLayers.delete(pageId);
        this.ui.pageOverlays.delete(pageId);
        this.ui.textBlockLayers.delete(pageId);
        this.ui.annotationColumns.delete(pageId);
        this.ui.connectorLayers.delete(pageId);
        this.ocrDebugLayers.delete(pageId);
        this.bezierDebugLayers.delete(pageId);

        this.pageScales.delete(pageId);
        this.pageRasterMultiplier.delete(pageId);

        this.ui.dehydratePage(wrapper, size.width, size.height, annotWidth);
        this.mountedPageIds.delete(pageId);
    }

    /** Hängt alle gemounteten Seiten neu ein (Farbmodus/Filter geändert) – OHNE das Dokument neu aufzubauen. */
    private async remountMountedPages(): Promise<void> {
        if (!this.currentDocument) return;
        const doc = this.currentDocument;
        await Promise.all(Array.from(this.pageMountPromises.values()).map(p => p.catch(() => { /* ignore */ })));
        const ids = Array.from(this.mountedPageIds);
        for (const id of ids) this.unmountPage(id, true);
        await Promise.all(ids.filter(id => this.intersectingPageIds.has(id)).map(id => this.mountPage(id, doc)));
    }

    private async remountPage(pageId: string): Promise<void> {
        if (!this.currentDocument || !this.mountedPageIds.has(pageId)) return;
        await (this.pageMountPromises.get(pageId)?.catch(() => { /* ignore */ }));
        this.unmountPage(pageId, true);
        if (this.intersectingPageIds.has(pageId)) await this.mountPage(pageId, this.currentDocument);
    }

    /** Erzwingt das Einhängen einer Seite unabhängig vom Scroll-/Sichtbarkeitsstatus (z. B. Sprung zu einem Suchtreffer oder Klick in der Seitenübersicht). */
    private async forceMountPage(pageId: string): Promise<void> {
        if (!this.currentDocument) return;
        await this.mountPage(pageId, this.currentDocument);
    }

    /** Stellt sicher, dass eine Seite gerendert ist, bevor zu ihr gescrollt wird. */
    private async scrollToPageEnsureMounted(pageId: string): Promise<void> {
        await this.forceMountPage(pageId);
        this.ui.scrollToPage(pageId);
    }

    private async renderBlankTemplatePage(
        page: BlankPageDefinition,
        doc: PdfComposeDocument,
        container: HTMLElement,
        body: HTMLElement
    ): Promise<void> {
        const size = typeof page.size === "object" ? page.size : PAGE_SIZES[page.size ?? "A4"];
        const scale = DEFAULT_RENDER_SCALE;
        this.pageIsDarkOriginal.set(page.id, false);

        const { wrapper, canvas } = this.ui.renderPdfPageContainer(page.id, container);
        try {
            const dpr = this.getTargetRasterMultiplier(page.id);
            const dark = this.isPageInverted(page);
            canvas.width = size.width * scale * dpr;
            canvas.height = size.height * scale * dpr;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Konnte 2D-Rendering-Kontext des Canvas nicht erstellen.");
            drawTemplatePattern(ctx, page.template ?? "blank", size.width, size.height, scale * dpr, dark);
            canvas.style.width = `${size.width * scale}px`;
            canvas.style.height = `${size.height * scale}px`;
            this.pageLogicalSize.set(page.id, { width: size.width * scale, height: size.height * scale });
            this.pageRasterMultiplier.set(page.id, dpr);

            const effectiveScale = scale;
            this.pageScales.set(page.id, effectiveScale);

            // 🔥 NEU: Overlay für Such-Highlights und andere Overlays anlegen
            this.ui.createOverlay(wrapper, page.id, { width: size.width, height: size.height }, effectiveScale);

            const rawWidth = size.width;
            const rawHeight = size.height;

            this.ui.createConnectorLayer(page.id, wrapper);
            this.ui.createHighlightLayer(page.id, wrapper, rawWidth, rawHeight);
            this.ui.setHighlightLayerBlendMode(page.id, dark);
            this.ui.setHighlightLayerBlendMode(page.id, dark);
            this.ui.setConnectorLayerBlendMode(page.id, dark);
            this.drawPdfAnnotationHighlights(page.id);

            this.ui.createTextBlockLayer(wrapper, page.id);
            await this.renderTextBlocksForPage(page.id, effectiveScale);

            this.ui.renderAnnotationLayer(
                page.id, wrapper, rawWidth, rawHeight, doc,
                this.currentTool,
                (evt, svg, id) => this.onAnnotationPointerDown(evt, svg, id),
                (evt, svg, id) => this.onAnnotationPointerMove(evt, svg, id),
                (evt, svg, id) => this.onAnnotationPointerUp(evt, svg, id)
            );

            this.attachPageDoubleClickHandler(page.id, wrapper);
            this.ui.createAnnotationColumn(page.id, body);
            await this.renderPdfAnnotationsForPage(page.id, effectiveScale);
        } catch (error) {
            container.createDiv({ cls: "pdfcompose-error", text: `Konnte Leerseite "${page.id}" nicht rendern: ${String(error)}` });
        }
    }

    /**
 * Registriert den Doppelklick-Handler auf dem gesamten Seiten-Wrapper statt
 * nur auf der Annotations-SVG: Bei aktivem Zeiger-Werkzeug ("none") hat die
 * Annotations-Ebene bewusst pointer-events:none (damit PDF-Textauswahl und
 * Links funktionieren) und würde daher NIE ein dblclick-Ereignis empfangen.
 * Der Wrapper selbst bleibt immer interaktiv. onSvgDblClick() berechnet die
 * Position ohnehin über evt.clientX/clientY relativ zur CTM der Annotations-
 * SVG - das funktioniert unabhängig vom pointer-events-Status.
 */
    private attachPageDoubleClickHandler(pageId: string, wrapper: HTMLElement): void {
        wrapper.addEventListener("dblclick", (evt) => {
            this.onSvgDblClick(evt, pageId);
        });
    }

    private async renderPdfPage(page: PdfPageDefinition, doc: PdfComposeDocument, container: HTMLElement, body: HTMLElement): Promise<void> {
        const sourcePath = doc.sources[page.src];
        if (!sourcePath) {
            container.createDiv({ cls: "pdfcompose-error", text: `Unbekannte Quelle "${page.src}" für Seite "${page.id}".` });
            return;
        }

        const { wrapper, canvas } = this.ui.renderPdfPageContainer(page.id, container);
        try {
            const dpr = this.getTargetRasterMultiplier(page.id);
            const viewport = await this.renderer.renderPageToCanvas(
                sourcePath, page.srcPage, canvas,
                { scale: DEFAULT_RENDER_SCALE, rotate: page.rotate ?? 0, pixelRatio: dpr }
            );
            const isDarkOriginal = this.renderer.detectBackgroundIsDark(sourcePath, page.srcPage, canvas);
            this.pageIsDarkOriginal.set(page.id, isDarkOriginal);

            // viewport.width/height = CSS-Anzeigegröße (DEFAULT_RENDER_SCALE * pageSize)
            canvas.style.width = `${viewport.width}px`;
            canvas.style.height = `${viewport.height}px`;

            await this.applyColorModeToPageCanvas(
                page, wrapper, canvas, sourcePath,
                DEFAULT_RENDER_SCALE * dpr,
                viewport.width, viewport.height,   // NEU
            );
            this.pageRasterMultiplier.set(page.id, dpr);

            this.pageLogicalSize.set(page.id, { width: viewport.width, height: viewport.height });

            // Feste, zoomunabhängige Anzeigegröße (siehe renderBlankTemplatePage).
            canvas.style.width = `${viewport.width}px`;
            canvas.style.height = `${viewport.height}px`;
            this.pageLogicalSize.set(page.id, { width: viewport.width, height: viewport.height });

            const effectiveScale = DEFAULT_RENDER_SCALE;
            this.ui.createOverlay(wrapper, page.id, viewport, effectiveScale);

            this.pageScales.set(page.id, effectiveScale);

            const rawWidth = viewport.width / DEFAULT_RENDER_SCALE;
            const rawHeight = viewport.height / DEFAULT_RENDER_SCALE;

            // Textmarker-Ebene: über dem Hintergrund, aber unter Textblöcken,
            // PDF-Textebene und normaler Annotations-Ebene.
            this.ui.createConnectorLayer(page.id, wrapper);
            this.ui.createHighlightLayer(page.id, wrapper, rawWidth, rawHeight);
            this.ui.setHighlightLayerBlendMode(page.id, this.isPageInverted(page));
            this.ui.setHighlightLayerBlendMode(page.id, this.isPageInverted(page));
            this.ui.setConnectorLayerBlendMode(page.id, this.isPageInverted(page));
            this.drawPdfAnnotationHighlights(page.id);

            this.ui.createTextBlockLayer(wrapper, page.id);
            await this.renderTextBlocksForPage(page.id, effectiveScale);

            try {
                const links = await this.renderer.getPageLinkAnnotations(sourcePath, page.srcPage, page.rotate ?? 0);
                this.ui.renderLinkLayer(links, wrapper, effectiveScale, (targetPageNumber) => {
                    void this.jumpToSourcePage(page.src, targetPageNumber);
                });
            } catch (e) { /* ignore */ }

            try {
                const textItems = await this.renderer.getPageTextItems(sourcePath, page.srcPage, page.rotate ?? 0);
                this.ui.renderTextLayer(textItems, wrapper, effectiveScale);
                this.attachTextSelectionContextMenu(page.id, wrapper, effectiveScale);
                this.attachTouchTextSelection(page.id, wrapper, effectiveScale);
            } catch (e) {
                // Textextraktion optional – Fehler ignorieren
            }

            this.ui.renderAnnotationLayer(
                page.id, wrapper, rawWidth, rawHeight, doc,
                this.currentTool,
                (evt, svg, id) => this.onAnnotationPointerDown(evt, svg, id),
                (evt, svg, id) => this.onAnnotationPointerMove(evt, svg, id),
                (evt, svg, id) => this.onAnnotationPointerUp(evt, svg, id)
            );

            this.attachPageDoubleClickHandler(page.id, wrapper);

            this.ui.createAnnotationColumn(page.id, body);
            await this.renderPdfAnnotationsForPage(page.id, effectiveScale);
        } catch (error) {
            container.createDiv({ cls: "pdfcompose-error", text: `Konnte Seite "${page.id}" nicht rendern: ${String(error)}` });
        }
    }

    private attachTouchTextSelection(pageId: string, wrapper: HTMLElement, scale: number): void {
        const textLayer = wrapper.querySelector<HTMLElement>(".pdfcompose-text-layer");
        if (!textLayer) return;

        // Native Touch-/Stift-Auswahl unterdrücken (Maus bleibt nativ)
        textLayer.addEventListener("selectstart", (e) => {
            if (this.lastPointerType !== "mouse") e.preventDefault();
        });
        textLayer.addEventListener("contextmenu", (e) => {
            if (this.lastPointerType !== "mouse") e.preventDefault();
        });

        // Stift darf nicht scrollen, Finger schon: touch-action wird vor dem Aufsetzen gesetzt.
        textLayer.addEventListener("pointerover", (e: PointerEvent) => {
            this.lastPointerType = e.pointerType;
            textLayer.style.touchAction = e.pointerType === "pen" ? "none" : "";
        });

        const clearTimer = () => {
            if (this.selectionChangeTimer !== null) {
                window.clearTimeout(this.selectionChangeTimer);
                this.selectionChangeTimer = null;
            }
        };
        let pending: { id: number; x: number; y: number } | null = null;

        textLayer.addEventListener("pointerdown", (e: PointerEvent) => {
            this.lastPointerType = e.pointerType;
            if (e.pointerType === "mouse" || this.currentTool !== "none") return;
            if (this.activeTouchPointers.size >= 2) return; // Pinch-Zoom

            if (e.pointerType === "pen") {
                this.startPenTextSelection(e, pageId, wrapper, textLayer, scale);
                return;
            }

            // Finger: Long-Press markiert das Wort unter dem Finger
            pending = { id: e.pointerId, x: e.clientX, y: e.clientY };
            clearTimer();
            this.selectionChangeTimer = window.setTimeout(() => {
                this.selectionChangeTimer = null;
                if (!pending) return;
                const pos = this.caretFromPoint(pending.x, pending.y);
                pending = null;
                if (!pos || !textLayer.contains(pos.node)) return;
                const wordRange = this.wordRangeAt(pos);
                if (!wordRange) return;
                this.openTextSelectionSession(pageId, wrapper, textLayer, wordRange, scale);
                if (navigator.vibrate) navigator.vibrate(10);
            }, 450);
        });

        textLayer.addEventListener("pointermove", (e: PointerEvent) => {
            if (!pending || e.pointerId !== pending.id) return;
            if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > 10) {
                pending = null;
                clearTimer(); // der Finger scrollt -> keine Markierung
            }
        });
        const cancelPending = () => { pending = null; clearTimer(); };
        textLayer.addEventListener("pointerup", cancelPending);
        textLayer.addEventListener("pointercancel", cancelPending);
    }

    /** Wortgrenzen um eine Textposition (Buchstaben/Ziffern). */
    private wordRangeAt(pos: { node: Node; offset: number }): Range | null {
        if (pos.node.nodeType !== Node.TEXT_NODE) return null;
        const text = pos.node.textContent ?? "";
        const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
        let i = Math.min(pos.offset, text.length);
        if (isWord(text[i])) { /* i passt */ }
        else if (i > 0 && isWord(text[i - 1])) i--;
        else return null;

        let a = i, b = i + 1;
        while (a > 0 && isWord(text[a - 1])) a--;
        while (b < text.length && isWord(text[b])) b++;

        const range = document.createRange();
        range.setStart(pos.node, a);
        range.setEnd(pos.node, b);
        return range;
    }

    /** Stift: sofortiges Aufziehen einer Textauswahl. Reines Antippen hebt die Auswahl auf. */
    private startPenTextSelection(evt: PointerEvent, pageId: string, wrapper: HTMLElement, textLayer: HTMLElement, scale: number): void {
        const anchor = this.caretFromPoint(evt.clientX, evt.clientY);
        if (!anchor || !textLayer.contains(anchor.node)) return;
        evt.preventDefault();
        this.endRangeSession();
        this.paintSelectionOverlay(wrapper, textLayer, null);

        const pointerId = evt.pointerId;
        try { textLayer.setPointerCapture(pointerId); } catch { /* ignore */ }

        const tmp = document.createRange();
        tmp.setStart(anchor.node, anchor.offset);
        tmp.collapse(true);

        let current: Range | null = null;
        const onMove = (ev: PointerEvent) => {
            if (ev.pointerId !== pointerId) return;
            ev.preventDefault();
            const p = this.caretFromPoint(ev.clientX, ev.clientY);
            if (!p || !textLayer.contains(p.node)) return;
            const r = document.createRange();
            try {
                if (tmp.comparePoint(p.node, p.offset) < 0) {
                    r.setStart(p.node, p.offset);
                    r.setEnd(anchor.node, anchor.offset);
                } else {
                    r.setStart(anchor.node, anchor.offset);
                    r.setEnd(p.node, p.offset);
                }
            } catch { return; }
            current = r;
            this.paintSelectionOverlay(wrapper, textLayer, r);
        };
        const onUp = (ev: PointerEvent) => {
            if (ev.pointerId !== pointerId) return;
            textLayer.removeEventListener("pointermove", onMove);
            textLayer.removeEventListener("pointerup", onUp);
            textLayer.removeEventListener("pointercancel", onUp);
            try { textLayer.releasePointerCapture(pointerId); } catch { /* ignore */ }
            if (current && !current.collapsed) {
                this.openTextSelectionSession(pageId, wrapper, textLayer, current, scale);
            } else {
                this.paintSelectionOverlay(wrapper, textLayer, null);
            }
        };
        textLayer.addEventListener("pointermove", onMove);
        textLayer.addEventListener("pointerup", onUp);
        textLayer.addEventListener("pointercancel", onUp);
    }

    /** Zeigt Griffe + Aktionsleiste für eine (noch nicht gespeicherte) Textauswahl. */
    private openTextSelectionSession(pageId: string, wrapper: HTMLElement, textLayer: HTMLElement, range: Range, scale: number): void {
        // Reihenfolge wichtig: beginRangeSession() räumt eine alte Sitzung samt Auswahl-Fläche ab.
        this.beginRangeSession({
            kind: "selection",
            pageId, wrapper, textLayer, range,
            color: "#4c8dff",
            onRangeChange: (r) => this.paintSelectionOverlay(wrapper, textLayer, r),
            onCommit: () => { this.layoutRangeSession(); },
            actions: [
                {
                    label: "Annotate",
                    onClick: () => {
                        const s = this.rangeSession;
                        if (!s) return;
                        const rects = this.rangeToPageRects(s.range, s.wrapper, s.textLayer, scale);
                        this.endRangeSession();
                        if (rects.length > 0) void this.createPdfAnnotationFromSelection(pageId, rects);
                    },
                },
                {
                    label: "Copy",
                    onClick: () => {
                        const s = this.rangeSession;
                        if (!s) return;
                        void navigator.clipboard.writeText(s.range.toString());
                        this.endRangeSession();
                        new Notice("Copied.");
                    },
                },
            ],
        });
        this.paintSelectionOverlay(wrapper, textLayer, range);
    }

    /**
 * Wendet – falls nötig – eine Helligkeits-Invertierung (CSS-Filter)
 * auf die Canvas einer PDF-Seite an. Eingebettete Bilder werden über
 * eine zweite, unveränderte Overlay-Canvas ausgenommen.
 */
    private async applyColorModeToPageCanvas(
        page: PdfPageDefinition,
        wrapper: HTMLElement,
        canvas: HTMLCanvasElement,
        sourcePath: string,
        effectiveScale: number,
        logicalWidth: number,
        logicalHeight: number,
    ): Promise<void> {
        wrapper.querySelector(".pdfcompose-image-protect-canvas")?.remove();

        const filter = this.buildPageFilter(page);
        canvas.style.filter = filter;
        if (!filter.includes("invert(1)")) return;

        void this.renderer.getImageRegions(sourcePath, page.srcPage).then((regions) => {
            if (regions.length === 0 || !wrapper.isConnected || !canvas.isConnected) return;
            wrapper.querySelector(".pdfcompose-image-protect-canvas")?.remove();

            const protectCanvas = document.createElement("canvas");
            protectCanvas.className = "pdfcompose-image-protect-canvas";
            protectCanvas.width = canvas.width;
            protectCanvas.height = canvas.height;
            protectCanvas.style.position = "absolute";
            protectCanvas.style.top = "0";
            protectCanvas.style.left = "0";
            protectCanvas.style.width = `${logicalWidth}px`;
            protectCanvas.style.height = `${logicalHeight}px`;
            protectCanvas.style.pointerEvents = "none";

            const ctx = protectCanvas.getContext("2d");
            if (!ctx) return;
            for (const region of regions) {
                const sx = region.x * effectiveScale;
                const sy = region.y * effectiveScale;
                const sw = region.width * effectiveScale;
                const sh = region.height * effectiveScale;
                if (sw <= 0 || sh <= 0) continue;
                ctx.drawImage(canvas, sx, sy, sw, sh, sx, sy, sw, sh);
            }
            wrapper.appendChild(protectCanvas);
        }).catch(() => { /* Bilder bleiben invertiert */ });
    }

    private buildPageFilter(page: PageDefinition): string {
        const invert = this.isPageInverted(page);
        const colorMode = this.colorMode;
        const applyInLight = this.plugin.settings.applyFiltersInLightMode ?? false;
        const applyInDark = this.plugin.settings.applyFiltersInDarkMode ?? true;
        const isDark = colorMode === 'dark';

        // Prüfen, ob zusätzliche Filter (Slider, Helligkeit/Kontrast) angewendet werden sollen
        const applyFilters = (isDark && applyInDark) || (!isDark && applyInLight);

        // Einstellungen einlesen
        const monochrome = this.plugin.settings.darkModeMonochromeColor;
        const whiteDim = this.plugin.settings.darkModeWhiteDim ?? 0;
        const blackLighten = this.plugin.settings.darkModeBlackLighten ?? 0;
        const userHueRotate = this.plugin.settings.darkModeHueRotate ?? 0;

        const contrast = Math.max(0.5, 1 - whiteDim / 200);
        const brightness = Math.min(1.5, 1 + blackLighten / 200);

        // --- 1. Basis: Invertierung (falls nötig) ---
        let filter = '';
        if (invert) {
            // Helligkeit umkehren + Farben originalgetreu machen
            filter += 'invert(1) hue-rotate(180deg)';
        }

        // --- 2. Monochrom-Tönung (optional) ---
        if (monochrome) {
            const hue = this.hexToHueDegrees(monochrome);
            // Monochrom-Filter: entferne alle Farbsättigung und färbe ein
            // Wenn invertiert, kommt das zusätzlich zur Invertierung hinzu
            // Wenn nicht invertiert, wird nur die Tönung angewandt
            filter += ` grayscale(1) sepia(1) hue-rotate(${hue}deg) saturate(4)`;
        } else {
            // --- 3. Optionale Zusatzfilter (nur wenn applyFilters aktiv) ---
            if (applyFilters) {
                // Benutzerdefinierte Farbtonverschiebung (zusätzlich zur 180°-Korrektur, falls invertiert)
                if (userHueRotate !== 0) {
                    filter += ` hue-rotate(${userHueRotate}deg)`;
                }

                // Helligkeit / Kontrast
                if (contrast !== 1 || brightness !== 1) {
                    filter += ` brightness(${brightness}) contrast(${contrast})`;
                }
            }
        }

        return filter.trim();
    }

    /** Wandelt eine Hex-Farbe (#rrggbb) in ihren Farbton (0–360°, HSL) um. */
    private hexToHueDegrees(hex: string): number {
        const clean = hex.replace("#", "");
        if (clean.length < 6) return 0;
        const r = parseInt(clean.substring(0, 2), 16) / 255;
        const g = parseInt(clean.substring(2, 4), 16) / 255;
        const b = parseInt(clean.substring(4, 6), 16) / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const d = max - min;
        if (d === 0) return 0;
        let h = 0;
        switch (max) {
            case r: h = ((g - b) / d) % 6; break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
        if (h < 0) h += 360;
        return h;
    }

    // ============================================================
    //  PDF-ANMERKUNGEN (Textmarkierung + Box rechts der Seite)
    // ============================================================

    private drawPdfAnnotationHighlights(pageId: string): void {
        const entries = this.pdfAnnotationsCache.get(pageId) ?? [];
        const page = this.getPageDefinition(pageId);
        const invert = page ? this.isPageInverted(page) : false;
        const displayEntries = invert
            ? entries.map(e => ({ ...e, color: this.getDisplayColorForPage(pageId, e.color) }))
            : entries;
        this.ui.drawPdfAnnotationHighlights(pageId, displayEntries);
    }

    private pickNextAnnotationColor(pageId: string): string {
        const used = new Set((this.pdfAnnotationsCache.get(pageId) ?? []).map((e) => e.color));
        const palette = PdfComposeView.ANNOTATION_COLOR_PALETTE;
        for (const c of palette) {
            if (!used.has(c)) return c;
        }
        return palette[used.size % palette.length];
    }

    /**
     * Öffnet ein Obsidian-Kontextmenü bei Rechtsklick auf ausgewählten PDF-Text:
     * "Kopieren" (Standardverhalten) + "Anmerkung erstellen". Funktioniert nur
     * bei aktivem Zeiger-Werkzeug, da sonst die (im DOM darüberliegende)
     * Annotations-Ebene mit pointer-events:auto den Rechtsklick abfängt.
     */
    private attachTextSelectionContextMenu(pageId: string, wrapper: HTMLElement, scale: number): void {
        const textLayer = wrapper.querySelector(".pdfcompose-text-layer") as HTMLElement | null;
        if (!textLayer) return;

        textLayer.addEventListener("contextmenu", (evt: MouseEvent) => {
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
            const range = selection.getRangeAt(0);
            if (!textLayer.contains(range.commonAncestorContainer)) return;

            const selectedText = selection.toString();
            const rects = this.selectionRangeToPageRects(range, wrapper, scale);
            if (selectedText.trim().length === 0) return;

            evt.preventDefault();

            const menu = new Menu();
            menu.addItem((item) =>
                item.setTitle("Kopieren").setIcon("copy").onClick(async () => {
                    await navigator.clipboard.writeText(selectedText);
                })
            );
            if (rects.length > 0) {
                menu.addItem((item) =>
                    item.setTitle("Anmerkung erstellen").setIcon("message-square-plus").onClick(() => {
                        void this.createPdfAnnotationFromSelection(pageId, rects);
                    })
                );
            }
            menu.showAtMouseEvent(evt);
        });
    }

    private selectionRangeToPageRects(range: Range, wrapper: HTMLElement, scale: number): PdfAnnotationRect[] {
        const textLayer = wrapper.querySelector<HTMLElement>(".pdfcompose-text-layer");
        if (!textLayer) return [];
        return this.rangeToPageRects(range, wrapper, textLayer, scale);
    }

    /** Blaue Markierungsfläche für die (noch nicht als Anmerkung gespeicherte) Textauswahl. range = null entfernt sie. */
    private paintSelectionOverlay(wrapper: HTMLElement, textLayer: HTMLElement, range: Range | null): void {
        let overlay = wrapper.querySelector<HTMLElement>(":scope > .pdfcompose-text-selection-overlay");
        if (!range) { overlay?.remove(); return; }
        if (!overlay) {
            overlay = wrapper.createDiv({ cls: "pdfcompose-text-selection-overlay" });
            Object.assign(overlay.style, {
                position: "absolute", top: "0", left: "0", right: "0", bottom: "0",
                pointerEvents: "none", zIndex: "24",
            });
        }
        overlay.empty();
        const wr = wrapper.getBoundingClientRect();
        const z = this.zoomLevel;
        for (const r of this.rangeLineRects(range, textLayer)) {
            const d = overlay.createDiv();
            Object.assign(d.style, {
                position: "absolute",
                left: `${(r.left - wr.left) / z}px`,
                top: `${(r.top - wr.top) / z}px`,
                width: `${r.width / z}px`,
                height: `${r.height / z}px`,
                background: "rgba(80, 140, 255, 0.35)",
            });
        }
    }

    private async createPdfAnnotationFromSelection(pageId: string, rects: PdfAnnotationRect[]): Promise<void> {
        const bboxMinY = Math.min(...rects.map((r) => r.y));
        const color = this.pickNextAnnotationColor(pageId);

        const entry: PdfAnnotationEntry = {
            id: crypto.randomUUID(),
            pageId,
            color,
            rects,
            y: bboxMinY,
            width: 220,
            connector: "curve",
            fontScale: 100,
            markdown: "",
        };

        // Wird erst im Dateisystem gespeichert, wenn im Modal auf "Speichern"
        // geklickt wird (analog zum Textblock-Erstellungsfluss).
        const list = this.pdfAnnotationsCache.get(pageId) ?? [];
        list.push(entry);
        this.pdfAnnotationsCache.set(pageId, list);

        this.drawPdfAnnotationHighlights(pageId);
        await this.renderPdfAnnotationsForPage(pageId, this.getEffectiveScaleForPage(pageId));
        this.openPdfAnnotationEditor(entry, true);
    }

    private async renderPdfAnnotationsForPage(pageId: string, scale: number): Promise<void> {
        const column = this.ui.annotationColumns.get(pageId);
        if (!column || !this.currentFile) return;

        column.querySelectorAll("[data-pdfannot-id]").forEach((el) => {
            const id = el.getAttribute("data-pdfannot-id");
            if (id) {
                this.pdfAnnotationComponents.get(id)?.unload();
                this.pdfAnnotationComponents.delete(id);
            }
        });
        column.empty();

        const entries = this.pdfAnnotationsCache.get(pageId) ?? [];

        // Verbindungslinien gelöschter Anmerkungen entfernen
        this.ui.pruneConnectors(pageId, new Set(entries.map(e => e.id)));

        if (entries.length === 0) {
            column.style.display = "none";
            return;
        }
        column.style.display = "";

        const page = this.getPageDefinition(pageId);
        const invert = page ? this.isPageInverted(page) : false;

        let maxWidth = 220;
        for (const entry of entries) maxWidth = Math.max(maxWidth, entry.width);
        column.style.width = ((maxWidth + 20) * scale) + "px";

        for (const entry of entries) {
            const comp = new Component();
            comp.load();
            this.pdfAnnotationComponents.set(entry.id, comp);
            const displayColor = this.getDisplayColorForPage(pageId, entry.color);
            await this.ui.renderPdfAnnotationBox(column, entry, scale, comp, this.currentFile.path, displayColor, invert, {
                onEdit: (e) => this.openPdfAnnotationEditor(e),
                onVerticalDrag: (evt, e) => this.startPdfAnnotationVerticalDrag(evt, e, pageId, scale),
                onWidthDrag: (evt, e) => this.startPdfAnnotationWidthDrag(evt, e, pageId, scale),
            });
        }

        requestAnimationFrame(() => {
            for (const entry of entries) {
                this.ui.updateConnector(pageId, entry);
            }
        });
    }

    private getPageWrapper(pageId: string): HTMLElement | null {
        return this.ui.pagesContentEl.querySelector<HTMLElement>(
            `[data-page-id="${pageId}"] .pdfcompose-page-wrapper`);
    }

    private caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
        const d: any = document;
        if (typeof d.caretPositionFromPoint === "function") {
            const p = d.caretPositionFromPoint(x, y);
            return p ? { node: p.offsetNode, offset: p.offset } : null;
        }
        if (typeof d.caretRangeFromPoint === "function") {
            const r = d.caretRangeFromPoint(x, y);
            return r ? { node: r.startContainer, offset: r.startOffset } : null;
        }
        return null;
    }

    private beginRangeSession(opts: {
        kind: "annotation" | "selection";
        pageId: string;
        wrapper: HTMLElement;
        textLayer: HTMLElement;
        range: Range;
        color: string;
        onRangeChange: (range: Range) => void;
        onCommit: () => void | Promise<void>;
        actions?: { label: string; onClick: () => void }[];
    }): void {
        this.endRangeSession();

        const makeHandle = (kind: "start" | "end"): HTMLElement => {
            const size = Platform.isMobile ? 24 : 16;
            const h = opts.wrapper.createDiv({ cls: "pdfcompose-range-handle" });
            Object.assign(h.style, {
                position: "absolute", width: `${size}px`, height: `${size}px`, borderRadius: "50%",
                background: opts.color, border: "2px solid #ffffff", boxShadow: "0 0 3px rgba(0,0,0,0.7)",
                zIndex: "60", touchAction: "none", cursor: "col-resize",
                transform: "translate(-50%, -50%)", pointerEvents: "auto",
            });
            h.addEventListener("pointerdown", (e) => this.startRangeHandleDrag(e as PointerEvent, kind));
            return h;
        };

        let toolbar: HTMLElement | null = null;
        if (opts.actions && opts.actions.length > 0) {
            toolbar = document.body.createDiv({ cls: "pdfcompose-selection-toolbar" });
            Object.assign(toolbar.style, {
                position: "fixed", zIndex: "10000", display: "flex", gap: "6px", padding: "6px",
                background: "var(--background-primary)", border: "1px solid var(--background-modifier-border)",
                borderRadius: "8px", boxShadow: "var(--shadow-s)",
            });
            toolbar.addEventListener("pointerdown", (e) => {
                this.rangeToolbarTouchedAt = Date.now();
                e.preventDefault();
            });
            for (const action of opts.actions) {
                toolbar.createEl("button", { text: action.label })
                    .addEventListener("click", () => action.onClick());
            }
        }

        this.rangeSession = {
            kind: opts.kind,
            pageId: opts.pageId,
            wrapper: opts.wrapper,
            textLayer: opts.textLayer,
            range: opts.range,
            startHandle: makeHandle("start"),
            endHandle: makeHandle("end"),
            toolbar,
            dragging: false,
            onRangeChange: opts.onRangeChange,
            onCommit: opts.onCommit,
        };
        this.layoutRangeSession();
    }

    private endRangeSession(): void {
        const s = this.rangeSession;
        if (!s) return;
        this.rangeSession = null;
        s.startHandle.remove();
        s.endHandle.remove();
        s.toolbar?.remove();
        s.wrapper.querySelector(":scope > .pdfcompose-text-selection-overlay")?.remove();
    }

    /** Textposition an einem Punkt der Seite (PDF-Punkte). Scrollt den Punkt bei Bedarf zuerst in den sichtbaren Bereich. */
    private async caretAtPagePoint(wrapper: HTMLElement, x: number, y: number, scale: number): Promise<{ node: Node; offset: number } | null> {
        const container = this.ui.pagesContainerEl;
        const k = scale * this.zoomLevel;
        const locate = () => {
            const wr = wrapper.getBoundingClientRect();
            return { px: wr.left + x * k, py: wr.top + y * k };
        };
        let { px, py } = locate();
        const cr = container.getBoundingClientRect();
        const margin = 120; // Abstand zur Werkzeugleiste/den Rändern
        if (px < cr.left + margin || px > cr.right - margin) container.scrollLeft += px - (cr.left + cr.width / 2);
        if (py < cr.top + margin || py > cr.bottom - margin) container.scrollTop += py - (cr.top + cr.height / 2);
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        ({ px, py } = locate());
        return this.caretFromPoint(px, py);
    }

    private async beginAnnotationRangeEdit(pageId: string, annotId: string): Promise<void> {
        const find = () => (this.pdfAnnotationsCache.get(pageId) ?? []).find(e => e.id === annotId);
        const entry = find();
        if (!entry || entry.rects.length === 0) return;

        // Zeiger-Werkzeug: sonst blockiert die Annotations-Ebene die Text-Treffersuche
        await this.setActiveTool("none");
        await this.forceMountPage(pageId);

        const wrapper = this.getPageWrapper(pageId);
        const textLayer = wrapper?.querySelector<HTMLElement>(".pdfcompose-text-layer") ?? null;
        if (!wrapper || !textLayer) {
            new Notice("This page has no text layer.");
            return;
        }
        const scale = this.getEffectiveScaleForPage(pageId);

        const first = entry.rects[0];
        const last = entry.rects[entry.rects.length - 1];
        const startPos = await this.caretAtPagePoint(wrapper, first.x + 0.5, first.y + first.height / 2, scale);
        const endPos = await this.caretAtPagePoint(wrapper, last.x + last.width - 0.5, last.y + last.height / 2, scale);
        if (!startPos || !endPos || !textLayer.contains(startPos.node) || !textLayer.contains(endPos.node)) {
            new Notice("Could not determine the marked text.");
            return;
        }
        const range = document.createRange();
        try {
            range.setStart(startPos.node, startPos.offset);
            range.setEnd(endPos.node, endPos.offset);
        } catch {
            return;
        }
        if (range.collapsed) return;

        const clone = (a: PdfAnnotationEntry): PdfAnnotationEntry => ({ ...a, rects: a.rects.map(r => ({ ...r })) });
        let baseline = clone(entry);

        this.beginRangeSession({
            kind: "annotation",
            pageId, wrapper, textLayer, range,
            color: entry.color,
            onRangeChange: (r) => {
                const rects = this.rangeToPageRects(r, wrapper, textLayer, scale);
                const live = find();
                if (!live || rects.length === 0) return;
                live.rects = rects;
                this.drawPdfAnnotationHighlights(pageId);
                this.ui.updateConnector(pageId, live);
            },
            onCommit: async () => {
                const live = find();
                if (!live) return;
                if (JSON.stringify(live.rects) === JSON.stringify(baseline.rects)) return;
                const prior = baseline;
                baseline = clone(live);
                await this.commitPdfAnnotationChange(live, prior);
                this.layoutRangeSession();
            },
        });
        new Notice("Drag the handles to adjust the range. Esc or tap outside to finish.");
    }

    private layoutRangeSession(): void {
        const s = this.rangeSession;
        if (!s) return;
        const rects = this.rangeLineRects(s.range, s.textLayer);
        if (rects.length === 0) return;
        const first = rects[0], last = rects[rects.length - 1];
        const wr = s.wrapper.getBoundingClientRect();
        const z = this.zoomLevel;
        s.startHandle.style.left = `${(first.left - wr.left) / z}px`;
        s.startHandle.style.top = `${(first.top - wr.top) / z}px`;
        s.endHandle.style.left = `${(last.right - wr.left) / z}px`;
        s.endHandle.style.top = `${(last.bottom - wr.top) / z}px`;

        if (s.toolbar) {
            const w = s.toolbar.offsetWidth || 160;
            s.toolbar.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, first.left))}px`;
            s.toolbar.style.top = `${Math.max(8, first.top - 52)}px`;
        }
    }

    /** Zeilenrechtecke NUR der tatsächlich markierten Textknoten (ohne Element-Kästen). */
    private rangeLineRects(range: Range, textLayer: HTMLElement): DOMRect[] {
        const startNode = range.startContainer;
        const endNode = range.endContainer;
        if (startNode.nodeType !== Node.TEXT_NODE || endNode.nodeType !== Node.TEXT_NODE) {
            return Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
        }
        const out: DOMRect[] = [];
        const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
        walker.currentNode = startNode;
        let node: Node | null = startNode;
        while (node) {
            const r = document.createRange();
            r.selectNodeContents(node);
            if (node === startNode) r.setStart(node, range.startOffset);
            if (node === endNode) r.setEnd(node, range.endOffset);
            for (const rect of Array.from(r.getClientRects())) {
                if (rect.width > 0 && rect.height > 0) out.push(rect);
            }
            if (node === endNode) break;
            node = walker.nextNode();
        }
        return out;
    }

    /** Range -> Seiten-Rechtecke (PDF-Punkte), Rechtecke derselben Zeile werden zusammengeführt. */
    private rangeToPageRects(range: Range, wrapper: HTMLElement, textLayer: HTMLElement, scale: number): PdfAnnotationRect[] {
        const wr = wrapper.getBoundingClientRect();
        const k = scale * this.zoomLevel;
        const round = (v: number) => Math.round(v * 100) / 100;
        const merged: PdfAnnotationRect[] = [];
        for (const r of this.rangeLineRects(range, textLayer)) {
            const rect = {
                x: (r.left - wr.left) / k,
                y: (r.top - wr.top) / k,
                width: r.width / k,
                height: r.height / k,
            };
            const last = merged[merged.length - 1];
            if (last
                && Math.abs(last.y - rect.y) < 2
                && Math.abs(last.height - rect.height) < 2
                && rect.x - (last.x + last.width) < 3
                && rect.x >= last.x - 0.5) {
                last.width = Math.max(last.x + last.width, rect.x + rect.width) - last.x;
            } else {
                merged.push(rect);
            }
        }
        return merged.map(r => ({ x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) }));
    }

    private startRangeHandleDrag(evt: PointerEvent, kind: "start" | "end"): void {
        const s = this.rangeSession;
        if (!s) return;
        evt.preventDefault();
        evt.stopPropagation();

        const rects = this.rangeLineRects(s.range, s.textLayer);
        if (rects.length === 0) return;
        const first = rects[0], last = rects[rects.length - 1];
        // Abtastpunkt = Zeilenmitte am Ende, der Griff sitzt an der Ecke -> konstanten Versatz merken
        const ref = kind === "start"
            ? { x: first.left + 1, y: first.top + first.height / 2 }
            : { x: last.right - 1, y: last.bottom - last.height / 2 };
        const hr = (kind === "start" ? s.startHandle : s.endHandle).getBoundingClientRect();
        const dx = ref.x - (hr.left + hr.width / 2);
        const dy = ref.y - (hr.top + hr.height / 2);

        s.dragging = true;
        s.startHandle.style.pointerEvents = "none";
        s.endHandle.style.pointerEvents = "none";
        if (s.toolbar) s.toolbar.style.visibility = "hidden";

        let startPos = { node: s.range.startContainer, offset: s.range.startOffset };
        let endPos = { node: s.range.endContainer, offset: s.range.endOffset };

        const onMove = (ev: PointerEvent) => {
            if (ev.pointerId !== evt.pointerId) return;
            ev.preventDefault();
            const pos = this.caretFromPoint(ev.clientX + dx, ev.clientY + dy);
            if (!pos || !s.textLayer.contains(pos.node)) return;
            const a = kind === "start" ? pos : startPos;
            const b = kind === "end" ? pos : endPos;
            const next = document.createRange();
            try {
                next.setStart(a.node, a.offset);
                next.setEnd(b.node, b.offset);
            } catch { return; }
            if (next.collapsed) return;
            if (kind === "start") startPos = pos; else endPos = pos;
            s.range = next;
            s.onRangeChange(next);
            this.layoutRangeSession();
        };

        const onUp = async (ev: PointerEvent) => {
            if (ev.pointerId !== evt.pointerId) return;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
            const session = this.rangeSession;
            if (!session) return;
            session.dragging = false;
            session.startHandle.style.pointerEvents = "auto";
            session.endHandle.style.pointerEvents = "auto";
            if (session.toolbar) session.toolbar.style.visibility = "";
            this.layoutRangeSession();
            await session.onCommit();
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    }

    private startPdfAnnotationVerticalDrag(evt: PointerEvent, entry: PdfAnnotationEntry, pageId: string, scale: number): void {
        evt.preventDefault();
        const handleEl = evt.currentTarget as HTMLElement;
        const pointerId = evt.pointerId;
        try { handleEl.setPointerCapture(pointerId); } catch { /* ignore */ }

        const startY = evt.clientY;
        const originY = entry.y;
        const priorEntry: PdfAnnotationEntry = { ...entry };
        const boxEl = handleEl.closest(".pdfcompose-pdfannot") as HTMLElement | null;

        const onMove = (ev: PointerEvent) => {
            ev.preventDefault();
            const dy = (ev.clientY - startY) / (scale * this.zoomLevel);
            entry.y = Math.max(0, originY + dy);
            if (boxEl) boxEl.style.top = (entry.y * scale) + "px";
            this.ui.updateConnector(pageId, entry);
        };
        const onUp = async () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            if (handleEl.hasPointerCapture(pointerId)) {
                try { handleEl.releasePointerCapture(pointerId); } catch { /* ignore */ }
            }
            if (entry.y === priorEntry.y) return;
            await this.commitPdfAnnotationChange(entry, priorEntry);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }

    private startPdfAnnotationWidthDrag(evt: PointerEvent, entry: PdfAnnotationEntry, pageId: string, scale: number): void {
        evt.preventDefault();
        const handleEl = evt.currentTarget as HTMLElement;
        const pointerId = evt.pointerId;
        try { handleEl.setPointerCapture(pointerId); } catch { /* ignore */ }

        const startX = evt.clientX;
        const originWidth = entry.width;
        const priorEntry: PdfAnnotationEntry = { ...entry };
        const zoomFactor = (entry.fontScale || 100) / 100;
        const boxEl = handleEl.closest(".pdfcompose-pdfannot") as HTMLElement | null;
        const innerEl = boxEl?.querySelector(".pdfcompose-textblock-inner") as HTMLElement | null;

        const onMove = (ev: PointerEvent) => {
            ev.preventDefault();
            const dx = (ev.clientX - startX) / scale;
            entry.width = Math.max(80, originWidth + dx);
            if (boxEl) boxEl.style.width = (entry.width * scale) + "px";
            if (innerEl) innerEl.style.width = ((entry.width * scale) / zoomFactor) + "px";
            this.ui.updateConnector(pageId, entry);
        };
        const onUp = async () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            if (handleEl.hasPointerCapture(pointerId)) {
                try { handleEl.releasePointerCapture(pointerId); } catch { /* ignore */ }
            }
            if (entry.width === priorEntry.width) return;
            await this.commitPdfAnnotationChange(entry, priorEntry);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }

    private async commitPdfAnnotationChange(entry: PdfAnnotationEntry, prior: PdfAnnotationEntry): Promise<void> {
        const after: PdfAnnotationEntry = { ...entry };
        await this.savePdfAnnotationRaw(entry);
        this.pushUndo({
            label: "pdf-annotation-transform",
            undo: async () => { await this.savePdfAnnotationRaw(prior); },
            redo: async () => { await this.savePdfAnnotationRaw(after); },
        });
    }

    private async savePdfAnnotationRaw(entry: PdfAnnotationEntry): Promise<void> {
        await this.updateFileAtomic(
            (fm) => {
                if (!fm.pdfAnnotations) fm.pdfAnnotations = [];
                const idx = fm.pdfAnnotations.findIndex((a: any) => a.id === entry.id);
                const meta = {
                    id: entry.id,
                    pageId: entry.pageId,
                    color: entry.color,
                    rects: entry.rects,
                    y: entry.y,
                    width: entry.width,
                    connector: entry.connector,
                    fontScale: entry.fontScale,
                };
                if (idx === -1) fm.pdfAnnotations.push(meta);
                else fm.pdfAnnotations[idx] = meta;
            },
            (body) => upsertPdfAnnotation(body, entry)
        );
        // Cache aktualisieren
        const list = this.pdfAnnotationsCache.get(entry.pageId) || [];
        const idx = list.findIndex(a => a.id === entry.id);
        if (idx === -1) list.push(entry);
        else list[idx] = entry;
        this.pdfAnnotationsCache.set(entry.pageId, list);
        this.drawPdfAnnotationHighlights(entry.pageId);
        await this.renderPdfAnnotationsForPage(entry.pageId, this.getEffectiveScaleForPage(entry.pageId));
    }

    private async savePdfAnnotation(entry: PdfAnnotationEntry): Promise<void> {
        const list = this.pdfAnnotationsCache.get(entry.pageId) ?? [];
        const idx = list.findIndex((e) => e.id === entry.id);
        const prior: PdfAnnotationEntry | null = idx === -1 ? null : { ...list[idx] };

        await this.savePdfAnnotationRaw(entry);

        this.pushUndo({
            label: "save-pdf-annotation",
            undo: async () => {
                if (prior) await this.savePdfAnnotationRaw(prior);
                else await this.deletePdfAnnotationRaw(entry);
            },
            redo: async () => { await this.savePdfAnnotationRaw(entry); },
        });
    }

    private async deletePdfAnnotationRaw(entry: PdfAnnotationEntry): Promise<void> {
        await this.updateFileAtomic(
            (fm) => {
                if (fm.pdfAnnotations) {
                    fm.pdfAnnotations = fm.pdfAnnotations.filter((a: any) => a.id !== entry.id);
                }
            },
            (body) => removePdfAnnotation(body, entry.id)
        );
        // Cache aktualisieren
        const list = (this.pdfAnnotationsCache.get(entry.pageId) || []).filter(a => a.id !== entry.id);
        this.pdfAnnotationsCache.set(entry.pageId, list);
        this.drawPdfAnnotationHighlights(entry.pageId);
        await this.renderPdfAnnotationsForPage(entry.pageId, this.getEffectiveScaleForPage(entry.pageId));
    }

    private async deletePdfAnnotation(entry: PdfAnnotationEntry): Promise<void> {
        const list = this.pdfAnnotationsCache.get(entry.pageId) ?? [];
        const existing = list.find((e) => e.id === entry.id) ?? entry;

        await this.deletePdfAnnotationRaw(entry);

        this.pushUndo({
            label: "delete-pdf-annotation",
            undo: async () => { await this.savePdfAnnotationRaw(existing); },
            redo: async () => { await this.deletePdfAnnotationRaw(existing); },
        });
    }

    private async discardPendingPdfAnnotation(entry: PdfAnnotationEntry): Promise<void> {
        const list = (this.pdfAnnotationsCache.get(entry.pageId) ?? []).filter((e) => e.id !== entry.id);
        this.pdfAnnotationsCache.set(entry.pageId, list);
        this.drawPdfAnnotationHighlights(entry.pageId);
        await this.renderPdfAnnotationsForPage(entry.pageId, this.getEffectiveScaleForPage(entry.pageId));
    }

    private async createPdfAnnotation(entry: PdfAnnotationEntry): Promise<void> {
        await this.savePdfAnnotationRaw(entry);
        this.pushUndo({
            label: "create-pdf-annotation",
            undo: async () => { await this.deletePdfAnnotationRaw(entry); },
            redo: async () => { await this.savePdfAnnotationRaw(entry); },
        });
    }

    private openPdfAnnotationEditor(entry: PdfAnnotationEntry, isNew: boolean = false): void {
        new PdfAnnotationEditModal(this.app, entry, {
            onSave: async (updated) => {
                if (isNew) {
                    await this.createPdfAnnotation(updated);
                } else {
                    await this.savePdfAnnotation(updated);
                }
            },
            onDelete: async () => { await this.deletePdfAnnotation(entry); },
            onCancel: isNew ? async () => { await this.discardPendingPdfAnnotation(entry); } : undefined,
            onAdjustRange: async (updated) => { await this.beginAnnotationRangeEdit(updated.pageId, updated.id); },
        }).open();
    }

    // ============================================================
    //  ANNOTATIONS-POINTER-EVENTS
    // ============================================================
    private onAnnotationPointerDown(evt: PointerEvent, svg: SVGSVGElement, pageId: string): void {
        this.ui.closeMoreOptions();
        this.cancelManualPanMomentum();

        if (evt.pointerType === "touch" && this.activeTouchPointers.size >= 2) {
            return;
        }

        if (this.shouldIgnoreForDrawing(evt)) {
            this.startManualTouchPan(evt, svg);
            return;
        }

        if (this.currentTool !== "none"
            && this.currentTool !== "select-rect"
            && this.currentTool !== "select-lasso"
            && (this.selectedIds.size > 0 || this.selectedTextBlockIds.size > 0 || this.selectedPdfAnnotationIds.size > 0)) {
            this.clearSelection();
        }

        if (isPenTool(this.currentTool)) {
            this.startFreehandStroke(evt, svg, pageId);
        } else if (this.currentTool === "eraser") {
            evt.preventDefault();
            svg.setPointerCapture(evt.pointerId);
            this.eraserPointerId = evt.pointerId;
            this.eraserActivePageId = pageId;
            this.lastErasePoint = null;
            this.eraseAtEvent(evt, svg, pageId);
        } else if (
            this.currentTool === "rectangle" ||
            this.currentTool === "diamond" ||
            this.currentTool === "triangle-equilateral" ||
            this.currentTool === "triangle-right" ||
            this.currentTool === "ellipse"
        ) {
            this.startDragShape(evt, svg, pageId);
        } else if (this.currentTool === "line" || this.currentTool === "arrow" || this.currentTool === "polygon") {
            this.handleMultiPointClick(evt, svg, pageId);
        } else if (this.currentTool === "text") {
            this.startTextBlockDrag(evt, svg, pageId);
        } else if (this.currentTool === "select-rect" || this.currentTool === "select-lasso") {
            this.startSelectionInteraction(evt, svg, pageId);
        }
    }

    private onAnnotationPointerMove(evt: PointerEvent, svg: SVGSVGElement, pageId: string): void {
        if (evt.pointerType === "touch" && this.activeTouchPointers.size >= 2) {
            return; // Pinch-Zoom übernimmt vollständig - siehe onAnnotationPointerDown.
        }
        if (this.manualPanPointerId === evt.pointerId) {
            this.continueManualTouchPan(evt);
            return;
        }
        if (isPenTool(this.currentTool)) {
            this.continueFreehandStroke(evt, svg, pageId);
        } else if (this.currentTool === "eraser") {
            if (this.eraserPointerId === evt.pointerId) this.eraseAtEvent(evt, svg, pageId);
        } else if (this.dragStart && this.dragPageId === pageId && this.dragPointerId === evt.pointerId) {
            this.continueDragShape(evt, svg);
        } else if (this.multiPoints && this.multiPageId === pageId && this.multiSvg === svg) {
            this.updateMultiPointPreview(evt, svg);
        } else if (this.textDragStart && this.textDragPageId === pageId && this.textDragPointerId === evt.pointerId) {
            this.continueTextBlockDrag(evt, svg);
        } else if (this.selectionPointerId === evt.pointerId) {
            this.continueSelectionInteraction(evt, svg, pageId);
        }
    }

    private async onAnnotationPointerUp(
        evt: PointerEvent,
        svg: SVGSVGElement,
        pageId: string
    ): Promise<void> {
        if (this.manualPanPointerId === evt.pointerId) {
            this.endManualTouchPan(evt, svg);
            return;
        }
        try {
            if (isPenTool(this.currentTool)) {
                await this.finishFreehandStroke(evt, svg, pageId);
                return;
            }

            if (this.currentTool === "eraser") {
                if (this.eraserPointerId === evt.pointerId) {
                    if (svg.hasPointerCapture(evt.pointerId)) {
                        svg.releasePointerCapture(evt.pointerId);
                    }
                    this.eraserPointerId = null;
                    this.eraserActivePageId = null;
                    this.lastErasePoint = null;
                    await this.commitErase(pageId);
                }
                return;
            }

            if (this.textDragStart && this.textDragPageId === pageId && this.textDragPointerId === evt.pointerId) {
                await this.finishTextBlockDrag(evt, svg, pageId);
                return;
            }

            if (
                this.dragStart &&
                this.dragPageId === pageId &&
                this.dragPointerId === evt.pointerId
            ) {
                await this.finishDragShape(evt, svg, pageId);
                return;
            }

            if (this.selectionPointerId === evt.pointerId) {
                await this.finishSelectionInteraction(evt, svg, pageId);
            }
        } finally {
            if (svg.hasPointerCapture(evt.pointerId)) {
                try { svg.releasePointerCapture(evt.pointerId); } catch { /* ignore */ }
            }
            if (this.selectionPointerId === evt.pointerId) this.selectionPointerId = null;
            if (this.dragPointerId === evt.pointerId) this.dragPointerId = null;
            if (this.textDragPointerId === evt.pointerId) this.textDragPointerId = null;
            if (this.eraserPointerId === evt.pointerId) { this.eraserPointerId = null; this.eraserActivePageId = null; }
        }
    }

    /** Liefert die pageId unter den angegebenen Bildschirmkoordinaten (oder null). */
    private getPageIdAtScreenPosition(clientX: number, clientY: number): string | null {
        const pages = this.ui.pagesContentEl.querySelectorAll<HTMLElement>("[data-page-id]");
        for (const el of Array.from(pages)) {
            const rect = el.getBoundingClientRect();
            if (clientX >= rect.left && clientX <= rect.right &&
                clientY >= rect.top && clientY <= rect.bottom) {
                return el.dataset.pageId ?? null;
            }
        }
        return null;
    }

    /** Hebt das Drop-Ziel für einen seitenübergreifenden Move hervor. */
    private setCrossPageTargetHighlight(pageId: string | null): void {
        if (this.currentCrossPageTargetId === pageId) return;

        // Quelle "nach vorne heben", damit gezogene Elemente sichtbar über
        // der Zielseite schweben (sonst liegen sie unter deren Canvas).
        if (this.selectionPageId) {
            const srcEl = this.ui.pagesContentEl.querySelector(
                `[data-page-id="${this.selectionPageId}"]`
            );
            srcEl?.classList.toggle("pdfcompose-cross-page-source", !!pageId);
        }

        if (this.currentCrossPageTargetId) {
            const prev = this.ui.pagesContentEl.querySelector(
                `[data-page-id="${this.currentCrossPageTargetId}"]`
            );
            prev?.classList.remove("pdfcompose-cross-page-target");
        }
        this.currentCrossPageTargetId = pageId;
        if (pageId) {
            const el = this.ui.pagesContentEl.querySelector(`[data-page-id="${pageId}"]`);
            el?.classList.add("pdfcompose-cross-page-target");
        }
    }

    /**
 * Mobile: entscheidet, ob ein Pointer-Event ein Zeichen-/Radier-/Auswahl-
 * Werkzeug auslösen darf. Bei aktivierter Einstellung "Nur Stift zeichnet"
 * werden Finger-Touches ignoriert (Finger scrollen/zoomen dann nur noch),
 * Stift (pointerType "pen") und Maus bleiben unverändert nutzbar. Während
 * eines aktiven Zwei-Finger-Pinch wird jeder Touch ignoriert, unabhängig
 * von dieser Einstellung.
 *
 * Radiergummi und Auswahlwerkzeuge folgen bewusst derselben Regel wie die
 * Zeichenwerkzeuge: Ist "Nur Stift zeichnet" aktiv, sollen Finger auf der
 * Zeichenebene ausschließlich scrollen/zoomen können (via
 * startManualTouchPan), statt versehentlich zu radieren oder eine Auswahl
 * aufzuziehen. Vorher gab es hier eine Ausnahme, die Finger-Touches für
 * Radierer/Auswahl immer durchließ - das verhinderte zugleich jegliches
 * Finger-Scrollen bei diesen Werkzeugen, weil startManualTouchPan dann nie
 * erreicht wurde.
 */
    private shouldIgnoreForDrawing(evt: PointerEvent): boolean {
        if (evt.pointerType !== "touch") return false;
        if (this.activeTouchPointers.size >= 2) return true;

        return this.plugin.settings.restrictDrawingToStylus === true;
    }

    /**
 * Manuelles Ein-Finger-Scrollen für die Annotations-Ebene, wenn "Nur
 * Stift zeichnet" aktiv ist. touch-action ist auf den Zeichenebenen
 * bewusst immer "none" (siehe renderAnnotationLayer), damit ein Stift
 * niemals versehentlich eine native Scroll-Geste auslöst - das bedeutet
 * aber, dass der Browser für Finger-Touches auf denselben Ebenen
 * ebenfalls nicht mehr automatisch scrollt. Diese Methode übernimmt das
 * Scrollen deshalb selbst.
 */
    private startManualTouchPan(evt: PointerEvent, svg: SVGSVGElement): void {
        if (evt.pointerType !== "touch") return;
        if (this.activeTouchPointers.size >= 2) return; // Pinch übernimmt das Zoomen
        this.cancelManualPanMomentum();
        evt.preventDefault();
        try { svg.setPointerCapture(evt.pointerId); } catch { /* ignore */ }
        this.manualPanPointerId = evt.pointerId;
        this.manualPanStart = { x: evt.clientX, y: evt.clientY };
        this.manualPanSvg = svg;
        const container = this.ui.pagesContainerEl;
        this.manualPanScrollStart = { left: container.scrollLeft, top: container.scrollTop };
        this.manualPanLastMoveTime = performance.now();
        this.manualPanLastMovePos = { x: evt.clientX, y: evt.clientY };
        this.manualPanVelocity = { x: 0, y: 0 };
    }

    private continueManualTouchPan(evt: PointerEvent): void {
        if (this.manualPanPointerId !== evt.pointerId || !this.manualPanStart || !this.manualPanScrollStart) return;
        evt.preventDefault();
        const container = this.ui.pagesContainerEl;
        const dx = evt.clientX - this.manualPanStart.x;
        const dy = evt.clientY - this.manualPanStart.y;
        container.scrollLeft = this.manualPanScrollStart.left - dx;
        container.scrollTop = this.manualPanScrollStart.top - dy;

        // Geschwindigkeit (px/ms) für das spätere Trägheits-Scrollen messen,
        // exponentiell geglättet - rohe Touch-Samples "zittern" sonst zu
        // stark, um daraus eine ruhige Ausklang-Bewegung abzuleiten.
        const now = performance.now();
        if (this.manualPanLastMovePos) {
            const dt = now - this.manualPanLastMoveTime;
            if (dt > 0) {
                const instVx = (evt.clientX - this.manualPanLastMovePos.x) / dt;
                const instVy = (evt.clientY - this.manualPanLastMovePos.y) / dt;
                const smoothing = 0.35;
                const prev = this.manualPanVelocity ?? { x: 0, y: 0 };
                this.manualPanVelocity = {
                    x: prev.x + (instVx - prev.x) * smoothing,
                    y: prev.y + (instVy - prev.y) * smoothing,
                };
            }
        }
        this.manualPanLastMoveTime = now;
        this.manualPanLastMovePos = { x: evt.clientX, y: evt.clientY };
    }

    private endManualTouchPan(evt: PointerEvent, svg: SVGSVGElement): void {
        if (this.manualPanPointerId !== evt.pointerId) return;
        if (svg.hasPointerCapture(evt.pointerId)) {
            try { svg.releasePointerCapture(evt.pointerId); } catch { /* ignore */ }
        }
        const velocity = this.manualPanVelocity;
        this.manualPanPointerId = null;
        this.manualPanStart = null;
        this.manualPanScrollStart = null;
        this.manualPanSvg = null;
        this.manualPanLastMovePos = null;
        this.manualPanVelocity = null;

        this.startManualPanMomentum(velocity);
    }

    /** Setzt das Scrollen nach Loslassen des Fingers mit abnehmender
 *  Geschwindigkeit fort ("Trägheits-Scrollen") - genau wie natives
 *  Scrollen ohne aktives Werkzeug, damit sich größere Entfernungen
 *  weiterhin per Schwung überwinden lassen, statt bei jedem Loslassen
 *  abrupt zu stoppen. */
    private startManualPanMomentum(velocity: { x: number; y: number } | null): void {
        this.cancelManualPanMomentum();
        if (!velocity) return;
        let vx = velocity.x;
        let vy = velocity.y;
        if (Math.hypot(vx, vy) < PdfComposeView.MOMENTUM_MIN_VELOCITY) return;

        const container = this.ui.pagesContainerEl;
        let lastTime = performance.now();

        const step = (time: number) => {
            const dt = Math.min(48, time - lastTime); // gegen Sprünge bei Tab-Wechsel absichern
            lastTime = time;

            container.scrollLeft -= vx * dt;
            container.scrollTop -= vy * dt;

            // Reibung auf die tatsächlich vergangene Zeit normiert, damit
            // die Abbremsung unabhängig von der Bildwiederholrate gleich wirkt.
            const frictionFactor = Math.pow(PdfComposeView.MOMENTUM_FRICTION, dt / 16.67);
            vx *= frictionFactor;
            vy *= frictionFactor;

            if (Math.hypot(vx, vy) < PdfComposeView.MOMENTUM_MIN_VELOCITY) {
                this.manualPanMomentumRafId = null;
                return;
            }
            this.manualPanMomentumRafId = requestAnimationFrame(step);
        };
        this.manualPanMomentumRafId = requestAnimationFrame(step);
    }

    private cancelManualPanMomentum(): void {
        if (this.manualPanMomentumRafId !== null) {
            cancelAnimationFrame(this.manualPanMomentumRafId);
            this.manualPanMomentumRafId = null;
        }
    }

    /** Bricht eine evtl. bereits mit dem ersten Finger begonnene Aktion ab, sobald ein zweiter Finger dazukommt (Pinch hat Vorrang). */
    private cancelActiveTouchInteractions(): void {
        if (this.activeStroke && this.activePointerId !== null) {
            this.activeStrokePath?.remove();
            this.activeStroke = null;
            this.activeStrokeColor = null;
            this.activeStrokePath = null;
            this.activeStrokePageId = null;
            this.activePointerId = null;
        }
        if (this.eraserPointerId !== null) {
            this.pendingEraseIds.clear();
            this.pendingEraseAnnotationIds.clear();
            this.pendingEraseTextBlockIds.clear();
            this.eraserPointerId = null;
            this.eraserActivePageId = null;
            this.lastErasePoint = null;
            if (this.selectionPageId) this.redrawPageFromCache(this.selectionPageId);
        }
        if (this.dragPreviewEl) {
            this.dragPreviewEl.remove();
            this.dragPreviewEl = null;
            this.dragStart = null;
            this.dragPageId = null;
            this.dragPointerId = null;
        }
        if (this.selectionPointerId !== null) {
            this.selectionPreviewEl?.remove();
            this.selectionPreviewEl = null;
            this.selectionDragStart = null;
            this.lassoPoints = null;
            this.isMovingSelection = false;
            this.moveOrigin = null;
            this.moveSnapshot = null;
            this.selectionPointerId = null;
        }
        this.resetElevatedPageForDrag();
        this.cancelManualPanMomentum();
        if (this.manualPanPointerId !== null) {
            if (this.manualPanSvg?.hasPointerCapture(this.manualPanPointerId)) {
                try { this.manualPanSvg.releasePointerCapture(this.manualPanPointerId); } catch { /* ignore */ }
            }
            this.manualPanPointerId = null;
            this.manualPanStart = null;
            this.manualPanScrollStart = null;
            this.manualPanSvg = null;
            this.manualPanLastMovePos = null;
            this.manualPanVelocity = null;
        }
    }

    /**
 * Behandelt Doppelklick auf der Annotations-SVG.
 * - Bei Zeichenwerkzeugen (Linie, Pfeil, Polygon) wird die Form abgeschlossen.
 * - Bei Auswahlmodus: Prüft, ob auf ein Segment eines ausgewählten Objekts geklickt wurde,
 *   und fügt dort einen Punkt ein.
 */
    private onSvgDblClick(evt: MouseEvent, pageId: string): void {
        const svg = this.ui.annotationLayers.get(pageId);
        if (!svg) return;

        if (this.currentTool === "line" || this.currentTool === "arrow" || this.currentTool === "polygon") {
            this.finishMultiPointShape(pageId);
            return;
        }

        const isSelectTool = this.currentTool === "select-rect" || this.currentTool === "select-lasso";
        if (this.currentTool !== "none" && !isSelectTool) return;

        // Klick auf die Beschriftung selbst hat Vorrang
        const labelOwnerId = this.findLabelOwnerAtClientPoint(pageId, evt.clientX, evt.clientY);
        if (labelOwnerId) {
            evt.preventDefault();
            evt.stopPropagation();
            this.openLabelEditorForObject(pageId, labelOwnerId);
            return;
        }

        const point = this.getSvgPointFromEvent(svg, evt);

        if (isSelectTool && this.selectedIds.size > 0 && this.selectionPageId === pageId) {
            const segment = this.findSegmentAtPoint(pageId, point);
            if (segment) {
                evt.preventDefault();
                evt.stopPropagation();
                void this.addPointOnSegment(pageId, segment.objectId, segment.segmentIndex, point);
                return;
            }
        }

        const hit = this.findTopmostObjectAt(pageId, point);
        const hitId = hit?.getAttribute("data-object-id");
        if (hitId) {
            evt.preventDefault();
            evt.stopPropagation();
            this.openLabelEditorForObject(pageId, hitId);
        }
    }

    private findLabelOwnerAtClientPoint(pageId: string, clientX: number, clientY: number): string | null {
        const pad = 4;
        for (const layer of this.ui.getObjectLayers(pageId)) {
            const labels = layer.querySelectorAll<SVGGraphicsElement>("[data-label-owner]");
            for (let i = labels.length - 1; i >= 0; i--) {
                const r = labels[i].getBoundingClientRect();
                if (clientX >= r.left - pad && clientX <= r.right + pad &&
                    clientY >= r.top - pad && clientY <= r.bottom + pad) {
                    return labels[i].getAttribute("data-label-owner");
                }
            }
        }
        return null;
    }

    /** Öffnet den Bearbeitungsdialog für die Text-Beschriftung eines Objekts (Form ODER Linie/Pfeil). */
    private openLabelEditorForObject(pageId: string, objectId: string): void {
        const objects = this.getPageAnnotations(pageId);
        const obj = objects.find(o => o.id === objectId);
        if (!obj) return;
        const isLine = obj.type === "line" || obj.type === "arrow";
        // Freihand-Striche und Textmarker-Formen bekommen (vorerst) keine Beschriftung.
        if (obj.type === "freehand") return;

        const currentLabel: any = (obj as any).label;

        new LabelEditModal(
            this.app,
            isLine,
            {
                text: currentLabel?.text ?? "",
                fontSize: currentLabel?.fontSize,
                color: currentLabel?.color,
                mode: currentLabel?.mode ?? "inline",
            },
            async (result) => {
                const label = isLine
                    ? ({ text: result.text, fontSize: result.fontSize, color: result.color, mode: result.mode ?? "inline" } as LineLabel)
                    : ({ text: result.text, fontSize: result.fontSize, color: result.color } as ShapeLabel);
                await this.setObjectLabel(pageId, objectId, label);
            },
            async () => {
                await this.setObjectLabel(pageId, objectId, undefined);
            }
        ).open();
    }

    private async setObjectLabel(
        pageId: string,
        objectId: string,
        label: ShapeLabel | LineLabel | undefined
    ): Promise<void> {
        const objects = this.getPageAnnotations(pageId);
        const idx = objects.findIndex((o) => o.id === objectId);
        if (idx === -1) return;
        const before = structuredClone(objects[idx]);
        const updated = objects.map((o, i) =>
            i === idx ? ({ ...o, label } as VectorObject) : o
        );
        await this.setPageAnnotations(pageId, updated);

        // Beschriftung im Markdown + shapeLabels-Meta persistieren.
        if (label && label.text.trim()) {
            const entry: ShapeLabelEntry = {
                id: objectId,
                pageId,
                shapeId: objectId,
                fontSize: label.fontSize,
                color: label.color,
                mode: (label as LineLabel).mode,
                text: label.text,
            };
            await this.saveShapeLabelRaw(entry);
        } else {
            await this.deleteShapeLabelRaw(objectId, pageId);
        }

        this.pushUndo({
            label: "set-object-label",
            undo: async () => {
                const current = this.getPageAnnotations(pageId);
                const i = current.findIndex((o) => o.id === objectId);
                if (i === -1) return;
                const restored = current.map((o, j) => j === i ? before : o);
                await this.setPageAnnotations(pageId, restored);
                if (before && (before as any).label?.text) {
                    await this.saveShapeLabelRaw({
                        id: objectId, pageId, shapeId: objectId,
                        fontSize: (before as any).label.fontSize,
                        color: (before as any).label.color,
                        mode: (before as any).label.mode,
                        text: (before as any).label.text,
                    });
                } else {
                    await this.deleteShapeLabelRaw(objectId, pageId);
                }
            },
            redo: async () => {
                const current = this.getPageAnnotations(pageId);
                const i = current.findIndex((o) => o.id === objectId);
                if (i === -1) return;
                const applied = current.map((o, j) =>
                    j === i ? ({ ...o, label } as VectorObject) : o
                );
                await this.setPageAnnotations(pageId, applied);
                if (label && label.text.trim()) {
                    await this.saveShapeLabelRaw({
                        id: objectId, pageId, shapeId: objectId,
                        fontSize: label.fontSize, color: label.color,
                        mode: (label as LineLabel).mode, text: label.text,
                    });
                } else {
                    await this.deleteShapeLabelRaw(objectId, pageId);
                }
            },
        });
    }

    private async saveShapeLabelRaw(entry: ShapeLabelEntry): Promise<void> {
        await this.updateFileAtomic(
            (fm) => {
                if (!fm.shapeLabels) fm.shapeLabels = [];
                const idx = fm.shapeLabels.findIndex((s: any) => s.id === entry.id);
                const meta = {
                    id: entry.id, pageId: entry.pageId, shapeId: entry.shapeId,
                    fontSize: entry.fontSize, color: entry.color, mode: entry.mode,
                };
                if (idx === -1) fm.shapeLabels.push(meta);
                else fm.shapeLabels[idx] = meta;
            },
            (body) => upsertShapeLabel(body, entry)
        );
        const list = this.shapeLabelsCache.get(entry.pageId) || [];
        const idx = list.findIndex((s) => s.id === entry.id);
        if (idx === -1) list.push(entry);
        else list[idx] = entry;
        this.shapeLabelsCache.set(entry.pageId, list);
    }

    private async deleteShapeLabelRaw(id: string, pageId: string): Promise<void> {
        await this.updateFileAtomic(
            (fm) => {
                if (fm.shapeLabels) {
                    fm.shapeLabels = fm.shapeLabels.filter((s: any) => s.id !== id);
                }
            },
            (body) => removeShapeLabel(body, id)
        );
        const list = (this.shapeLabelsCache.get(pageId) || []).filter((s) => s.id !== id);
        this.shapeLabelsCache.set(pageId, list);
    }

    /**
 * Wandelt ein Ereignis (PointerEvent oder MouseEvent) in einen Punkt
 * im SVG-Koordinatensystem um.
 */
    private getSvgPointFromEvent(svg: SVGSVGElement, evt: { clientX: number; clientY: number }): { x: number; y: number } {
        const point = svg.createSVGPoint();
        point.x = evt.clientX;
        point.y = evt.clientY;
        const ctm = svg.getScreenCTM();
        if (!ctm) return { x: 0, y: 0 };
        try {
            const transformed = point.matrixTransform(ctm.inverse());
            return { x: transformed.x, y: transformed.y };
        } catch {
            return { x: 0, y: 0 };
        }
    }

    /**
     * Sucht unter den ausgewählten Objekten der Seite das erste Segment,
     * das dem Klickpunkt nahe genug ist (Toleranz 8 SVG-Einheiten).
     * Gibt Objekt-ID und Segmentindex (Zielpunkt-Index) zurück.
     */
    private findSegmentAtPoint(pageId: string, point: { x: number; y: number }): { objectId: string; segmentIndex: number } | null {
        const objects = this.getPageAnnotations(pageId);
        const selectedObjects = objects.filter(o => this.selectedIds.has(o.id));
        const tolerance = 8;

        for (const obj of selectedObjects) {
            if (obj.type !== "line" && obj.type !== "arrow" && obj.type !== "polygon") continue;
            const pts = obj.points;
            const n = pts.length;
            if (n < 2) continue;
            // Prüfe jedes Segment: von pts[i] nach pts[(i+1)%n] (bei Polygon geschlossen)
            const segmentCount = obj.type === "polygon" ? n : n - 1;
            for (let i = 0; i < segmentCount; i++) {
                const p1 = pts[i];
                const p2 = pts[(i + 1) % n];
                // Abstand Punkt zu Strecke
                const dist = this.distancePointToSegment(point, p1, p2);
                if (dist <= tolerance) {
                    // Segmentindex = Zielpunkt-Index (i+1 mod n)
                    const segIdx = (i + 1) % n;
                    return { objectId: obj.id, segmentIndex: segIdx };
                }
            }
        }
        return null;
    }

    /**
     * Fügt einen neuen Punkt in ein Linien-/Pfeil-/Polygon-Objekt ein,
     * und zwar vor dem Punkt mit dem angegebenen Index.
     * Der neue Punkt erbt den Segment-Typ vom ursprünglichen Zielpunkt.
     */
    private async addPointOnSegment(pageId: string, objectId: string, segmentIndex: number, newPoint: { x: number; y: number }): Promise<void> {
        const objects = this.getPageAnnotations(pageId);
        const objIndex = objects.findIndex(o => o.id === objectId);
        if (objIndex === -1) return;
        const obj = objects[objIndex];
        if (obj.type !== "line" && obj.type !== "arrow" && obj.type !== "polygon") return;

        // Alten Zustand für Undo sichern
        const before = JSON.parse(JSON.stringify(obj));

        // Punkt einfügen (vor segmentIndex)
        const newLinePoint: LinePoint = {
            x: newPoint.x,
            y: newPoint.y,
            // Segment-Typ vom Zielpunkt übernehmen
            segment: obj.points[segmentIndex].segment ?? "straight",
        };
        obj.points.splice(segmentIndex, 0, newLinePoint);

        // Für geschlossene Polygone: das schließende Segment sollte "straight" sein,
        // da es keine sinnvolle Kurve/Stufe am Übergang vom letzten zum ersten Punkt gibt.
        if (obj.type === "polygon") {
            // Das Segment vom letzten zum ersten Punkt (Index 0) ist das schließende.
            // Der Segment-Typ des ersten Punktes ist irrelevant für die Schließung,
            // aber wir setzen ihn auf "straight", um unerwartete Kurven zu vermeiden.
            // Da wir den Punkt vor segmentIndex eingefügt haben, müssen wir den
            // Segment-Typ des neuen ersten Punktes ggf. anpassen? Nein, das schließende
            // Segment wird durch den Segment-Typ des ersten Punktes definiert.
            // Wir setzen ihn hier nicht um, da der Benutzer dies ggf. manuell ändern kann.
        }

        // Neues Objekt speichern
        await this.setPageAnnotations(pageId, objects);

        // Undo-Befehl registrieren
        this.pushUndo({
            label: "add-point",
            undo: async () => {
                const current = this.getPageAnnotations(pageId);
                const idx = current.findIndex(o => o.id === objectId);
                if (idx !== -1) {
                    (current[idx] as any).points = before.points;
                    await this.setPageAnnotations(pageId, current);
                }
            },
            redo: async () => {
                const current = this.getPageAnnotations(pageId);
                const idx = current.findIndex(o => o.id === objectId);
                if (idx !== -1) {
                    (current[idx] as any).points = obj.points;
                    await this.setPageAnnotations(pageId, current);
                }
            },
        });
    }

    /**
     * Entfernt einen Punkt aus einem Linien-/Pfeil-/Polygon-Objekt,
     * sofern die Mindestanzahl nicht unterschritten wird.
     */
    private async removePoint(pageId: string, objectId: string, pointIndex: number): Promise<void> {
        const objects = this.getPageAnnotations(pageId);
        const objIndex = objects.findIndex(o => o.id === objectId);
        if (objIndex === -1) return;
        const obj = objects[objIndex];
        if (obj.type !== "line" && obj.type !== "arrow" && obj.type !== "polygon") return;

        const minPoints = obj.type === "polygon" ? 3 : 2;
        if (obj.points.length <= minPoints) {
            new Notice("An object must have at least " + minPoints + " points.");
            return;
        }

        const before = JSON.parse(JSON.stringify(obj));
        obj.points.splice(pointIndex, 1);

        await this.setPageAnnotations(pageId, objects);

        this.pushUndo({
            label: "remove-point",
            undo: async () => {
                const current = this.getPageAnnotations(pageId);
                const idx = current.findIndex(o => o.id === objectId);
                if (idx !== -1) {
                    (current[idx] as any).points = before.points;
                    await this.setPageAnnotations(pageId, current);
                }
            },
            redo: async () => {
                const current = this.getPageAnnotations(pageId);
                const idx = current.findIndex(o => o.id === objectId);
                if (idx !== -1) {
                    (current[idx] as any).points = obj.points;
                    await this.setPageAnnotations(pageId, current);
                }
            },
        });
    }

    /**
     * Zeigt ein Kontextmenü für einen Punkt-Handle an.
     * Der einzige Eintrag ist "Punkt löschen" (sofern erlaubt).
     */
    private onPointContextMenu(evt: MouseEvent, pageId: string, objectId: string, pointIndex: number): void {
        evt.preventDefault();
        evt.stopPropagation();
        this.showPointContextMenuAt(evt.clientX, evt.clientY, pageId, objectId, pointIndex);
    }

    /**
     * Koordinatenbasierte Variante von onPointContextMenu(): wird sowohl vom
     * echten "contextmenu"-Event (Rechtsklick, Desktop) als auch vom
     * Long-Press-Ersatz auf Touch-/Stift-Geräten aufgerufen (siehe
     * startPointDrag() - dort gibt es kein natives contextmenu-Event, weil
     * der Long-Press bereits als Drag-Geste behandelt wird).
     */
    private showPointContextMenuAt(clientX: number, clientY: number, pageId: string, objectId: string, pointIndex: number): void {
        const objects = this.getPageAnnotations(pageId);
        const obj = objects.find(o => o.id === objectId);
        if (!obj || (obj.type !== "line" && obj.type !== "arrow" && obj.type !== "polygon")) return;

        const minPoints = obj.type === "polygon" ? 3 : 2;
        const canDelete = obj.points.length > minPoints;

        const menu = new Menu();
        menu.addItem((item) => {
            item.setTitle(canDelete ? "Delete point" : "Delete point (minimum reached)")
                .setIcon("trash")
                .setDisabled(!canDelete)
                .onClick(() => {
                    if (canDelete) {
                        void this.removePoint(pageId, objectId, pointIndex);
                    }
                });
        });
        menu.showAtPosition({ x: clientX, y: clientY });
    }

    /** Tiefpass auf den Druck: rohe Druckwerte springen von Sample zu Sample und erzeugen sonst unruhige Breiten. */
    private smoothPressure(raw: number | undefined): number | undefined {
        if (raw === undefined) return undefined;
        const prev = this.activeSmoothedPressure;
        const next = prev === null ? raw : prev + (raw - prev) * 0.4;
        this.activeSmoothedPressure = next;
        return next;
    }

    // ============================================================
    //  FREIHAND
    // ============================================================
    private startFreehandStroke(evt: PointerEvent, svg: SVGSVGElement, pageId: string): void {
        evt.preventDefault();
        svg.setPointerCapture(evt.pointerId);
        this.activePointerId = evt.pointerId;
        this.activeStrokePageId = pageId;
        this.ui.closeAllDropdowns();

        const preset = this.getActivePenPreset();
        const { x, y } = this.getSvgPoint(svg, evt);
        this.activeSmoothedPressure = null;
        const pressure = this.smoothPressure(evt.pressure > 0 ? evt.pressure : undefined);
        const width = this.computePressureWidth(preset, pressure);
        this.activeStrokeColor = preset.color;
        this.activeStroke = [{ x, y, p: pressure, w: width, t: Date.now() }];

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        this.applyFreehandPathAttributes(path, this.activeStroke, this.getFreehandDisplayColor(pageId, this.activeStrokeColor, preset.highlighter));
        const targetSvg = preset.highlighter ? (this.ui.highlightLayers.get(pageId) ?? svg) : svg;
        targetSvg.appendChild(path);
        this.activeStrokePath = path;
    }

    private continueFreehandStroke(evt: PointerEvent, svg: SVGSVGElement, pageId: string): void {
        if (!this.activeStroke || this.activeStrokePageId !== pageId || evt.pointerId !== this.activePointerId) return;
        evt.preventDefault();

        const preset = this.getActivePenPreset();

        const coalesced = typeof evt.getCoalescedEvents === "function" ? evt.getCoalescedEvents() : null;
        const rawEvents = coalesced && coalesced.length > 0 ? coalesced : [evt];

        for (const e of rawEvents) {
            const { x, y } = this.getSvgPoint(svg, e);
            const pressure = this.smoothPressure(e.pressure > 0 ? e.pressure : undefined);
            const width = this.computePressureWidth(preset, pressure);
            this.activeStroke.push({ x, y, p: pressure, w: width, t: Date.now() });
        }

        if (!this.freehandRedrawScheduled) {
            this.freehandRedrawScheduled = true;
            requestAnimationFrame(() => {
                this.freehandRedrawScheduled = false;
                if (this.activeStrokePath && this.activeStrokeColor && this.activeStroke) {
                    this.applyFreehandPathAttributes(
                        this.activeStrokePath,
                        this.activeStroke,
                        this.getFreehandDisplayColor(pageId, this.activeStrokeColor, preset.highlighter)
                    );
                }
            });
        }
    }

    private async finishFreehandStroke(evt: PointerEvent, svg: SVGSVGElement, pageId: string): Promise<void> {
        if (!this.activeStroke || this.activeStrokePageId !== pageId || evt.pointerId !== this.activePointerId) return;
        if (svg.hasPointerCapture(evt.pointerId)) svg.releasePointerCapture(evt.pointerId);

        const preset = this.getActivePenPreset();
        const rawStroke = this.activeStroke;
        const strokeColor = this.activeStrokeColor ?? preset.color;
        const finishedPath = this.activeStrokePath;
        this.activeStroke = null;
        this.activeStrokeColor = null;
        this.activeStrokePath = null;
        this.activeStrokePageId = null;
        this.activePointerId = null;

        if (rawStroke.length < 2) {
            finishedPath?.remove();
            return;
        }

        const baseTolerance = this.plugin.settings.strokeSimplifyTolerance;
        const zoomAdjustedTolerance = Math.max(0.05, baseTolerance / this.zoomLevel);
        const simplified = simplifyStroke(rawStroke, zoomAdjustedTolerance);
        const newStroke: FreehandObject = {
            id: crypto.randomUUID(),
            type: "freehand",
            points: simplified,
            color: strokeColor,
            highlighter: preset.highlighter,
            pressureEnabled: preset.pressure.enabled,
            pressureMinFactor: preset.pressure.minFactor,
            pressureCurve: preset.pressure.curve,
            strokeWidth: preset.strokeWidth,
        };

        if (finishedPath) {
            this.applyFreehandPathAttributes(finishedPath, simplified, this.getFreehandDisplayColor(pageId, strokeColor, preset.highlighter));
            finishedPath.setAttribute("data-object-id", newStroke.id);
        }
        await this.saveNewObject(pageId, newStroke);
    }

    // ============================================================
    //  DRAG-SHAPE (Rechteck, Dreieck, Ellipse)
    // ============================================================
    private startDragShape(evt: PointerEvent, svg: SVGSVGElement, pageId: string): void {
        evt.preventDefault();
        svg.setPointerCapture(evt.pointerId);
        this.dragPointerId = evt.pointerId;
        this.dragPageId = pageId;
        this.dragStart = this.getSvgPoint(svg, evt);
        this.ui.closeAllDropdowns(); // Dropdown schließen bei Benutzung

        const el = this.currentTool === "ellipse"
            ? document.createElementNS("http://www.w3.org/2000/svg", "ellipse")
            : this.currentTool === "rectangle"
                ? document.createElementNS("http://www.w3.org/2000/svg", "rect")
                : document.createElementNS("http://www.w3.org/2000/svg", "polygon"); // Dreieck & Raute nutzen ebenfalls <polygon>
        el.setAttribute("stroke", this.getDisplayColorForPage(pageId, this.styleStrokeColor));
        el.setAttribute("stroke-width", this.styleStrokeWidth.toString());
        el.setAttribute("fill", this.styleFillEnabled ? this.getDisplayColorForPage(pageId, this.styleFillColor) : "none");
        el.setAttribute("fill-opacity", this.styleFillOpacity.toString());
        svg.appendChild(el);
        this.dragPreviewEl = el;
    }

    private continueDragShape(evt: PointerEvent, svg: SVGSVGElement): void {
        if (!this.dragStart || !this.dragPreviewEl) return;
        evt.preventDefault();
        const current = this.getSvgPoint(svg, evt);
        this.updateShapeGeometry(this.dragPreviewEl, this.currentTool, this.dragStart, current);
    }

    private updateShapeGeometry(
        el: SVGElement,
        tool: AnnotationTool,
        start: { x: number; y: number },
        current: { x: number; y: number }
    ): void {
        const x = Math.min(start.x, current.x);
        const y = Math.min(start.y, current.y);
        const width = Math.abs(current.x - start.x);
        const height = Math.abs(current.y - start.y);

        if (tool === "rectangle") {
            el.setAttribute("x", x.toString());
            el.setAttribute("y", y.toString());
            el.setAttribute("width", width.toString());
            el.setAttribute("height", height.toString());
        } else if (tool === "ellipse") {
            el.setAttribute("cx", (x + width / 2).toString());
            el.setAttribute("cy", (y + height / 2).toString());
            el.setAttribute("rx", (width / 2).toString());
            el.setAttribute("ry", (height / 2).toString());
        } else if (tool === "diamond") {
            const points = `${x + width / 2},${y} ${x + width},${y + height / 2} ${x + width / 2},${y + height} ${x},${y + height / 2}`;
            el.setAttribute("points", points);
        } else {
            const points = tool === "triangle-right"
                ? `${x},${y + height} ${x},${y} ${x + width},${y + height}`
                : `${x + width / 2},${y} ${x},${y + height} ${x + width},${y + height}`;
            el.setAttribute("points", points);
        }
    }

    private async finishDragShape(evt: PointerEvent, svg: SVGSVGElement, pageId: string): Promise<void> {
        if (!this.dragStart || !this.dragPreviewEl) return;
        if (svg.hasPointerCapture(evt.pointerId)) svg.releasePointerCapture(evt.pointerId);

        const start = this.dragStart;
        const current = this.getSvgPoint(svg, evt);
        const previewEl = this.dragPreviewEl;
        const tool = this.currentTool;

        this.dragStart = null;
        this.dragPreviewEl = null;
        this.dragPageId = null;
        this.dragPointerId = null;

        const x = Math.min(start.x, current.x);
        const y = Math.min(start.y, current.y);
        const width = Math.abs(current.x - start.x);
        const height = Math.abs(current.y - start.y);

        if (width < 2 && height < 2) {
            previewEl.remove();
            return;
        }

        const id = crypto.randomUUID();
        const styleBase = {
            strokeColor: this.styleStrokeColor,
            strokeWidth: this.styleStrokeWidth,
            fillColor: this.styleFillEnabled ? this.styleFillColor : undefined,
            fillOpacity: this.styleFillEnabled ? this.styleFillOpacity : undefined,
            isHighlighter: this.styleShapeHighlighter,
        };
        let obj: VectorObject;

        if (tool === "rectangle") {
            obj = { id, type: "rectangle", x, y, width, height, ...styleBase } as RectangleObject;
        } else if (tool === "ellipse") {
            obj = {
                id, type: "ellipse",
                cx: x + width / 2, cy: y + height / 2, rx: width / 2, ry: height / 2,
                ...styleBase,
            } as EllipseObject;
        } else if (tool === "diamond") {
            obj = { id, type: "diamond", x, y, width, height, ...styleBase } as DiamondObject;
        } else {
            obj = {
                id, type: "triangle",
                variant: tool === "triangle-right" ? "right" : "equilateral",
                x, y, width, height, ...styleBase,
            } as TriangleObject;
        }

        previewEl.setAttribute("data-object-id", id);
        await this.saveNewObject(pageId, obj);
        await this.selectObjectAfterCreation(pageId, id);
    }

    // ============================================================
    //  MEHRPUNKT-WERKZEUGE (Linie, Pfeil, Polygon)
    // ============================================================
    private handleMultiPointClick(evt: PointerEvent, svg: SVGSVGElement, pageId: string): void {
        evt.preventDefault();
        const point = this.getSvgPoint(svg, evt);

        // Erkennt den zweiten Klick eines Doppelklicks, der die Form/Linie
        // gleich per "dblclick" beendet (siehe onSvgDblClick ->
        // finishMultiPointShape). Ohne diese Prüfung erzeugt jeder Doppel-
        // klick ZWEI pointerdown-Ereignisse an (fast) derselben Position,
        // wodurch zusätzlich zum gewünschten letzten Punkt ein überflüssiger,
        // beinahe identischer Punkt eingefügt wurde.
        const now = Date.now();
        const isLikelyDoubleClickFinish =
            this.multiPoints !== null &&
            this.multiPageId === pageId &&
            this.multiSvg === svg &&
            now - this.lastMultiPointClickTime < PdfComposeView.MULTI_POINT_DOUBLE_CLICK_MS &&
            this.lastMultiPointClickPos !== null &&
            Math.hypot(
                point.x - this.lastMultiPointClickPos.x,
                point.y - this.lastMultiPointClickPos.y
            ) < PdfComposeView.MULTI_POINT_DOUBLE_CLICK_DIST;

        this.lastMultiPointClickTime = now;
        this.lastMultiPointClickPos = point;

        if (isLikelyDoubleClickFinish) {
            // Kein neuer Punkt - der bereits vorhandene letzte Punkt bleibt
            // die Endposition; das nachfolgende "dblclick"-Ereignis schließt
            // die Form/Linie damit korrekt ohne Duplikat ab.
            return;
        }

        if (!this.multiPoints || this.multiPageId !== pageId || this.multiSvg !== svg) {
            // Erster Punkt – Dropdown schließen
            this.ui.closeAllDropdowns();
            this.multiPoints = [point];
            this.multiPageId = pageId;
            this.multiSvg = svg;

            const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
            el.setAttribute("stroke", this.getDisplayColorForPage(pageId, this.styleStrokeColor));
            el.setAttribute("stroke-width", this.styleStrokeWidth.toString());
            el.setAttribute("fill", this.currentTool === "polygon" && this.styleFillEnabled ? this.getDisplayColorForPage(pageId, this.styleFillColor) : "none");
            el.setAttribute("fill-opacity", this.styleFillOpacity.toString());
            el.setAttribute("stroke-linecap", "round");
            el.setAttribute("stroke-linejoin", "round");
            svg.appendChild(el);
            this.multiPreviewEl = el;
        } else {
            this.multiPoints.push(point);
        }

        this.redrawMultiPointPreview();
    }

    private updateMultiPointPreview(evt: PointerEvent, svg: SVGSVGElement): void {
        if (!this.multiPoints) return;
        const current = this.getSvgPoint(svg, evt);
        this.redrawMultiPointPreview(current);
    }

    private redrawMultiPointPreview(cursor?: { x: number; y: number }): void {
        if (!this.multiPoints || !this.multiPreviewEl) return;
        const allPoints = cursor ? [...this.multiPoints, cursor] : this.multiPoints;
        const linePoints: LinePoint[] = allPoints.map((p, i) => ({
            x: p.x, y: p.y,
            segment: i === 0 ? undefined : this.styleSegmentKind,
        }));
        const closed = this.currentTool === "polygon";
        (this.multiPreviewEl as SVGPathElement).setAttribute("d", this.linePointsToPathData(linePoints, closed));
    }

    public finishMultiPointShape(pageId: string): void {
        if (!this.multiPoints || this.multiPageId !== pageId || this.multiPoints.length < 2) {
            this.cancelMultiPointDrawing();
            return;
        }

        const rawPoints = this.multiPoints;
        const previewEl = this.multiPreviewEl;
        const tool = this.currentTool;
        this.multiPoints = null;
        this.multiPreviewEl = null;
        this.multiPageId = null;
        this.multiSvg = null;
        this.lastMultiPointClickTime = 0;
        this.lastMultiPointClickPos = null;

        const id = crypto.randomUUID();
        const linePoints: LinePoint[] = rawPoints.map((p, i) => ({
            x: p.x, y: p.y,
            segment: i === 0 ? undefined : this.styleSegmentKind,
        }));
        let obj: VectorObject;

        if (tool === "polygon") {
            obj = {
                id, type: "polygon", points: linePoints,
                strokeColor: this.styleStrokeColor, strokeWidth: this.styleStrokeWidth,
                fillColor: this.styleFillEnabled ? this.styleFillColor : undefined,
                fillOpacity: this.styleFillEnabled ? this.styleFillOpacity : undefined,
                isHighlighter: this.styleShapeHighlighter,
            } as PolygonObject;
        } else {
            obj = {
                id, type: tool === "arrow" ? "arrow" : "line",
                points: linePoints,
                color: this.styleStrokeColor, width: this.styleStrokeWidth,
                isHighlighter: this.styleShapeHighlighter,
                ...(tool === "arrow" ? {
                    arrowStart: this.styleArrowSide === "start" || this.styleArrowSide === "both",
                    arrowEnd: this.styleArrowSide === "end" || this.styleArrowSide === "both",
                } : {}),
            } as LineObject | ArrowObject;
        }

        previewEl?.setAttribute("data-object-id", id);
        void this.saveNewObject(pageId, obj).then(() => this.selectObjectAfterCreation(pageId, id));
    }

    private cancelMultiPointDrawing(): void {
        this.multiPreviewEl?.remove();
        this.multiPoints = null;
        this.multiPreviewEl = null;
        this.multiPageId = null;
        this.multiSvg = null;
        this.lastMultiPointClickTime = 0;
        this.lastMultiPointClickPos = null;
    }

    // ============================================================
    //  TEXTBLÖCKE
    // ============================================================
    private startTextBlockDrag(evt: PointerEvent, svg: SVGSVGElement, pageId: string): void {
        evt.preventDefault();
        svg.setPointerCapture(evt.pointerId);
        this.textDragPointerId = evt.pointerId;
        this.textDragPageId = pageId;
        this.textDragStart = this.getSvgPoint(svg, evt);
        this.ui.closeAllDropdowns(); // Dropdown schließen bei Benutzung

        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("fill", "rgba(80, 140, 255, 0.12)");
        rect.setAttribute("stroke", "rgba(80, 140, 255, 0.8)");
        rect.setAttribute("stroke-dasharray", "4 3");
        svg.appendChild(rect);
        this.textDragPreviewEl = rect;
    }

    private continueTextBlockDrag(evt: PointerEvent, svg: SVGSVGElement): void {
        if (!this.textDragStart || !this.textDragPreviewEl) return;
        evt.preventDefault();
        const current = this.getSvgPoint(svg, evt);
        const x = Math.min(this.textDragStart.x, current.x);
        const y = Math.min(this.textDragStart.y, current.y);
        const width = Math.abs(current.x - this.textDragStart.x);
        const height = Math.max(20, Math.abs(current.y - this.textDragStart.y));
        const rect = this.textDragPreviewEl as SVGRectElement;
        rect.setAttribute("x", x.toString());
        rect.setAttribute("y", y.toString());
        rect.setAttribute("width", width.toString());
        rect.setAttribute("height", height.toString());
    }

    private async finishTextBlockDrag(evt: PointerEvent, svg: SVGSVGElement, pageId: string): Promise<void> {
        if (!this.textDragStart || !this.textDragPreviewEl) return;
        if (svg.hasPointerCapture(evt.pointerId)) svg.releasePointerCapture(evt.pointerId);

        const start = this.textDragStart;
        const current = this.getSvgPoint(svg, evt);
        const previewEl = this.textDragPreviewEl;

        this.textDragStart = null;
        this.textDragPreviewEl = null;
        this.textDragPageId = null;
        this.textDragPointerId = null;
        previewEl.remove();

        const width = Math.abs(current.x - start.x);
        const x = Math.min(start.x, current.x);
        const y = Math.min(start.y, current.y);
        const finalWidth = width < 20 ? 160 : width;

        const entry: TextBlockEntry = {
            id: crypto.randomUUID(),
            pageId,
            x, y,
            width: finalWidth,
            fontScale: 100,
            markdown: "",
        };

        // Neuer Block wird erst im Dateisystem gespeichert, wenn im Modal
        // tatsächlich Inhalt eingegeben und auf "Speichern" geklickt wird.
        await this.addPendingTextBlock(entry);
        this.openTextBlockEditor(entry, true);
    }

    private getPageDefinition(pageId: string): PageDefinition | undefined {
        return this.currentDocument?.pages.find(p => p.id === pageId);
    }

    /**
     * Kombiniert globalen Farbmodus, erkannte Original-Helligkeit der
     * Seite und eine eventuelle manuelle Umkehr (page.invert) zu einer
     * einzigen Entscheidung: soll diese Seite invertiert angezeigt werden?
     */
    private isPageInverted(page: PageDefinition): boolean {
        const manualOverride = page.invert === true;
        if (this.colorMode === "original") return manualOverride;

        const originalIsDark = this.pageIsDarkOriginal.get(page.id) ?? false;
        const wantsDark = this.colorMode === "dark";
        const baseInvert = wantsDark ? !originalIsDark : originalIsDark;
        return manualOverride ? !baseInvert : baseInvert;
    }

    private getDisplayColorForPage(pageId: string, storedColor: string): string {
        const page = this.getPageDefinition(pageId);
        const invert = page ? this.isPageInverted(page) : false;
        return resolveDisplayColor(storedColor, invert);
    }

    /** Öffentlich, damit PdfComposeUI (z. B. Verbindungslinien) Farben auflösen kann. */
    public getDisplayColor(pageId: string, storedColor: string): string {
        return this.getDisplayColorForPage(pageId, storedColor);
    }

    /** Wie getDisplayColorForPage - Textmarker werden inzwischen genau wie normale Striche behandelt (siehe toDisplayColors). */
    private getFreehandDisplayColor(pageId: string, color: string, highlighter: boolean): string {
        return this.getDisplayColorForPage(pageId, color);
    }

    private toDisplayColors(obj: VectorObject): VectorObject {
        const label: any = (obj as any).label;
        const invertedLabel = label ? { ...label, color: invertLightnessSafe(label.color ?? "#1a1a1a") } : undefined;
        switch (obj.type) {
            case "freehand":
                // Textmarker werden jetzt genau wie normale Striche behandelt:
                // Helligkeit invertieren, Farbton/Sättigung bleiben erhalten.
                return { ...obj, color: invertLightnessSafe(obj.color) };
            case "line":
            case "arrow":
                return { ...obj, color: invertLightnessSafe(obj.color), label: invertedLabel } as VectorObject;
            default:
                return {
                    ...obj,
                    strokeColor: invertLightnessSafe(obj.strokeColor),
                    fillColor: obj.fillColor ? invertLightnessSafe(obj.fillColor) : obj.fillColor,
                    label: invertedLabel,
                } as VectorObject;
        }
    }

    private getEffectiveScaleForPage(pageId: string): number {
        return this.pageScales.get(pageId) ?? 1;
    }

    private async renderTextBlocksForPage(pageId: string, scale: number): Promise<void> {
        const container = this.ui.textBlockLayers.get(pageId);
        if (!container || !this.currentFile) return;

        container.querySelectorAll("[data-textblock-id]").forEach(el => {
            const id = el.getAttribute("data-textblock-id");
            if (id) {
                this.textBlockComponents.get(id)?.unload();
                this.textBlockComponents.delete(id);
            }
        });
        container.empty();

        const page = this.getPageDefinition(pageId);
        const invert = page ? this.isPageInverted(page) : false;
        const originalIsDark = page ? (this.pageIsDarkOriginal.get(pageId) ?? false) : false;
        // effectiveDark = true  → Hintergrund ist dunkel  → Schrift soll hell sein
        // effectiveDark = false → Hintergrund ist hell    → Schrift soll dunkel sein
        const effectiveDark = invert ? !originalIsDark : originalIsDark;

        const entries = this.textBlocksCache.get(pageId) ?? [];
        for (const entry of entries) {
            const comp = new Component();
            comp.load();
            this.textBlockComponents.set(entry.id, comp);
            await this.ui.renderTextBlock(
                container,
                entry,
                scale,
                comp,
                this.currentFile.path,
                effectiveDark,
                {
                    onEdit: (e) => this.openTextBlockEditor(e),
                    onPositionDrag: (evt, e) => this.startTextBlockPositionDrag(evt, e),
                    onWidthDrag: (evt, e) => this.startTextBlockWidthDrag(evt, e),
                }
            );
        }
    }

    public async renderTextBlock(
        container: HTMLElement,
        entry: TextBlockEntry,
        scale: number,
        component: Component,
        sourcePath: string,
        invert: boolean,
        handlers: {
            onEdit: (entry: TextBlockEntry) => void;
            onPositionDrag: (evt: PointerEvent, entry: TextBlockEntry) => void;
            onWidthDrag: (evt: PointerEvent, entry: TextBlockEntry) => void;
        }
    ): Promise<void> {
        const block = container.createDiv({ cls: "pdfcompose-textblock" });
        block.setAttribute("data-textblock-id", entry.id);

        block.style.position = "absolute";
        block.style.left = (entry.x * scale) + "px";
        block.style.top = (entry.y * scale) + "px";
        block.style.width = (entry.width * scale) + "px";

        block.style.pointerEvents = "auto";
        block.style.zIndex = "21";

        const editBar = block.createDiv({
            cls: "pdfcompose-textblock-editbar"
        });

        editBar.style.pointerEvents = "auto";
        editBar.style.position = "relative";
        editBar.style.zIndex = "100";

        const editBtn = editBar.createEl("button", {
            text: "✎ Bearbeiten",
            cls: "pdfcompose-textblock-editbtn"
        });

        editBtn.style.pointerEvents = "auto";
        editBtn.style.position = "relative";
        editBtn.style.zIndex = "101";

        editBtn.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
        });

        editBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            handlers.onEdit(entry);
        });

        const posHandle = block.createDiv({ cls: "pdfcompose-textblock-handle pdfcompose-textblock-handle-pos" });
        posHandle.setAttribute("title", "Position verschieben");
        posHandle.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            handlers.onPositionDrag(e, entry);
        });

        const widthHandle = block.createDiv({ cls: "pdfcompose-textblock-handle pdfcompose-textblock-handle-width" });
        widthHandle.setAttribute("title", "Breite ändern");
        widthHandle.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            handlers.onWidthDrag(e, entry);
        });

        const zoomFactor = (entry.fontScale || 100) / 100;
        const inner = block.createDiv({ cls: "pdfcompose-textblock-inner" });
        inner.style.width = ((entry.width * scale) / zoomFactor) + "px";
        (inner.style as any).zoom = zoomFactor.toString();
        // Textfarbe an Hell-/Dunkelmodus bzw. Invertierung der Seite
        // anpassen, ohne die Markdown-Formatierung selbst zu überschreiben
        // (nur eine Vorgabe auf dem äußeren Container).
        inner.style.color = invert ? "#f2f2f2" : "";

        const markdown = entry.markdown.trim() ? entry.markdown : "*(leer – auf ✎ klicken zum Bearbeiten)*";
        await MarkdownRenderer.render(this.plugin.app, markdown, inner, sourcePath, component);
    }

    private async addPendingTextBlock(entry: TextBlockEntry): Promise<void> {
        const list = this.textBlocksCache.get(entry.pageId) ?? [];
        list.push(entry);
        this.textBlocksCache.set(entry.pageId, list);
        await this.renderTextBlocksForPage(entry.pageId, this.getEffectiveScaleForPage(entry.pageId));
    }

    private async discardPendingTextBlock(entry: TextBlockEntry): Promise<void> {
        const list = (this.textBlocksCache.get(entry.pageId) ?? []).filter(e => e.id !== entry.id);
        this.textBlocksCache.set(entry.pageId, list);
        await this.renderTextBlocksForPage(entry.pageId, this.getEffectiveScaleForPage(entry.pageId));
    }

    private startTextBlockPositionDrag(evt: PointerEvent, entry: TextBlockEntry): void {
        evt.preventDefault();
        const handleEl = evt.currentTarget as HTMLElement;
        const pointerId = evt.pointerId;
        try { handleEl.setPointerCapture(pointerId); } catch { /* ignore */ }

        const scale = this.getEffectiveScaleForPage(entry.pageId);
        const startX = evt.clientX;
        const startY = evt.clientY;
        const originX = entry.x;
        const originY = entry.y;
        const priorEntry: TextBlockEntry = { ...entry };
        const blockEl = handleEl.closest(".pdfcompose-textblock") as HTMLElement | null;

        const onMove = (ev: PointerEvent) => {
            ev.preventDefault();
            const dx = (ev.clientX - startX) / (scale * this.zoomLevel);
            const dy = (ev.clientY - startY) / (scale * this.zoomLevel);
            entry.x = originX + dx;
            entry.y = originY + dy;
            if (blockEl) {
                blockEl.style.left = (entry.x * scale) + "px";
                blockEl.style.top = (entry.y * scale) + "px";
            }
        };
        const onUp = async () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            if (handleEl.hasPointerCapture(pointerId)) {
                try { handleEl.releasePointerCapture(pointerId); } catch { /* ignore */ }
            }
            if (entry.x === priorEntry.x && entry.y === priorEntry.y) return;
            await this.commitTextBlockChange(entry, priorEntry);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }

    private async commitTextBlockChange(entry: TextBlockEntry, prior: TextBlockEntry): Promise<void> {
        const after: TextBlockEntry = { ...entry };
        await this.saveTextBlockRaw(entry);
        this.pushUndo({
            label: "textblock-transform",
            undo: async () => { await this.saveTextBlockRaw(prior); },
            redo: async () => { await this.saveTextBlockRaw(after); },
        });
    }

    private startTextBlockWidthDrag(evt: PointerEvent, entry: TextBlockEntry): void {
        evt.preventDefault();
        const handleEl = evt.currentTarget as HTMLElement;
        const pointerId = evt.pointerId;
        try { handleEl.setPointerCapture(pointerId); } catch { /* ignore */ }

        const scale = this.getEffectiveScaleForPage(entry.pageId);
        const startX = evt.clientX;
        const originWidth = entry.width;
        const priorEntry: TextBlockEntry = { ...entry };
        const zoomFactor = (entry.fontScale || 100) / 100;
        const blockEl = handleEl.closest(".pdfcompose-textblock") as HTMLElement | null;
        const innerEl = blockEl?.querySelector(".pdfcompose-textblock-inner") as HTMLElement | null;

        const onMove = (ev: PointerEvent) => {
            ev.preventDefault();
            const dx = (ev.clientX - startX) / (scale * this.zoomLevel);
            entry.width = Math.max(20, originWidth + dx);
            if (blockEl) blockEl.style.width = (entry.width * scale) + "px";
            if (innerEl) innerEl.style.width = ((entry.width * scale) / zoomFactor) + "px";
        };
        const onUp = async () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            if (handleEl.hasPointerCapture(pointerId)) {
                try { handleEl.releasePointerCapture(pointerId); } catch { /* ignore */ }
            }
            if (entry.width === priorEntry.width) return;
            await this.commitTextBlockChange(entry, priorEntry);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }

    private async saveTextBlockRaw(entry: TextBlockEntry): Promise<void> {
        await this.updateFileAtomic(
            (fm) => {
                if (!fm.textBlocks) fm.textBlocks = [];
                const idx = fm.textBlocks.findIndex((b: any) => b.id === entry.id);
                const meta = {
                    id: entry.id,
                    pageId: entry.pageId,
                    x: entry.x,
                    y: entry.y,
                    width: entry.width,
                    fontScale: entry.fontScale,
                };
                if (idx === -1) fm.textBlocks.push(meta);
                else fm.textBlocks[idx] = meta;
            },
            (body) => upsertTextBlock(body, entry)
        );
        // Cache aktualisieren
        const list = this.textBlocksCache.get(entry.pageId) || [];
        const idx = list.findIndex(b => b.id === entry.id);
        if (idx === -1) list.push(entry);
        else list[idx] = entry;
        this.textBlocksCache.set(entry.pageId, list);
        await this.renderTextBlocksForPage(entry.pageId, this.getEffectiveScaleForPage(entry.pageId));
    }

    private async saveTextBlock(entry: TextBlockEntry): Promise<void> {
        if (!entry.markdown.trim()) {
            await this.deleteTextBlock(entry);
            return;
        }
        if (!this.currentFile) return;

        const list = this.textBlocksCache.get(entry.pageId) ?? [];
        const idx = list.findIndex(e => e.id === entry.id);
        const prior: TextBlockEntry | null = idx === -1 ? null : { ...list[idx] };

        await this.saveTextBlockRaw(entry);

        this.pushUndo({
            label: "save-textblock",
            undo: async () => {
                if (prior) await this.saveTextBlockRaw(prior);
                else await this.deleteTextBlockRaw(entry);
            },
            redo: async () => { await this.saveTextBlockRaw(entry); },
        });
    }

    private async deleteTextBlockRaw(entry: TextBlockEntry): Promise<void> {
        await this.updateFileAtomic(
            (fm) => {
                if (fm.textBlocks) {
                    fm.textBlocks = fm.textBlocks.filter((b: any) => b.id !== entry.id);
                }
            },
            (body) => removeTextBlock(body, entry.id)
        );
        // Cache aktualisieren
        const list = (this.textBlocksCache.get(entry.pageId) || []).filter(b => b.id !== entry.id);
        this.textBlocksCache.set(entry.pageId, list);
        await this.renderTextBlocksForPage(entry.pageId, this.getEffectiveScaleForPage(entry.pageId));
    }

    private async deleteTextBlock(entry: TextBlockEntry): Promise<void> {
        const list = this.textBlocksCache.get(entry.pageId) ?? [];
        const existing = list.find(e => e.id === entry.id) ?? entry;
        const wasPersisted = existing.markdown.trim().length > 0;

        await this.deleteTextBlockRaw(entry);

        if (!wasPersisted) return; // war nie gespeichert -> nichts sinnvoll rückgängig zu machen
        this.pushUndo({
            label: "delete-textblock",
            undo: async () => { await this.saveTextBlockRaw(existing); },
            redo: async () => { await this.deleteTextBlockRaw(existing); },
        });
    }

    private async createTextBlock(entry: TextBlockEntry): Promise<void> {
        if (!entry.markdown.trim()) {
            // Nichts eingegeben -> wie Abbrechen behandeln, nichts wird persistiert.
            await this.discardPendingTextBlock(entry);
            return;
        }
        await this.saveTextBlockRaw(entry);
        this.pushUndo({
            label: "create-textblock",
            undo: async () => { await this.deleteTextBlockRaw(entry); },
            redo: async () => { await this.saveTextBlockRaw(entry); },
        });
    }

    private openTextBlockEditor(entry: TextBlockEntry, isNew: boolean = false): void {
        new TextBlockEditModal(this.app, entry, {
            onSave: async (updated) => {
                await this.saveTextBlock(updated);
            },

            onCopy: async () => {
                // Die aktuelle Auswahl (nur dieser Block) kopieren
                // Dazu den Block in die Auswahl setzen und copySelection aufrufen.
                this.selectedIds.clear();
                this.selectedTextBlockIds.clear();
                this.selectedPdfAnnotationIds.clear();
                this.selectionPageId = entry.pageId;
                this.selectedTextBlockIds.add(entry.id);
                await this.copySelection();
                new Notice("Textblock kopiert");
            },

            onDelete: async () => {
                await this.deleteTextBlock(entry);
            },

            onCancel: isNew
                ? async () => {
                    await this.discardPendingTextBlock(entry);
                }
                : undefined,
        }).open();
    }

    // ============================================================
    //  RADIERER
    // ============================================================
    private freehandHitTest(obj: FreehandObject, samples: { x: number; y: number }[], threshold: number): boolean {
        const pts = obj.points;
        if (pts.length === 0) return false;

        let bounds = this.eraseBoundsCache.get(obj);
        if (!bounds) {
            bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
            for (const p of pts) {
                if (p.x < bounds.minX) bounds.minX = p.x;
                if (p.x > bounds.maxX) bounds.maxX = p.x;
                if (p.y < bounds.minY) bounds.minY = p.y;
                if (p.y > bounds.maxY) bounds.maxY = p.y;
            }
            this.eraseBoundsCache.set(obj, bounds);
        }
        const b = bounds;
        const reach = threshold + obj.strokeWidth / 2;
        const near = samples.filter(s =>
            s.x >= b.minX - reach && s.x <= b.maxX + reach &&
            s.y >= b.minY - reach && s.y <= b.maxY + reach);
        if (near.length === 0) return false;

        if (pts.length === 1) {
            return near.some(s => Math.hypot(s.x - pts[0].x, s.y - pts[0].y) <= reach);
        }
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], c = pts[i + 1];
            const minX = Math.min(a.x, c.x) - reach, maxX = Math.max(a.x, c.x) + reach;
            const minY = Math.min(a.y, c.y) - reach, maxY = Math.max(a.y, c.y) + reach;
            for (const s of near) {
                if (s.x < minX || s.x > maxX || s.y < minY || s.y > maxY) continue;
                if (this.distancePointToSegment(s, a, c) <= reach) return true;
            }
        }
        return false;
    }

    private eraseAtEvent(evt: PointerEvent, svg: SVGSVGElement, pageId: string): void {
        const point = this.getSvgPoint(svg, evt);
        const threshold = evt.pointerType === "touch" ? 14 : 6;

        const samplePoints: { x: number; y: number }[] = [];
        if (this.lastErasePoint) {
            const dx = point.x - this.lastErasePoint.x;
            const dy = point.y - this.lastErasePoint.y;
            const dist = Math.hypot(dx, dy);
            const step = threshold / 2;
            const steps = Math.floor(dist / step);
            for (let i = 1; i < steps; i++) {
                const t = (i * step) / dist;
                samplePoints.push({
                    x: this.lastErasePoint.x + dx * t,
                    y: this.lastErasePoint.y + dy * t,
                });
            }
        }
        samplePoints.push(point);
        this.lastErasePoint = point;

        const objects = this.getPageAnnotations(pageId);
        for (const obj of objects) {
            if (this.pendingEraseIds.has(obj.id) || !this.isEraseTargetEnabled(obj)) continue;

            let hit = false;
            try {
                if (obj.type === "freehand") {
                    hit = this.freehandHitTest(obj, samplePoints, threshold);
                } else {
                    const el = this.ui.findObjectElementById(pageId, obj.id);
                    hit = !!el && samplePoints.some(p => this.elementHitTest(el, p, threshold));
                }
            } catch (e) {
                console.warn("PdfCompose: Radierer-Trefftest fehlgeschlagen, Objekt übersprungen", obj.id, e);
            }
            if (!hit) continue;

            this.pendingEraseIds.add(obj.id);
            for (const layer of this.ui.getObjectLayers(pageId)) {
                layer.querySelectorAll<SVGElement>(`[data-object-id="${obj.id}"]`)
                    .forEach(el => { el.style.opacity = "0.25"; });
            }
        }

        if (this.eraserTargets.annotations) {
            const highlightSvg = this.ui.highlightLayers.get(pageId);
            highlightSvg?.querySelectorAll<SVGGraphicsElement>("[data-pdf-annotation-id]").forEach((el) => {
                const annotId = el.getAttribute("data-pdf-annotation-id");
                if (!annotId || this.pendingEraseAnnotationIds.has(annotId)) return;
                let hit = false;
                try {
                    hit = samplePoints.some(p => this.elementHitTest(el, p, threshold));
                } catch { /* ignore */ }
                if (hit) {
                    this.pendingEraseAnnotationIds.add(annotId);
                    el.style.opacity = "0.35";
                }
            });
        }

        if (this.eraserTargets.textBlocks) {
            const textBlockLayer = this.ui.textBlockLayers.get(pageId);
            if (textBlockLayer) {
                textBlockLayer.querySelectorAll<HTMLElement>(".pdfcompose-textblock").forEach((el) => {
                    const id = el.getAttribute("data-textblock-id");
                    if (!id || this.pendingEraseTextBlockIds.has(id)) return;
                    if (samplePoints.some(p => this.elementHitTestTextBlock(el, p, threshold))) {
                        this.pendingEraseTextBlockIds.add(id);
                        el.style.opacity = "0.35";
                    }
                });
            }
        }
    }

    private elementHitTestTextBlock(el: HTMLElement, point: { x: number; y: number }, threshold: number): boolean {
        const rect = el.getBoundingClientRect();
        const wrapperRect = el.parentElement?.parentElement?.getBoundingClientRect(); // relativ zur Seite
        if (!wrapperRect) return false;
        const x = (rect.left - wrapperRect.left) / this.zoomLevel;
        const y = (rect.top - wrapperRect.top) / this.zoomLevel;
        const w = rect.width / this.zoomLevel;
        const h = rect.height / this.zoomLevel;
        return point.x >= x - threshold && point.x <= x + w + threshold &&
            point.y >= y - threshold && point.y <= y + h + threshold;
    }

    /**
     * Ordnet einen Objekttyp einer Radiergummi-Kategorie zu. "annotation" ist
     * für die künftigen PDF-Textmarkierungen reserviert (noch keine
     * VectorObject-Instanzen dieser Art vorhanden).
     */
    private isEraseTargetEnabled(obj: VectorObject): boolean {
        if (obj.type === "freehand") {
            if (obj.highlighter) {
                return this.eraserTargets.highlighters;
            }
            return this.eraserTargets.strokes;
        }
        // alle anderen Formen (Polygon, Rechteck, etc.)
        return this.eraserTargets.shapes;
    }

    private async commitErase(pageId: string): Promise<void> {
        // Vektor-Objekte löschen
        if (this.pendingEraseIds.size > 0) {
            const idsToRemove = new Set(this.pendingEraseIds);
            this.pendingEraseIds.clear();
            await this.deleteAnnotationObjects(pageId, idsToRemove);

            for (const id of idsToRemove) {
                const labelEntry = (this.shapeLabelsCache.get(pageId) ?? []).find((s) => s.shapeId === id);
                if (labelEntry) await this.deleteShapeLabelRaw(labelEntry.id, pageId);
            }
        }

        // PDF-Annotationen löschen
        if (this.pendingEraseAnnotationIds.size > 0) {
            const annotIds = new Set(this.pendingEraseAnnotationIds);
            this.pendingEraseAnnotationIds.clear();
            for (const id of annotIds) {
                const entry = (this.pdfAnnotationsCache.get(pageId) ?? []).find((e) => e.id === id);
                if (entry) await this.deletePdfAnnotation(entry);
            }
        }

        // Textblöcke löschen
        if (this.pendingEraseTextBlockIds.size > 0) {
            const idsToRemove = new Set(this.pendingEraseTextBlockIds);
            this.pendingEraseTextBlockIds.clear();
            // Alle Textblöcke dieser Seite aus dem Cache holen
            const blocks = this.textBlocksCache.get(pageId) ?? [];
            const toRemove = blocks.filter(b => idsToRemove.has(b.id));
            if (toRemove.length > 0) {
                // Zustand für Undo sichern
                const removedCopy = toRemove.map(b => ({ ...b }));
                await this.deleteTextBlocksRaw(pageId, idsToRemove);
                // Undo-Befehl
                this.pushUndo({
                    label: "erase-textblocks",
                    undo: async () => {
                        for (const b of removedCopy) {
                            await this.saveTextBlockRaw(b);
                        }
                    },
                    redo: async () => {
                        await this.deleteTextBlocksRaw(pageId, new Set(removedCopy.map(b => b.id)));
                    }
                });
            }
        }
    }

    private async deleteTextBlocksRaw(pageId: string, ids: Set<string>): Promise<void> {
        if (ids.size === 0) return;
        await this.updateFileAtomic(
            (fm) => {
                if (fm.textBlocks) {
                    fm.textBlocks = fm.textBlocks.filter((b: any) => !ids.has(b.id));
                }
            },
            (body) => {
                let content = body;
                for (const id of ids) {
                    content = removeTextBlock(content, id);
                }
                return content;
            }
        );
        // Cache aktualisieren
        const list = (this.textBlocksCache.get(pageId) || []).filter(b => !ids.has(b.id));
        this.textBlocksCache.set(pageId, list);
        await this.renderTextBlocksForPage(pageId, this.getEffectiveScaleForPage(pageId));
    }

    // ============================================================
    //  AUSWAHL
    // ============================================================
    /** Verhindert, dass ein über die eigene Seite hinausgezogenes Element
 *  hinter nachfolgenden Seiten verschwindet bzw. an der Seitengrenze
 *  "hängen bleibt". Bewusst OHNE position:absolute (das führte je nach
 *  unbekanntem offsetParent zu uneinheitlichem Verhalten) - Flex-Items
 *  respektieren z-index bereits ohne gesetztes "position". */
    private elevatePageForDrag(pageId: string): void {
        if (this.elevatedDragPageId === pageId) return;
        this.resetElevatedPageForDrag();

        const pageEl = this.ui.pagesContentEl.querySelector<HTMLElement>(`[data-page-id="${pageId}"]`);
        if (!pageEl) return;

        const elementsToAdjust: HTMLElement[] = [pageEl];
        const bodyEl = pageEl.querySelector<HTMLElement>(".pdfcompose-page-body");
        if (bodyEl) elementsToAdjust.push(bodyEl);
        const wrapperEl = pageEl.querySelector<HTMLElement>(".pdfcompose-page-wrapper");
        if (wrapperEl) elementsToAdjust.push(wrapperEl);

        const originalStyles = new Map<HTMLElement, { zIndex: string; overflow: string }>();
        for (const el of elementsToAdjust) {
            originalStyles.set(el, { zIndex: el.style.zIndex, overflow: el.style.overflow });
            el.style.overflow = "visible";
        }
        pageEl.style.zIndex = "500";

        const svgOriginalOverflow = new Map<SVGSVGElement, string>();
        const annotSvg = this.ui.annotationLayers.get(pageId);
        const highlightSvg = this.ui.highlightLayers.get(pageId);
        for (const svg of [annotSvg, highlightSvg]) {
            if (!svg) continue;
            svgOriginalOverflow.set(svg, svg.style.overflow);
            svg.style.overflow = "visible";
        }

        this.elevatedDragPageId = pageId;
        this.elevatedDragOriginalStyles = originalStyles;
        this.elevatedDragOriginalSvgStyles = svgOriginalOverflow;
    }

    private resetElevatedPageForDrag(): void {
        if (!this.elevatedDragPageId) return;

        if (this.elevatedDragOriginalStyles) {
            for (const [el, style] of this.elevatedDragOriginalStyles) {
                el.style.zIndex = style.zIndex;
                el.style.overflow = style.overflow;
            }
        }
        if (this.elevatedDragOriginalSvgStyles) {
            for (const [svg, overflow] of this.elevatedDragOriginalSvgStyles) {
                svg.style.overflow = overflow;
            }
        }

        this.elevatedDragOriginalStyles = null;
        this.elevatedDragOriginalSvgStyles = null;
        this.elevatedDragPageId = null;
    }

    private startSelectionInteraction(evt: PointerEvent, svg: SVGSVGElement, pageId: string): void {
        evt.preventDefault();
        const point = this.getSvgPoint(svg, evt);
        this.ui.closeAllDropdowns();

        if (this.selectionPageId && this.selectionPageId !== pageId) {
            this.clearSelection();
        }
        this.selectionPageId = pageId;

        const hit = this.findTopmostObjectAt(pageId, point);
        const hitId = hit?.getAttribute("data-object-id") ?? null;

        const pointHitsSelectedTextBlock = this.pointHitsAnySelectedTextBlock(pageId, point);
        const pointHitsSelectedVector = hitId && this.selectedIds.has(hitId);

        if (pointHitsSelectedVector || pointHitsSelectedTextBlock) {
            svg.setPointerCapture(evt.pointerId);
            this.selectionPointerId = evt.pointerId;
            this.isMovingSelection = true;
            this.elevatePageForDrag(pageId);
            this.moveOrigin = point;
            this.moveSnapshot = this.snapshotSelection(pageId);

            this.moveSelectionOriginalTransforms.clear();
            for (const id of this.selectedIds) {
                const el = this.ui.findObjectElementById(pageId, id);
                if (el) this.moveSelectionOriginalTransforms.set(id, el.getAttribute("transform") ?? "");
            }
            return;
        }

        svg.setPointerCapture(evt.pointerId);
        this.selectionPointerId = evt.pointerId;
        this.isMovingSelection = false;
        this.selectionDragStart = point;

        if (this.currentTool === "select-lasso") {
            this.lassoPoints = [point];
            const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
            poly.classList.add("pdfcompose-selection-preview");
            svg.appendChild(poly);
            this.selectionPreviewEl = poly;
        } else {
            const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.classList.add("pdfcompose-selection-preview");
            svg.appendChild(rect);
            this.selectionPreviewEl = rect;
        }
    }

    /** Scrollt den Seitencontainer automatisch, wenn der Zeiger beim
 *  Verschieben einer Auswahl nahe an den Rand des sichtbaren Bereichs
 *  kommt - ohne das wirkt ein Drag über den Rand hinaus wie "hängen-
 *  geblieben", solange die Zielseite noch nicht sichtbar/gemountet ist. */
    private autoScrollDuringSelectionMove(clientX: number, clientY: number): void {
        const container = this.ui.pagesContainerEl;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const margin = 48;
        const horizontal = this.plugin.settings.horizontalLayout;

        if (horizontal) {
            const distFromLeft = clientX - rect.left;
            const distFromRight = rect.right - clientX;
            if (distFromLeft < margin) container.scrollLeft -= Math.max(2, (margin - distFromLeft) / 2);
            else if (distFromRight < margin) container.scrollLeft += Math.max(2, (margin - distFromRight) / 2);
        } else {
            const distFromTop = clientY - rect.top;
            const distFromBottom = rect.bottom - clientY;
            if (distFromTop < margin) container.scrollTop -= Math.max(2, (margin - distFromTop) / 2);
            else if (distFromBottom < margin) container.scrollTop += Math.max(2, (margin - distFromBottom) / 2);
        }
    }

    private continueSelectionInteraction(evt: PointerEvent, svg: SVGSVGElement, pageId: string): void {
        if (this.selectionPageId !== pageId) return;
        const point = this.getSvgPoint(svg, evt);

        if (this.isMovingSelection && this.moveOrigin && this.moveSnapshot) {
            evt.preventDefault();
            const dx = point.x - this.moveOrigin.x;
            const dy = point.y - this.moveOrigin.y;
            this.previewMoveSelection(pageId, dx, dy);

            const targetPageId = this.getPageIdAtScreenPosition(evt.clientX, evt.clientY);
            this.setCrossPageTargetHighlight(targetPageId && targetPageId !== pageId ? targetPageId : null);
            this.autoScrollDuringSelectionMove(evt.clientX, evt.clientY);
            return;
        }

        if (!this.selectionDragStart || !this.selectionPreviewEl) return;
        evt.preventDefault();

        if (this.currentTool === "select-lasso" && this.lassoPoints) {
            this.lassoPoints.push(point);
            (this.selectionPreviewEl as SVGPolygonElement).setAttribute(
                "points", this.lassoPoints.map(p => `${p.x},${p.y}`).join(" ")
            );
        } else {
            const x = Math.min(this.selectionDragStart.x, point.x);
            const y = Math.min(this.selectionDragStart.y, point.y);
            const w = Math.abs(point.x - this.selectionDragStart.x);
            const h = Math.abs(point.y - this.selectionDragStart.y);
            const rect = this.selectionPreviewEl as SVGRectElement;
            rect.setAttribute("x", x.toString());
            rect.setAttribute("y", y.toString());
            rect.setAttribute("width", w.toString());
            rect.setAttribute("height", h.toString());
        }
    }

    private async finishSelectionInteraction(evt: PointerEvent, svg: SVGSVGElement, pageId: string): Promise<void> {
        if (svg.hasPointerCapture(evt.pointerId)) svg.releasePointerCapture(evt.pointerId);
        this.selectionPointerId = null;

        if (this.isMovingSelection && this.moveOrigin && this.moveSnapshot) {
            const point = this.getSvgPoint(svg, evt);
            const dx = point.x - this.moveOrigin.x;
            const dy = point.y - this.moveOrigin.y;
            const origin = this.moveOrigin;
            const snapshot = this.moveSnapshot;
            this.isMovingSelection = false;
            this.moveOrigin = null;
            this.moveSnapshot = null;
            this.moveSelectionOriginalTransforms.clear();
            this.resetElevatedPageForDrag();

            const targetPageId = this.getPageIdAtScreenPosition(evt.clientX, evt.clientY);
            this.setCrossPageTargetHighlight(null);

            if (targetPageId && targetPageId !== pageId) {
                await this.commitCrossPageMove(pageId, targetPageId, snapshot!, origin!, evt);
            } else if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                await this.commitMoveSelection(pageId, snapshot!, dx, dy);
            } else {
                await this.redrawPageFromCache(pageId);
            }
            return;
        }

        const start = this.selectionDragStart;
        const previewEl = this.selectionPreviewEl;
        const lasso = this.lassoPoints;
        this.selectionDragStart = null;
        this.selectionPreviewEl = null;
        this.lassoPoints = null;
        previewEl?.remove();

        if (!start) return;
        const point = this.getSvgPoint(svg, evt);
        const moved = Math.hypot(point.x - start.x, point.y - start.y);
        const extend = evt.ctrlKey || evt.metaKey;

        if (moved < 3) {
            const hit = this.findTopmostObjectAt(pageId, point);
            const hitId = hit?.getAttribute("data-object-id") ?? null;
            if (!extend) this.selectedIds.clear();
            if (hitId) {
                if (extend && this.selectedIds.has(hitId)) this.selectedIds.delete(hitId);
                else if (hitId) this.selectedIds.add(hitId);
            }
        } else {
            const matchedVectors = this.currentTool === "select-lasso" && lasso
                ? this.selectObjectsInLasso(pageId, lasso)
                : this.selectObjectsInRect(pageId, start, point);
            if (!extend) {
                this.selectedIds.clear();
                this.selectedTextBlockIds.clear();
                this.selectedPdfAnnotationIds.clear();
            }
            for (const id of matchedVectors) this.selectedIds.add(id);

            if (this.selectionTargets.textBlocks) {
                const textIds = this.currentTool === "select-lasso" && lasso
                    ? this.selectTextBlocksInLasso(pageId, lasso)
                    : this.selectTextBlocksInRect(pageId, start, point);
                for (const id of textIds) this.selectedTextBlockIds.add(id);
            }
            if (this.selectionTargets.annotations) {
                const annotIds = this.currentTool === "select-lasso" && lasso
                    ? this.selectPdfAnnotationsInLasso(pageId, lasso)
                    : this.selectPdfAnnotationsInRect(pageId, start, point);
                for (const id of annotIds) this.selectedPdfAnnotationIds.add(id);
            }
        }

        this.ui.updateSelectionHighlight(pageId, this.selectedIds, this.selectedTextBlockIds, this.selectedPdfAnnotationIds);
        this.renderAnnotationPanel();
        this.updateActionButtonsState();
        await this.renderSelectionHandles();
    }

    private async commitCrossPageMove(
        sourcePageId: string,
        targetPageId: string,
        snapshot: Map<string, VectorObject>,
        pointerStartSource: { x: number; y: number },
        evt: PointerEvent
    ): Promise<void> {
        const sourceSvg = this.ui.annotationLayers.get(sourcePageId);
        const targetSvg = this.ui.annotationLayers.get(targetPageId);
        if (!sourceSvg || !targetSvg) return;

        const srcRect = sourceSvg.getBoundingClientRect();
        const tgtRect = targetSvg.getBoundingClientRect();
        const srcVb = sourceSvg.getAttribute("viewBox")?.split(/\s+/).map(Number);
        const tgtVb = targetSvg.getAttribute("viewBox")?.split(/\s+/).map(Number);
        if (!srcVb || !tgtVb) return;

        const srcW = srcVb[2], srcH = srcVb[3];
        const tgtW = tgtVb[2], tgtH = tgtVb[3];

        const px = evt.clientX, py = evt.clientY;
        const ptrStartScreenX = srcRect.left + (pointerStartSource.x / srcW) * srcRect.width;
        const ptrStartScreenY = srcRect.top + (pointerStartSource.y / srcH) * srcRect.height;
        const dxScreen = px - ptrStartScreenX;
        const dyScreen = py - ptrStartScreenY;

        // --- Vektorobjekte ---
        const sourceObjects = this.getPageAnnotations(sourcePageId);
        const targetObjects = this.getPageAnnotations(targetPageId);
        const moveIds = new Set(snapshot.keys());

        const translated: VectorObject[] = [];
        for (const [id, obj] of snapshot) {
            const pts = this.getObjectPoints(obj);
            const minX = Math.min(...pts.map((p) => p.x));
            const minY = Math.min(...pts.map((p) => p.y));

            const objStartScreenX = srcRect.left + (minX / srcW) * srcRect.width;
            const objStartScreenY = srcRect.top + (minY / srcH) * srcRect.height;
            const objEndScreenX = objStartScreenX + dxScreen;
            const objEndScreenY = objStartScreenY + dyScreen;

            const txMinX = ((objEndScreenX - tgtRect.left) / tgtRect.width) * tgtW;
            const tyMinY = ((objEndScreenY - tgtRect.top) / tgtRect.height) * tgtH;

            translated.push(this.translateObject(obj, txMinX - minX, tyMinY - minY));
        }

        const remainingSource = sourceObjects.filter((o) => !moveIds.has(o.id));
        const newTargetObjects = [...targetObjects, ...translated];

        // --- Textblöcke ---
        const sourceBlocks = this.textBlocksCache.get(sourcePageId) ?? [];
        const selectedBlocks = sourceBlocks.filter((b) => this.selectedTextBlockIds.has(b.id));
        const remainingSourceBlocks = sourceBlocks.filter((b) => !this.selectedTextBlockIds.has(b.id));
        const translatedBlocks: TextBlockEntry[] = [];

        for (const block of selectedBlocks) {
            // Referenzpunkt: linke obere Ecke des Blocks auf dem Quell-Canvas
            const blockStartScreenX = srcRect.left + (block.x / srcW) * srcRect.width;
            const blockStartScreenY = srcRect.top + (block.y / srcH) * srcRect.height;
            const blockEndScreenX = blockStartScreenX + dxScreen;
            const blockEndScreenY = blockStartScreenY + dyScreen;

            const newX = ((blockEndScreenX - tgtRect.left) / tgtRect.width) * tgtW;
            const newY = ((blockEndScreenY - tgtRect.top) / tgtRect.height) * tgtH;

            translatedBlocks.push({
                ...block,
                pageId: targetPageId,
                x: newX,
                y: newY,
            });
        }

        // Zielseiten-Textblöcke ggf. anlegen / erweitern
        const targetBlocks = this.textBlocksCache.get(targetPageId) ?? [];
        const newTargetBlocks = [...targetBlocks, ...translatedBlocks];

        // Persistieren: zuerst Quellseite bereinigen, dann Zielseite schreiben.
        // Hinweis: setPageAnnotations ruft intern redrawPageFromCache auf, was
        // bei noch nicht montierten Seiten ein No-Op ist - kein Problem.
        await this.setPageAnnotations(sourcePageId, remainingSource);
        await this.setPageAnnotations(targetPageId, newTargetObjects);

        for (const b of selectedBlocks) {
            await this.deleteTextBlockRaw(b);
        }
        for (const b of translatedBlocks) {
            await this.saveTextBlockRaw(b);
        }

        // Caches aktualisieren
        this.textBlocksCache.set(sourcePageId, remainingSourceBlocks);

        // Auswahl auf die Zielseite mitnehmen
        this.selectionPageId = targetPageId;
        this.selectedIds = new Set(translated.map((o) => o.id));
        this.selectedTextBlockIds = new Set(translatedBlocks.map((b) => b.id));
        this.ui.updateSelectionHighlight(sourcePageId, new Set(), new Set(), new Set());
        this.ui.updateSelectionHighlight(targetPageId, this.selectedIds, this.selectedTextBlockIds, new Set());
        await this.renderSelectionHandles();

        const sourceBefore = sourceObjects;
        const targetBefore = targetObjects;
        const sourceAfter = remainingSource;
        const targetAfter = newTargetObjects;
        const blocksSourceBefore = selectedBlocks.map(b => ({ ...b }));
        const blocksTargetAfter = translatedBlocks.map(b => ({ ...b }));

        this.pushUndo({
            label: "cross-page-move",
            undo: async () => {
                await this.setPageAnnotations(sourcePageId, sourceBefore);
                await this.setPageAnnotations(targetPageId, targetBefore);
                for (const b of blocksTargetAfter) await this.deleteTextBlockRaw(b);
                for (const b of blocksSourceBefore) await this.saveTextBlockRaw(b);
            },
            redo: async () => {
                await this.setPageAnnotations(sourcePageId, sourceAfter);
                await this.setPageAnnotations(targetPageId, targetAfter);
                for (const b of blocksSourceBefore) await this.deleteTextBlockRaw(b);
                for (const b of blocksTargetAfter) await this.saveTextBlockRaw(b);
            },
        });

        const movedCount = translated.length + translatedBlocks.length;
        if (movedCount > 0) {
            new Notice(`${movedCount} element(s) moved to target page.`);
        }
    }

    private clearSelection(): void {
        this.selectionDragStart = null;
        this.selectionPreviewEl?.remove();
        this.selectionPreviewEl = null;
        this.lassoPoints = null;
        this.isMovingSelection = false;
        this.moveOrigin = null;
        this.moveSnapshot = null;
        this.selectionPointerId = null;
        this.selectedIds.clear();
        this.selectionPageId = null;
        this.selectedTextBlockIds.clear();
        this.selectedPdfAnnotationIds.clear();

        for (const [pageId, svg] of this.ui.annotationLayers.entries()) {
            this.ui.updateSelectionHighlight(pageId, this.selectedIds, this.selectedTextBlockIds, this.selectedPdfAnnotationIds);
            svg.querySelector(".pdfcompose-selection-handles")?.remove();
        }
        this.ui.selectionHandlesGroup = null;

        if (this.styleWriteDebounceTimer !== null) {
            window.clearTimeout(this.styleWriteDebounceTimer);
            this.styleWriteDebounceTimer = null;
        }
        this.pendingStylePatch = null;
        this.renderAnnotationPanel();
    }

    private selectObjectsInRect(pageId: string, a: { x: number; y: number }, b: { x: number; y: number }): string[] {
        const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
        const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
        const result: string[] = [];
        const objects = this.getPageAnnotations(pageId);
        const objectsById = new Map(objects.map(o => [o.id, o]));

        for (const el of this.ui.queryAllObjectElements(pageId)) {
            const bbox = this.getVisualBounds(el);

            const intersects =
                bbox.x < maxX &&
                bbox.x + bbox.width > minX &&
                bbox.y < maxY &&
                bbox.y + bbox.height > minY;

            const contained =
                bbox.x >= minX &&
                bbox.x + bbox.width <= maxX &&
                bbox.y >= minY &&
                bbox.y + bbox.height <= maxY;

            const matches = this.selectionMode === "touch" ? intersects : contained;

            if (matches) {
                const id = el.getAttribute("data-object-id");
                if (id) {
                    const obj = objectsById.get(id);
                    if (obj && this.isObjectSelectable(obj)) {
                        result.push(id);
                    }
                }
            }
        }
        return result;
    }

    /** Liefert die tatsächlich sichtbare Bounding-Box eines SVG-Elements in Seiten-Koordinaten (berücksichtigt transform-Attribute). */
    private getVisualBounds(el: SVGGraphicsElement): { x: number; y: number; width: number; height: number } {
        const bbox = el.getBBox();
        const svgRoot = el.ownerSVGElement;
        if (!svgRoot) return bbox;
        const elCTM = el.getCTM();
        const rootCTM = svgRoot.getCTM();
        if (!elCTM || !rootCTM) return bbox;

        try {
            const toViewBox = rootCTM.inverse().multiply(elCTM);
            const corners = [
                { x: bbox.x, y: bbox.y },
                { x: bbox.x + bbox.width, y: bbox.y },
                { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
                { x: bbox.x, y: bbox.y + bbox.height },
            ];
            const transformed = corners.map(p => {
                const pt = svgRoot.createSVGPoint();
                pt.x = p.x;
                pt.y = p.y;
                return pt.matrixTransform(toViewBox);
            });
            const xs = transformed.map(p => p.x);
            const ys = transformed.map(p => p.y);
            const minX = Math.min(...xs), minY = Math.min(...ys);
            const maxX = Math.max(...xs), maxY = Math.max(...ys);
            return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        } catch {
            // Entartete (nicht invertierbare) Matrix, z. B. während eines
            // Mount-/Unmount-Übergangs durch Scrollen - unskalierte bbox
            // als Fallback statt die ganze Auswahl-Interaktion abzubrechen.
            return bbox;
        }
    }

    /** Wählt ein soeben erstelltes Objekt aus und zeigt dessen Handles/Panel-Einstellungen. */
    private async selectObjectAfterCreation(pageId: string, objectId: string): Promise<void> {
        this.selectionPageId = pageId;
        this.selectedIds.clear();
        this.selectedIds.add(objectId);
        this.selectedTextBlockIds.clear();
        this.selectedPdfAnnotationIds.clear();
        this.ui.updateSelectionHighlight(pageId, this.selectedIds, this.selectedTextBlockIds, this.selectedPdfAnnotationIds);
        this.renderAnnotationPanel();
        this.updateActionButtonsState();
        await this.renderSelectionHandles();
    }

    private selectTextBlocksInRect(pageId: string, a: { x: number, y: number }, b: { x: number, y: number }): string[] {
        const layer = this.ui.textBlockLayers.get(pageId);
        if (!layer) return [];
        const ids: string[] = [];
        const wrapper = layer.closest('.pdfcompose-page-wrapper');
        if (!wrapper) return ids;
        const wrapperRect = wrapper.getBoundingClientRect();
        const scale = this.getEffectiveScaleForPage(pageId);
        const textBlockElements = Array.from(layer.querySelectorAll<HTMLElement>('.pdfcompose-textblock'));
        for (const el of textBlockElements) {
            const id = el.getAttribute('data-textblock-id');
            if (!id) continue;
            const rect = el.getBoundingClientRect();
            const x = (rect.left - wrapperRect.left) / (scale * this.zoomLevel);
            const y = (rect.top - wrapperRect.top) / (scale * this.zoomLevel);
            const w = rect.width / (scale * this.zoomLevel);
            const h = rect.height / (scale * this.zoomLevel);
            const intersects = x < Math.max(a.x, b.x) && x + w > Math.min(a.x, b.x) &&
                y < Math.max(a.y, b.y) && y + h > Math.min(a.y, b.y);
            const contained = x >= Math.min(a.x, b.x) && x + w <= Math.max(a.x, b.x) &&
                y >= Math.min(a.y, b.y) && y + h <= Math.max(a.y, b.y);
            const matches = this.selectionMode === "touch" ? intersects : contained;
            if (matches) ids.push(id);
        }
        return ids;
    }

    private selectPdfAnnotationsInRect(pageId: string, a: { x: number, y: number }, b: { x: number, y: number }): string[] {
        const layer = this.ui.highlightLayers.get(pageId);
        if (!layer) return [];
        const ids = new Set<string>();
        const rects = Array.from(layer.querySelectorAll<SVGRectElement>('[data-pdf-annotation-id]'));
        for (const rectEl of rects) {
            const id = rectEl.getAttribute('data-pdf-annotation-id');
            if (!id) continue;
            const x = parseFloat(rectEl.getAttribute('x') || '0');
            const y = parseFloat(rectEl.getAttribute('y') || '0');
            const w = parseFloat(rectEl.getAttribute('width') || '0');
            const h = parseFloat(rectEl.getAttribute('height') || '0');
            const intersects = x < Math.max(a.x, b.x) && x + w > Math.min(a.x, b.x) &&
                y < Math.max(a.y, b.y) && y + h > Math.min(a.y, b.y);
            const contained = x >= Math.min(a.x, b.x) && x + w <= Math.max(a.x, b.x) &&
                y >= Math.min(a.y, b.y) && y + h <= Math.max(a.y, b.y);
            const matches = this.selectionMode === "touch" ? intersects : contained;
            if (matches) ids.add(id);
        }
        return Array.from(ids);
    }

    private selectObjectsInLasso(pageId: string, lasso: { x: number; y: number }[]): string[] {
        const result: string[] = [];
        for (const el of this.ui.queryAllObjectElements(pageId)) {
            const samples = this.sampleElementPoints(el);
            const insideFlags = samples.map(p => this.pointInPolygon(p, lasso));
            const matches = this.selectionMode === "touch"
                ? insideFlags.some(f => f)
                : insideFlags.every(f => f);
            if (matches) {
                const id = el.getAttribute("data-object-id");
                if (id) result.push(id);
            }
        }
        return result;
    }

    private selectTextBlocksInLasso(pageId: string, lasso: { x: number, y: number }[]): string[] {
        const layer = this.ui.textBlockLayers.get(pageId);
        if (!layer) return [];
        const ids: string[] = [];
        const wrapper = layer.closest('.pdfcompose-page-wrapper');
        if (!wrapper) return ids;
        const wrapperRect = wrapper.getBoundingClientRect();
        const scale = this.getEffectiveScaleForPage(pageId);
        const textBlockElements = Array.from(layer.querySelectorAll<HTMLElement>('.pdfcompose-textblock'));
        for (const el of textBlockElements) {
            const id = el.getAttribute('data-textblock-id');
            if (!id) continue;
            const rect = el.getBoundingClientRect();
            const x = (rect.left - wrapperRect.left) / (scale * this.zoomLevel);
            const y = (rect.top - wrapperRect.top) / (scale * this.zoomLevel);
            const w = rect.width / (scale * this.zoomLevel);
            const h = rect.height / (scale * this.zoomLevel);
            // Prüfe, ob das Rechteck komplett oder teilweise im Lasso liegt
            const corners = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
            const inside = corners.some(p => this.pointInPolygon(p, lasso));
            const allInside = corners.every(p => this.pointInPolygon(p, lasso));
            const matches = this.selectionMode === "touch" ? inside : allInside;
            if (matches) ids.push(id);
        }
        return ids;
    }

    private selectPdfAnnotationsInLasso(pageId: string, lasso: { x: number, y: number }[]): string[] {
        const layer = this.ui.highlightLayers.get(pageId);
        if (!layer) return [];
        const ids = new Set<string>();
        const rects = Array.from(layer.querySelectorAll<SVGRectElement>('[data-pdf-annotation-id]'));
        for (const rectEl of rects) {
            const id = rectEl.getAttribute('data-pdf-annotation-id');
            if (!id) continue;
            const x = parseFloat(rectEl.getAttribute('x') || '0');
            const y = parseFloat(rectEl.getAttribute('y') || '0');
            const w = parseFloat(rectEl.getAttribute('width') || '0');
            const h = parseFloat(rectEl.getAttribute('height') || '0');
            const corners = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
            const inside = corners.some(p => this.pointInPolygon(p, lasso));
            const allInside = corners.every(p => this.pointInPolygon(p, lasso));
            const matches = this.selectionMode === "touch" ? inside : allInside;
            if (matches) ids.add(id);
        }
        return Array.from(ids);
    }

    private isObjectSelectable(obj: VectorObject): boolean {
        if (obj.type === "freehand") {
            if (obj.highlighter) {
                return this.selectionTargets.highlighters;
            }
            return this.selectionTargets.strokes;
        }
        // Alle anderen Vektor-Objekte (Linie, Pfeil, Polygon, Rechteck, Dreieck, Ellipse)
        return this.selectionTargets.shapes;
    }

    private pointInPolygon(point: { x: number; y: number }, polygon: { x: number; y: number }[]): boolean {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i].x, yi = polygon[i].y;
            const xj = polygon[j].x, yj = polygon[j].y;
            const intersect = ((yi > point.y) !== (yj > point.y)) &&
                (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    /**
 * Liefert Sample-Punkte eines SVG-Elements im Übergeordneten-Koordinatensystem
 * (viewBox-Koordinaten) — transformiert die lokalen Pfad-/bbox-Koordinaten
 * über die aktuelle CTM, damit rotation="…" korrekt berücksichtigt wird.
 */
    private sampleElementPoints(el: SVGGraphicsElement): { x: number; y: number }[] {
        const svgRoot = el.ownerSVGElement;
        if (!svgRoot) return [];
        const elCTM = el.getCTM();
        const rootCTM = svgRoot.getCTM();
        if (!elCTM || !rootCTM) return [];

        let toViewBox: DOMMatrix;
        try {
            toViewBox = rootCTM.inverse().multiply(elCTM);
        } catch {
            return [];
        }

        const transform = (p: { x: number; y: number }) => {
            const pt = svgRoot.createSVGPoint();
            pt.x = p.x;
            pt.y = p.y;
            const out = pt.matrixTransform(toViewBox);
            return { x: out.x, y: out.y };
        };

        const tag = el.tagName.toLowerCase();
        if (tag === "path") {
            const path = el as unknown as SVGPathElement;
            const length = path.getTotalLength();
            if (length === 0) {
                const p = path.getPointAtLength(0);
                return [transform({ x: p.x, y: p.y })];
            }
            const steps = 16;
            const pts: { x: number; y: number }[] = [];
            for (let i = 0; i <= steps; i++) {
                const p = path.getPointAtLength((length * i) / steps);
                pts.push(transform({ x: p.x, y: p.y }));
            }
            return pts;
        }

        const bbox = el.getBBox();
        return [
            transform({ x: bbox.x, y: bbox.y }),
            transform({ x: bbox.x + bbox.width, y: bbox.y }),
            transform({ x: bbox.x + bbox.width, y: bbox.y + bbox.height }),
            transform({ x: bbox.x, y: bbox.y + bbox.height }),
            transform({ x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 }),
        ];
    }

    private snapshotSelection(pageId: string): Map<string, VectorObject> {
        const objects = this.getPageAnnotations(pageId);
        const map = new Map<string, VectorObject>();
        for (const obj of objects) {
            if (this.selectedIds.has(obj.id)) map.set(obj.id, obj);
        }
        return map;
    }

    private previewMoveSelection(pageId: string, dx: number, dy: number): void {
        const preview = `translate(${dx} ${dy})`;
        for (const id of this.selectedIds) {
            const el = this.ui.findObjectElementById(pageId, id);
            if (!el) continue;
            const orig = this.moveSelectionOriginalTransforms.get(id) ?? "";
            el.setAttribute("transform", orig ? `${preview} ${orig}` : preview);
        }
        this.ui.selectionHandlesGroup?.setAttribute("transform", preview);
    }

    private async translateObjectsRaw(pageId: string, ids: Set<string>, dx: number, dy: number): Promise<void> {
        const objects = this.getPageAnnotations(pageId);
        const updated = objects.map(obj => ids.has(obj.id) ? this.translateObject(obj, dx, dy) : obj);
        await this.setPageAnnotations(pageId, updated);
    }

    private async commitMoveSelection(pageId: string, snapshot: Map<string, VectorObject>, dx: number, dy: number): Promise<void> {
        const ids = new Set(snapshot.keys());
        await this.translateObjectsRaw(pageId, ids, dx, dy);

        this.pushUndo({
            label: "move-selection",
            undo: async () => { await this.translateObjectsRaw(pageId, ids, -dx, -dy); },
            redo: async () => { await this.translateObjectsRaw(pageId, ids, dx, dy); },
        });
    }

    private translateObject(obj: VectorObject, dx: number, dy: number): VectorObject {
        switch (obj.type) {
            case "freehand":
                return { ...obj, points: obj.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) };
            case "line":
            case "arrow":
                return { ...obj, points: obj.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) };
            case "polygon":
                return { ...obj, points: obj.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) };
            case "rectangle":
            case "diamond":
                return { ...obj, x: obj.x + dx, y: obj.y + dy };
            case "triangle":
                return { ...obj, x: obj.x + dx, y: obj.y + dy };
            case "ellipse":
                return { ...obj, cx: obj.cx + dx, cy: obj.cy + dy };
        }
    }

    // ============================================================
    //  KOPIEREN / EINFÜGEN / LÖSCHEN
    // ============================================================
    private getCurrentVisiblePageId(): string | null {
        const container = this.ui?.pagesContainerEl;
        const list = this.pageWrapperList;
        if (!container || list.length === 0) return null;

        const horizontal = this.plugin.settings.horizontalLayout;
        const cRect = container.getBoundingClientRect();
        const center = horizontal ? cRect.left + cRect.width / 2 : cRect.top + cRect.height / 2;
        const endOf = (el: HTMLElement) => {
            const r = el.getBoundingClientRect();
            return horizontal ? r.right : r.bottom;
        };

        let lo = 0, hi = list.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (endOf(list[mid]) < center) lo = mid + 1;
            else hi = mid;
        }
        let best = lo;
        if (lo > 0) {
            const cur = list[lo].getBoundingClientRect();
            const start = horizontal ? cur.left : cur.top;
            if (start > center) { // Mitte liegt in einer Lücke -> näheren Nachbarn nehmen
                const prevEnd = endOf(list[lo - 1]);
                best = (start - center) < (center - prevEnd) ? lo : lo - 1;
            }
        }
        return list[best].dataset.pageId ?? null;
    }

    private updateCurrentPageHighlight(): void {
        this.ui.setCurrentPageHighlight(this.getCurrentVisiblePageId());
        if (this.rangeSession?.toolbar) this.layoutRangeSession();
    }

    private async copySelection(): Promise<void> {
        if (!this.selectionPageId) {
            this.clipboard = null;
            this.updateActionButtonsState();
            return;
        }

        const vectors: VectorObject[] = [];
        const textBlocks: TextBlockEntry[] = [];

        if (this.selectedIds.size > 0) {
            const objects = this.getPageAnnotations(this.selectionPageId);
            vectors.push(...objects.filter(o => this.selectedIds.has(o.id)).map(o => structuredClone(o)));
        }

        if (this.selectedTextBlockIds.size > 0) {
            const blocks = this.textBlocksCache.get(this.selectionPageId) ?? [];
            textBlocks.push(...blocks.filter(b => this.selectedTextBlockIds.has(b.id)).map(b => ({ ...b })));
        }

        if (vectors.length === 0 && textBlocks.length === 0) {
            this.clipboard = null;
        } else {
            this.clipboard = { vectors, textBlocks };
        }

        this.updateActionButtonsState();
    }

    private async cutSelection(): Promise<void> {
        if (!this.selectionPageId) return;
        const hasTextBlocks = this.selectedTextBlockIds.size > 0;
        const hasVectors = this.selectedIds.size > 0;
        if (!hasTextBlocks && !hasVectors) return;

        // Kopieren (füllt clipboardContent)
        await this.copySelection();

        // Löschen (mit Undo)
        await this.deleteSelection();

        // Nach dem Löschen bleibt der Clipboard-Inhalt erhalten
        this.updateActionButtonsState();
    }

    private async pasteClipboard(): Promise<void> {
        const pageId = this.getCurrentVisiblePageId();
        if (!pageId) {
            new Notice("No visible page found to paste into.");
            return;
        }

        if (!this.clipboard) return;

        const { vectors, textBlocks } = this.clipboard;

        // Auswahl vor dem Einfügen zurücksetzen - danach sollen NUR die neu
        // eingefügten Elemente ausgewählt sein.
        this.selectedIds.clear();
        this.selectedTextBlockIds.clear();
        this.selectedPdfAnnotationIds.clear();
        this.selectionPageId = pageId;

        // Textblöcke einfügen
        if (textBlocks.length > 0) {
            for (const source of textBlocks) {
                const pasted: TextBlockEntry = {
                    ...structuredClone(source),
                    id: crypto.randomUUID(),
                    pageId: pageId,
                };
                await this.createTextBlock(pasted);
                this.selectedTextBlockIds.add(pasted.id);
            }
        }

        // Vektoren einfügen
        if (vectors.length > 0) {
            const existing = this.getPageAnnotations(pageId);
            const pasted = vectors.map(obj => {
                const copy = structuredClone(obj);
                copy.id = crypto.randomUUID();
                return copy;
            });
            await this.setPageAnnotations(pageId, [...existing, ...pasted]);
            for (const obj of pasted) this.selectedIds.add(obj.id);
        }

        this.ui.updateSelectionHighlight(pageId, this.selectedIds, this.selectedTextBlockIds, this.selectedPdfAnnotationIds);
        this.renderAnnotationPanel();
        this.updateActionButtonsState();
        await this.renderSelectionHandles();
    }

    /**
 * Aktualisiert die Sichtbarkeit der Action-Buttons (Kopieren, Ausschneiden, Löschen, Einfügen)
 * basierend auf der aktuellen Auswahl (Vektoren, Textblöcke, Annotationen) und dem Clipboard.
 */
    private updateActionButtonsState(): void {
        const hasSelection = this.selectedIds.size > 0 ||
            this.selectedTextBlockIds.size > 0 ||
            this.selectedPdfAnnotationIds.size > 0;

        let canPaste = false;
        if (this.clipboard) {
            canPaste = this.clipboard.vectors.length > 0 ||
                this.clipboard.textBlocks.length > 0;
        }

        this.ui.updateActionButtons(hasSelection, canPaste);
    }

    private async deleteSelection(): Promise<void> {
        if (!this.selectionPageId) {
            console.warn("deleteSelection: Keine Seite ausgewählt.");
            return;
        }
        const pageId = this.selectionPageId;

        // 1. Zu löschende Elemente sammeln (tiefe Kopien für Undo)
        const deletedVectors: VectorObject[] = [];
        const deletedTextBlocks: TextBlockEntry[] = [];
        const deletedAnnotations: PdfAnnotationEntry[] = [];

        // IDs sichern, bevor wir sie leeren
        const vectorIds = new Set(this.selectedIds);
        const textIds = new Set(this.selectedTextBlockIds);
        const annotIds = new Set(this.selectedPdfAnnotationIds);

        if (vectorIds.size > 0) {
            const objects = this.getPageAnnotations(pageId);
            deletedVectors.push(...objects.filter(o => vectorIds.has(o.id)).map(o => structuredClone(o)));

            // In commitErase() nach dem Löschen der Vektor-Objekte:
            for (const id of vectorIds) {
                const labelEntry = (this.shapeLabelsCache.get(pageId) ?? []).find((s) => s.shapeId === id);
                if (labelEntry) await this.deleteShapeLabelRaw(labelEntry.id, pageId);
            }
        }

        if (textIds.size > 0) {
            const blocks = this.textBlocksCache.get(pageId) ?? [];
            deletedTextBlocks.push(...blocks.filter(b => textIds.has(b.id)).map(b => ({ ...b })));
            // Falls keine Blöcke gefunden wurden, warnen
            if (deletedTextBlocks.length === 0) {
                console.warn(`deleteSelection: Keine Textblöcke für IDs ${Array.from(textIds).join(', ')} gefunden.`);
            }
        }

        if (annotIds.size > 0) {
            const entries = this.pdfAnnotationsCache.get(pageId) ?? [];
            deletedAnnotations.push(...entries.filter(e => annotIds.has(e.id)).map(e => ({ ...e })));
        }

        // Wenn nichts zu löschen ist, abbrechen
        if (deletedVectors.length === 0 && deletedTextBlocks.length === 0 && deletedAnnotations.length === 0) {
            // Trotzdem Auswahl zurücksetzen, falls sie fälschlicherweise gesetzt war
            this.selectedIds.clear();
            this.selectedTextBlockIds.clear();
            this.selectedPdfAnnotationIds.clear();
            this.updateActionButtonsState();
            return;
        }

        // Auswahl zurücksetzen (damit UI nicht auf gelöschte Elemente zeigt)
        this.selectedIds.clear();
        this.selectedTextBlockIds.clear();
        this.selectedPdfAnnotationIds.clear();

        // 2. Löschen ausführen
        if (deletedVectors.length > 0) {
            await this.removeObjectsRaw(pageId, new Set(deletedVectors.map(o => o.id)));
        }
        if (deletedTextBlocks.length > 0) {
            await this.deleteTextBlocksRaw(pageId, new Set(deletedTextBlocks.map(b => b.id)));
        }
        if (deletedAnnotations.length > 0) {
            await this.deletePdfAnnotationsRaw(pageId, new Set(deletedAnnotations.map(a => a.id)));
        }

        // 3. Undo pushen – alle gelöschten Elemente wiederherstellen
        this.pushUndo({
            label: "delete-selection",
            undo: async () => {
                // Vektoren wiederherstellen
                if (deletedVectors.length > 0) {
                    const current = this.getPageAnnotations(pageId);
                    await this.setPageAnnotations(pageId, [...current, ...deletedVectors]);
                }
                // Textblöcke wiederherstellen
                if (deletedTextBlocks.length > 0) {
                    for (const b of deletedTextBlocks) {
                        await this.saveTextBlockRaw(b);
                    }
                }
                // Annotationen wiederherstellen
                if (deletedAnnotations.length > 0) {
                    for (const a of deletedAnnotations) {
                        await this.savePdfAnnotationRaw(a);
                    }
                }
                this.renderAnnotationPanel();
                this.updateActionButtonsState();
            },
            redo: async () => {
                // Löschen wiederholen
                if (deletedVectors.length > 0) {
                    await this.removeObjectsRaw(pageId, new Set(deletedVectors.map(o => o.id)));
                }
                if (deletedTextBlocks.length > 0) {
                    await this.deleteTextBlocksRaw(pageId, new Set(deletedTextBlocks.map(b => b.id)));
                }
                if (deletedAnnotations.length > 0) {
                    await this.deletePdfAnnotationsRaw(pageId, new Set(deletedAnnotations.map(a => a.id)));
                }
                this.renderAnnotationPanel();
                this.updateActionButtonsState();
            },
        });

        this.renderAnnotationPanel();
        this.updateActionButtonsState();
    }

    private async deletePdfAnnotationsRaw(pageId: string, ids: Set<string>): Promise<void> {
        if (ids.size === 0) return;
        await this.updateFileAtomic(
            (fm) => {
                if (fm.pdfAnnotations) {
                    fm.pdfAnnotations = fm.pdfAnnotations.filter((a: any) => !ids.has(a.id));
                }
            },
            (body) => {
                let content = body;
                for (const id of ids) {
                    content = removePdfAnnotation(content, id);
                }
                return content;
            }
        );
        // Cache aktualisieren
        const list = (this.pdfAnnotationsCache.get(pageId) || []).filter(a => !ids.has(a.id));
        this.pdfAnnotationsCache.set(pageId, list);
        this.drawPdfAnnotationHighlights(pageId);
        await this.renderPdfAnnotationsForPage(pageId, this.getEffectiveScaleForPage(pageId));
    }

    // ============================================================
    //  TRANSFORMATION (Rotation, Skalierung)
    // ============================================================
    private getLocalBox(obj: VectorObject): { cx: number; cy: number; w: number; h: number; rotation: number } | null {
        switch (obj.type) {
            case "rectangle":
            case "diamond":
                return { cx: obj.x + obj.width / 2, cy: obj.y + obj.height / 2, w: obj.width, h: obj.height, rotation: obj.rotation ?? 0 };
            case "triangle": {
                const w = obj.width ?? obj.size ?? 0;
                const h = obj.height ?? obj.size ?? 0;
                return { cx: obj.x + w / 2, cy: obj.y + h / 2, w, h, rotation: obj.rotation ?? 0 };
            }
            case "ellipse":
                return { cx: obj.cx, cy: obj.cy, w: obj.rx * 2, h: obj.ry * 2, rotation: obj.rotation ?? 0 };
            default:
                return null;
        }
    }

    /** Auswahlrahmen: Ecken NW, NE, SE, SW. Einzelne gedrehte Form -> gedrehter Rahmen, sonst achsenparallel. */
    public getSelectionFrame(selected: VectorObject[]): { corners: { x: number; y: number }[]; rotation: number } | null {
        if (selected.length === 0) return null;
        if (selected.length === 1) {
            const box = this.getLocalBox(selected[0]);
            if (box && Math.abs(box.rotation % 360) > 1e-6) {
                const c = { x: box.cx, y: box.cy };
                const raw = [
                    { x: c.x - box.w / 2, y: c.y - box.h / 2 },
                    { x: c.x + box.w / 2, y: c.y - box.h / 2 },
                    { x: c.x + box.w / 2, y: c.y + box.h / 2 },
                    { x: c.x - box.w / 2, y: c.y + box.h / 2 },
                ];
                return { corners: raw.map(p => this.rotatePoint(p, c, box.rotation)), rotation: box.rotation };
            }
        }
        const b = this.getSelectionBoundsBox(selected);
        if (!Number.isFinite(b.minX)) return null;
        return {
            corners: [
                { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY },
                { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY },
            ],
            rotation: 0,
        };
    }

    /** Skalierungsfaktoren in den Achsen der Auswahl (axisDeg = Rotation des Rahmens). */
    private computeHandleScale(
        startVector: { x: number; y: number },
        current: { x: number; y: number },
        axisDeg: number,
        uniform: boolean,
    ): { scaleX: number; scaleY: number } {
        const rad = (-axisDeg * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const toLocal = (v: { x: number; y: number }) => ({ x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos });
        const ls = toLocal(startVector);
        const lc = toLocal(current);
        const MIN = 0.05;
        let scaleX = Math.abs(ls.x) > 1e-6 ? lc.x / ls.x : 1;
        let scaleY = Math.abs(ls.y) > 1e-6 ? lc.y / ls.y : 1;
        if (Math.abs(scaleX) < MIN) scaleX = Math.sign(scaleX || 1) * MIN;
        if (Math.abs(scaleY) < MIN) scaleY = Math.sign(scaleY || 1) * MIN;
        if (uniform) {
            const s = Math.max(Math.abs(scaleX), Math.abs(scaleY));
            scaleX = Math.sign(scaleX || 1) * s;
            scaleY = Math.sign(scaleY || 1) * s;
        }
        return { scaleX, scaleY };
    }

    private startHandleDrag(
        evt: PointerEvent,
        mode: "rotate" | "scale-corner",
        svg: SVGSVGElement,
        cornerIndex: number = 0,
    ): void {
        evt.preventDefault();
        evt.stopPropagation();
        if (!this.currentFile || !this.selectionPageId) return;

        const snapshot = this.snapshotSelection(this.selectionPageId);
        const frame = this.getSelectionFrame(Array.from(snapshot.values()));
        if (!frame) return;

        const target = evt.currentTarget as SVGElement;
        try { target.setPointerCapture(evt.pointerId); } catch { /* ignore */ }

        this.handleDragMode = mode;
        this.handleDragPointerId = evt.pointerId;
        this.handleDragTarget = target;
        this.handleDragCornerIndex = mode === "scale-corner" ? cornerIndex : null;

        const center = {
            x: (frame.corners[0].x + frame.corners[2].x) / 2,
            y: (frame.corners[0].y + frame.corners[2].y) / 2,
        };
        // Skalieren: gegenüberliegende Ecke bleibt fix (Reihenfolge NW, NE, SE, SW)
        const pivot = mode === "rotate" ? center : frame.corners[(cornerIndex + 2) % 4];
        this.handleDragPivot = pivot;
        this.handleDragAxisDeg = mode === "scale-corner" ? frame.rotation : 0;

        const p = this.getSvgPoint(svg, evt);
        this.handleDragStartVector = { x: p.x - pivot.x, y: p.y - pivot.y };

        this.handleDragOriginalTransforms.clear();
        for (const id of this.selectedIds) {
            const el = this.ui.findObjectElementById(this.selectionPageId, id);
            if (el) this.handleDragOriginalTransforms.set(id, el.getAttribute("transform") ?? "");
        }

        target.addEventListener("pointermove", this.onHandleDragMove);
        target.addEventListener("pointerup", this.onHandleDragEnd);
        target.addEventListener("pointercancel", this.onHandleDragEnd);
        window.addEventListener("pointerup", this.onHandleDragEnd);
        window.addEventListener("pointercancel", this.onHandleDragEnd);
    }

    private onHandleDragMove = (evt: PointerEvent): void => {
        if (this.handleDragMode === null || evt.pointerId !== this.handleDragPointerId) return;
        if (!this.handleDragPivot || !this.handleDragStartVector || !this.selectionPageId) return;
        const svg = this.ui.annotationLayers.get(this.selectionPageId);
        if (!svg) return;
        const point = this.getSvgPoint(svg, evt);
        const cx = point.x - this.handleDragPivot.x;
        const cy = point.y - this.handleDragPivot.y;
        const shiftActive = evt.shiftKey && evt.pointerType !== "touch";

        if (this.handleDragMode === "rotate") {
            const startAngle = Math.atan2(this.handleDragStartVector.y, this.handleDragStartVector.x);
            const currentAngle = Math.atan2(cy, cx);
            let deg = ((currentAngle - startAngle) * 180) / Math.PI;
            if (shiftActive) deg = Math.round(deg / 15) * 15;
            this.applyPreviewTransform(this.selectionPageId, this.handleDragPivot, deg, 1, 1, 0);
        } else {
            const { scaleX, scaleY } = this.computeHandleScale(
                this.handleDragStartVector, { x: cx, y: cy }, this.handleDragAxisDeg, shiftActive);
            this.applyPreviewTransform(this.selectionPageId, this.handleDragPivot, 0, scaleX, scaleY, this.handleDragAxisDeg);
        }
    };

    /**
     * Wendet eine Vorschau-Transformation an, OHNE die originalen Transform-
     * Attribute der Objekte zu verlieren (wichtig für bereits rotierte
     * Rechtecke, die eine eigene transform="rotate(...)"-Angabe haben).
     */
    private applyPreviewTransform(
        pageId: string,
        pivot: { x: number; y: number },
        rotateDeg: number,
        scaleX: number,
        scaleY: number,
        axisDeg: number = 0,
    ): void {
        const preview =
            `translate(${pivot.x} ${pivot.y}) ` +
            `rotate(${rotateDeg}) rotate(${axisDeg}) ` +
            `scale(${scaleX} ${scaleY}) ` +
            `rotate(${-axisDeg}) translate(${-pivot.x} ${-pivot.y})`;

        for (const id of this.selectedIds) {
            const el = this.ui.findObjectElementById(pageId, id);
            if (!el) continue;
            const orig = this.handleDragOriginalTransforms.get(id) ?? "";
            el.setAttribute("transform", orig ? `${preview} ${orig}` : preview);
        }
        this.ui.selectionHandlesGroup?.setAttribute("transform", preview);
    }

    private onHandleDragEnd = async (evt: PointerEvent): Promise<void> => {
        if (this.handleDragMode === null || evt.pointerId !== this.handleDragPointerId) return;

        const target = this.handleDragTarget;
        target?.removeEventListener("pointermove", this.onHandleDragMove);
        target?.removeEventListener("pointerup", this.onHandleDragEnd);
        target?.removeEventListener("pointercancel", this.onHandleDragEnd);
        window.removeEventListener("pointerup", this.onHandleDragEnd);
        window.removeEventListener("pointercancel", this.onHandleDragEnd);
        if (target && target.hasPointerCapture(evt.pointerId)) {
            try { target.releasePointerCapture(evt.pointerId); } catch { /* ignore */ }
        }
        this.handleDragTarget = null;

        const mode = this.handleDragMode;
        const pivot = this.handleDragPivot;
        const startVector = this.handleDragStartVector;
        const axisDeg = this.handleDragAxisDeg;
        const pageId = this.selectionPageId;
        this.handleDragMode = null;
        this.handleDragPivot = null;
        this.handleDragStartVector = null;
        this.handleDragCornerIndex = null;
        this.handleDragAxisDeg = 0;
        this.handleDragOriginalTransforms.clear();

        if (!mode || !pivot || !startVector || !pageId) return;
        const svg = this.ui.annotationLayers.get(pageId);
        if (!svg) return;
        const point = this.getSvgPoint(svg, evt);
        const cx = point.x - pivot.x;
        const cy = point.y - pivot.y;
        const shiftActive = evt.shiftKey && evt.pointerType !== "touch";

        let rotateDeg = 0, scaleX = 1, scaleY = 1;
        if (mode === "rotate") {
            const startAngle = Math.atan2(startVector.y, startVector.x);
            const currentAngle = Math.atan2(cy, cx);
            rotateDeg = ((currentAngle - startAngle) * 180) / Math.PI;
            if (shiftActive) rotateDeg = Math.round(rotateDeg / 15) * 15;
        } else {
            ({ scaleX, scaleY } = this.computeHandleScale(startVector, { x: cx, y: cy }, axisDeg, shiftActive));
        }

        const changed = Math.abs(rotateDeg) > 0.1
            || Math.abs(scaleX - 1) > 0.01
            || Math.abs(scaleY - 1) > 0.01;

        if (changed) {
            await this.applyTransformToSelectionAbout(pageId, pivot, rotateDeg, scaleX, scaleY, axisDeg);
        } else {
            this.redrawPageFromCache(pageId);
        }
    };

    private async transformObjectsRaw(
        pageId: string,
        ids: Set<string>,
        pivot: { x: number; y: number },
        rotateDeg: number,
        scaleX: number,
        scaleY: number,
        axisDeg: number = 0,
    ): Promise<void> {
        const objects = this.getPageAnnotations(pageId);
        const updated = objects.map(obj =>
            ids.has(obj.id) ? this.transformObject(obj, pivot, rotateDeg, scaleX, scaleY, axisDeg) : obj
        );
        await this.setPageAnnotations(pageId, updated);
    }

    private async applyTransformToSelectionAbout(
        pageId: string,
        pivot: { x: number; y: number },
        rotateDeg: number,
        scaleX: number,
        scaleY: number,
        axisDeg: number = 0,
    ): Promise<void> {
        const ids = new Set(this.selectedIds);
        const before = this.getPageAnnotations(pageId)
            .filter(o => ids.has(o.id))
            .map(o => structuredClone(o));

        await this.transformObjectsRaw(pageId, ids, pivot, rotateDeg, scaleX, scaleY, axisDeg);

        this.pushUndo({
            label: "transform-selection",
            undo: async () => {
                const current = this.getPageAnnotations(pageId);
                const map = new Map(before.map(o => [o.id, o]));
                await this.setPageAnnotations(pageId, current.map(o => map.get(o.id) ?? o));
            },
            redo: async () => {
                await this.transformObjectsRaw(pageId, ids, pivot, rotateDeg, scaleX, scaleY, axisDeg);
            },
        });
    }

    // ============================================================
    //  PUNKT-BEARBEITUNG (Linie/Pfeil/Polygon)
    // ============================================================
    private startPointDrag(evt: PointerEvent, pageId: string, objectId: string, index: number, svg: SVGSVGElement): void {
        // Rechtsklick (und ggf. mittlere Maustaste) soll NICHT als Drag-Start
        // behandelt werden - sonst konsumiert preventDefault() weiter unten
        // bereits das native "contextmenu"-Ereignis, und das Lösch-Menü
        // (siehe onPointContextMenu) kann nie mehr geöffnet werden.
        if (evt.pointerType === "mouse" && evt.button !== 0) return;

        evt.preventDefault();
        evt.stopPropagation();
        try { svg.setPointerCapture(evt.pointerId); } catch { /* ignore */ }

        const objects = this.getPageAnnotations(pageId);
        const obj = objects.find(o => o.id === objectId);
        const originalPoint = obj && (obj.type === "line" || obj.type === "arrow" || obj.type === "polygon") ? { ...obj.points[index] } : null;
        const isLineOrArrow = !!obj && (obj.type === "line" || obj.type === "arrow");
        const isEndpoint = isLineOrArrow && (index === 0 || index === (obj as any).points.length - 1);

        // --- Handle ausblenden, um optisches Zurückbleiben zu vermeiden ---
        const handle = evt.currentTarget as SVGCircleElement;
        if (handle) {
            handle.style.display = "none";
        }
        // ---

        this.pointDragMode = {
            pageId, objectId, pointIndex: index, pointerId: evt.pointerId, originalPoint, isEndpoint,
            originalStartBinding: isLineOrArrow ? (obj as any).startBinding : undefined,
            originalEndBinding: isLineOrArrow ? (obj as any).endBinding : undefined,
        };

        // Auf Touch/Stift gibt es kein natives "contextmenu"-Event bei
        // Long-Press auf diesem Handle, weil preventDefault()/setPointerCapture()
        // oben bereits eine Drag-Geste beanspruchen. Long-Press wird deshalb
        // hier manuell nachgebildet: hält der Finger/Stift kurz bewegungslos,
        // öffnet sich statt einer Verschiebung das Lösch-Kontextmenü.
        if (evt.pointerType !== "mouse") {
            this.pointLongPressStartClient = { x: evt.clientX, y: evt.clientY };
            const pointerId = evt.pointerId;
            this.pointLongPressTimer = window.setTimeout(() => {
                this.pointLongPressTimer = null;
                if (!this.pointDragMode || this.pointDragMode.pointerId !== pointerId) return;
                const clientX = this.pointLongPressStartClient?.x ?? evt.clientX;
                const clientY = this.pointLongPressStartClient?.y ?? evt.clientY;
                this.cancelPointDragForLongPress(handle);
                this.showPointContextMenuAt(clientX, clientY, pageId, objectId, index);
            }, 500);
        }

        svg.addEventListener("pointermove", this.onPointDragMove);
        svg.addEventListener("pointerup", this.onPointDragEnd);
        svg.addEventListener("pointercancel", this.onPointDragEnd);
    }

    /**
     * Bricht ein per Long-Press erkanntes "Drag" ab, OHNE die Verschiebung
     * zu committen: entfernt die Drag-Listener, gibt die Pointer-Capture
     * frei, blendet das Handle wieder ein und stellt die Original-Position
     * des Punkts wieder her (falls onPointDragMove ihn bereits minimal
     * verschoben hatte, bevor der Long-Press erkannt wurde).
     */
    private cancelPointDragForLongPress(handle: SVGCircleElement | null): void {
        const mode = this.pointDragMode;
        if (mode) this.setBindTargetHighlight(mode.pageId, null);
        const svg = mode ? this.ui.annotationLayers.get(mode.pageId) : null;
        if (svg) {
            svg.removeEventListener("pointermove", this.onPointDragMove);
            svg.removeEventListener("pointerup", this.onPointDragEnd);
            svg.removeEventListener("pointercancel", this.onPointDragEnd);
            if (mode && svg.hasPointerCapture(mode.pointerId)) {
                try { svg.releasePointerCapture(mode.pointerId); } catch { /* ignore */ }
            }
        }
        if (handle) handle.style.display = "";

        if (mode?.originalPoint) {
            const objects = this.getPageAnnotations(mode.pageId);
            const obj = objects.find(o => o.id === mode.objectId);
            if (obj && (obj.type === "line" || obj.type === "arrow" || obj.type === "polygon")) {
                obj.points[mode.pointIndex] = { ...mode.originalPoint };
                this.redrawPageFromCache(mode.pageId);
            }
        }

        this.pointDragMode = null;
        this.pointLongPressTimer = null;
        this.pointLongPressStartClient = null;
    }

    private onPointDragMove = (evt: PointerEvent): void => {
        if (!this.pointDragMode || evt.pointerId !== this.pointDragMode.pointerId) return;

        // Sobald sich der Kontaktpunkt merklich bewegt, ist eine echte
        // Verschiebungs-Absicht klar - der Long-Press-Timer für das
        // Lösch-Menü wird dann nicht mehr ausgelöst.
        if (this.pointLongPressTimer !== null && this.pointLongPressStartClient) {
            const dx = evt.clientX - this.pointLongPressStartClient.x;
            const dy = evt.clientY - this.pointLongPressStartClient.y;
            if (Math.hypot(dx, dy) > 8) {
                window.clearTimeout(this.pointLongPressTimer);
                this.pointLongPressTimer = null;
            }
        }

        const { pageId, objectId, pointIndex, isEndpoint } = this.pointDragMode;
        const svg = this.ui.annotationLayers.get(pageId);
        if (!svg) return;
        const point = this.getSvgPoint(svg, evt);

        const objects = this.getPageAnnotations(pageId);
        const obj = objects.find(o => o.id === objectId);
        if (!obj || (obj.type !== "line" && obj.type !== "arrow" && obj.type !== "polygon")) return;

        obj.points[pointIndex] = { ...obj.points[pointIndex], x: point.x, y: point.y };

        // Nur das betroffene Objekt neu zeichnen (kein kompletter Seiten-Redraw pro Pointermove).
        svg.querySelectorAll(`[data-object-id="${objectId}"], [data-label-owner="${objectId}"]`).forEach(el => el.remove());
        this.drawVectorObject(pageId, obj);
        this.ui.updatePointHandlePositions(obj);

        // Sichtbare Rückmeldung: Zielform hervorheben, solange ein Endpunkt
        // darüber gehalten wird - macht deutlich, dass beim Loslassen dort
        // eine Bindung entsteht.
        if (isEndpoint) {
            const target = this.findBindableShapeAt(pageId, point, objectId);
            this.setBindTargetHighlight(pageId, target?.id ?? null);
        }
    };

    private async setObjectPointRaw(
        pageId: string,
        objectId: string,
        pointIndex: number,
        point: LinePoint,
        bindings?: { start?: EndpointBinding; end?: EndpointBinding },
    ): Promise<void> {
        const objects = this.getPageAnnotations(pageId);
        const obj = objects.find(o => o.id === objectId);
        if (!obj || (obj.type !== "line" && obj.type !== "arrow" && obj.type !== "polygon")) return;
        obj.points[pointIndex] = { ...point };
        if (bindings && (obj.type === "line" || obj.type === "arrow")) {
            if (pointIndex === 0) (obj as any).startBinding = bindings.start;
            if (pointIndex === obj.points.length - 1) (obj as any).endBinding = bindings.end;
        }
        await this.setPageAnnotations(pageId, objects);
    }

    private onPointDragEnd = async (evt: PointerEvent): Promise<void> => {
        if (!this.pointDragMode || evt.pointerId !== this.pointDragMode.pointerId) return;
        if (this.pointLongPressTimer !== null) {
            window.clearTimeout(this.pointLongPressTimer);
            this.pointLongPressTimer = null;
        }
        this.pointLongPressStartClient = null;
        const { pageId, objectId, pointIndex, originalPoint, isEndpoint, originalStartBinding, originalEndBinding } = this.pointDragMode;
        this.setBindTargetHighlight(pageId, null);

        const svg = this.ui.annotationLayers.get(pageId);
        svg?.removeEventListener("pointermove", this.onPointDragMove);
        svg?.removeEventListener("pointerup", this.onPointDragEnd);
        svg?.removeEventListener("pointercancel", this.onPointDragEnd);
        if (svg && svg.hasPointerCapture(evt.pointerId)) {
            try { svg.releasePointerCapture(evt.pointerId); } catch { /* ignore */ }
        }
        this.pointDragMode = null;

        const objects = this.getPageAnnotations(pageId);
        const obj = objects.find(o => o.id === objectId);

        // Endpunkt über einer bindbaren Form losgelassen -> binden;
        // ansonsten (falls zuvor gebunden) die Bindung lösen.
        let newStartBinding = originalStartBinding;
        let newEndBinding = originalEndBinding;
        if (obj && isEndpoint && (obj.type === "line" || obj.type === "arrow")) {
            const dropPoint = { x: obj.points[pointIndex].x, y: obj.points[pointIndex].y };
            const target = this.findBindableShapeAt(pageId, dropPoint, objectId);
            const isStart = pointIndex === 0;
            const binding = target ? this.computeBindingFraction(target, dropPoint) : null;
            const resolved = binding ? { objectId: target!.id, ax: binding.ax, ay: binding.ay } : undefined;

            const priorBinding = isStart ? originalStartBinding : originalEndBinding;
            if (isStart) { (obj as any).startBinding = resolved; newStartBinding = resolved; }
            else { (obj as any).endBinding = resolved; newEndBinding = resolved; }

            // Textliche Rückmeldung: nur anzeigen, wenn sich der
            // Bindungszustand tatsächlich geändert hat.
            const wasBound = !!priorBinding;
            const isBound = !!resolved;
            if (isBound && (!wasBound || priorBinding!.objectId !== resolved!.objectId)) {
                new Notice("Endpoint bound to shape.");
            } else if (!isBound && wasBound) {
                new Notice("Binding to shape released.");
            }
        }

        const newPoint = obj && (obj.type === "line" || obj.type === "arrow" || obj.type === "polygon") ? { ...obj.points[pointIndex] } : null;

        await this.setPageAnnotations(pageId, objects);

        await this.renderSelectionHandles();
        this.renderAnnotationPanel();

        if (originalPoint && newPoint) {
            this.pushUndo({
                label: "move-point",
                undo: async () => {
                    await this.setObjectPointRaw(pageId, objectId, pointIndex, originalPoint, {
                        start: originalStartBinding, end: originalEndBinding,
                    });
                },
                redo: async () => {
                    await this.setObjectPointRaw(pageId, objectId, pointIndex, newPoint, {
                        start: newStartBinding, end: newEndBinding,
                    });
                },
            });
        }
    };

    /**
 * Affine Abbildung um den Pivot: p' = pivot + Rot(rotateDeg) * M * (p - pivot),
 * mit M = R(axis) * diag(scaleX, scaleY) * R(-axis). Bei Rechteck/Raute/Dreieck/Ellipse
 * werden Breite/Höhe entlang der eigenen (gedrehten) Achsen skaliert.
 */
    private transformObject(
        obj: VectorObject,
        pivot: { x: number; y: number },
        rotateDeg: number,
        scaleX: number,
        scaleY: number,
        axisDeg: number = 0,
    ): VectorObject {
        const a = (axisDeg * Math.PI) / 180;
        const c = Math.cos(a), s = Math.sin(a);
        const m11 = scaleX * c * c + scaleY * s * s;
        const m12 = (scaleX - scaleY) * s * c;
        const m22 = scaleX * s * s + scaleY * c * c;
        const applyM = (dx: number, dy: number) => ({ x: m11 * dx + m12 * dy, y: m12 * dx + m22 * dy });

        const tf = (p: { x: number; y: number }) => {
            const d = applyM(p.x - pivot.x, p.y - pivot.y);
            const q = { x: pivot.x + d.x, y: pivot.y + d.y };
            return Math.abs(rotateDeg) > 1e-6 ? this.rotatePoint(q, pivot, rotateDeg) : q;
        };
        const axisLen = (deg: number) => {
            const r = (deg * Math.PI) / 180;
            const v = applyM(Math.cos(r), Math.sin(r));
            return Math.hypot(v.x, v.y);
        };
        const newRotation = (r: number) => (((r + rotateDeg) % 360) + 360) % 360;

        switch (obj.type) {
            case "freehand":
                return { ...obj, points: obj.points.map(p => ({ ...p, ...tf(p) })) };
            case "line":
            case "arrow":
            case "polygon":
                return { ...obj, points: obj.points.map(p => ({ ...p, ...tf(p) })) } as VectorObject;

            case "rectangle":
            case "diamond": {
                const rot = obj.rotation ?? 0;
                const nc = tf({ x: obj.x + obj.width / 2, y: obj.y + obj.height / 2 });
                const w = obj.width * axisLen(rot);
                const h = obj.height * axisLen(rot + 90);
                return { ...obj, x: nc.x - w / 2, y: nc.y - h / 2, width: w, height: h, rotation: newRotation(rot) };
            }
            case "triangle": {
                const width = obj.width ?? obj.size ?? 0;
                const height = obj.height ?? obj.size ?? 0;
                const rot = obj.rotation ?? 0;
                const nc = tf({ x: obj.x + width / 2, y: obj.y + height / 2 });
                const w = width * axisLen(rot);
                const h = height * axisLen(rot + 90);
                return { ...obj, x: nc.x - w / 2, y: nc.y - h / 2, width: w, height: h, rotation: newRotation(rot) };
            }
            case "ellipse": {
                const rot = obj.rotation ?? 0;
                const nc = tf({ x: obj.cx, y: obj.cy });
                return {
                    ...obj, cx: nc.x, cy: nc.y,
                    rx: obj.rx * axisLen(rot), ry: obj.ry * axisLen(rot + 90),
                    rotation: newRotation(rot),
                };
            }
        }
    }

    private rotatePoint(p: { x: number; y: number }, pivot: { x: number; y: number }, degrees: number): { x: number; y: number } {
        const rad = (degrees * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const dx = p.x - pivot.x, dy = p.y - pivot.y;
        return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
    }

    private scalePoint(p: { x: number; y: number }, pivot: { x: number; y: number }, factor: number): { x: number; y: number } {
        return { x: pivot.x + (p.x - pivot.x) * factor, y: pivot.y + (p.y - pivot.y) * factor };
    }

    private getSelectionBoundsBox(objects: VectorObject[]): { minX: number; minY: number; maxX: number; maxY: number } {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const obj of objects) {
            const pts = this.getObjectPoints(obj);
            for (const p of pts) {
                minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
            }
        }
        return { minX, minY, maxX, maxY };
    }

    private getObjectPoints(obj: VectorObject): { x: number; y: number }[] {
        switch (obj.type) {
            case "freehand":
            case "line":
            case "arrow":
            case "polygon":
                return obj.points;

            case "rectangle":
            case "diamond": {
                const corners = [
                    { x: obj.x, y: obj.y },
                    { x: obj.x + obj.width, y: obj.y },
                    { x: obj.x + obj.width, y: obj.y + obj.height },
                    { x: obj.x, y: obj.y + obj.height },
                ];
                if (obj.rotation) {
                    const cx = obj.x + obj.width / 2;
                    const cy = obj.y + obj.height / 2;
                    return corners.map(p => this.rotatePoint(p, { x: cx, y: cy }, obj.rotation!));
                }
                return corners;
            }

            case "triangle": {
                const width = obj.width ?? obj.size ?? 0;
                const height = obj.height ?? obj.size ?? 0;
                const corners = [
                    { x: obj.x, y: obj.y },
                    { x: obj.x + width, y: obj.y },
                    { x: obj.x + width, y: obj.y + height },
                    { x: obj.x, y: obj.y + height },
                ];
                if (obj.rotation) {
                    const cx = obj.x + width / 2;
                    const cy = obj.y + height / 2;
                    return corners.map(p => this.rotatePoint(p, { x: cx, y: cy }, obj.rotation!));
                }
                return corners;
            }

            case "ellipse": {
                const rad = (obj.rotation ?? 0) * Math.PI / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);
                // Halbachsen der achsenparallelen Hüllbox einer rotierten Ellipse.
                const ax = Math.sqrt((obj.rx * cos) ** 2 + (obj.ry * sin) ** 2);
                const ay = Math.sqrt((obj.rx * sin) ** 2 + (obj.ry * cos) ** 2);
                return [
                    { x: obj.cx - ax, y: obj.cy - ay },
                    { x: obj.cx + ax, y: obj.cy + ay },
                ];
            }
        }
    }

    // ============================================================
    //  ZEICHEN-HILFSMETHODEN
    // ============================================================
    private getSvgPoint(svg: SVGSVGElement, evt: PointerEvent | MouseEvent): { x: number; y: number } {
        const point = svg.createSVGPoint();
        point.x = evt.clientX;
        point.y = evt.clientY;
        const ctm = svg.getScreenCTM();
        if (!ctm) return { x: 0, y: 0 };
        try {
            const transformed = point.matrixTransform(ctm.inverse());
            return { x: transformed.x, y: transformed.y };
        } catch {
            return { x: 0, y: 0 };
        }
    }

    private smoothFreehandPathData(points: { x: number; y: number }[]): string {
        if (points.length === 0) return "";
        if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
        if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;

        let d = `M ${points[0].x} ${points[0].y}`;
        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[i - 1] ?? points[i];
            const p1 = points[i];
            const p2 = points[i + 1];
            const p3 = points[i + 2] ?? p2;
            // WICHTIG: applyCornerDamping = false. Grund:
            // cornerSharpnessFactor() dampft Tangenten an spitzen Winkeln auf
            // null. Nach Douglas-Peucker sind das aber genau die übrig
            // gebliebenen Stützpunkte (die Stellen mit der größten Krümmung) -
            // das Damping würde dort jeden Bezier auf eine Gerade reduzieren
            // und die Kurve damit sichtbar eckig erscheinen lassen.
            // Echte, vom Nutzer gewollte scharfe Ecken ergeben sich ohnehin aus
            // der Nachbarschafts-Geometrie und werden vom Catmull-Rom-Ansatz
            // nur minimal gerundet.
            const { c1, c2 } = this.centripetalControlPoints(p0, p1, p2, p3, false);
            d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
        }
        return d;
    }

    /**
 * Tangenten-Handles für einen kubischen Bezier-Übergang p1→p2.
 *
 * Richtung: gemittelte Richtung durch p1 – also Vektor von p0 (vorheriger
 *           Nachbar) zu p2 (nächster Nachbar). Analog für p2: p1→p3.
 * Länge:    proportional zur LÄNGE DES AKTUELLEN SEGMENTS (p1→p2), nicht
 *           zur Länge zwischen den Nachbarpunkten. Das ist der entscheidende
 *           Unterschied: nach Douglas-Peucker können benachbarte Segmente
 *           um ein Vielfaches unterschiedlich lang sein. Eine an
 *           |p2-p0| gekoppelte Länge liefert dann entweder starke
 *           Überschwinger oder – bei kurzen Segmenten – viel zu kurze
 *           Tangenten, wodurch die Kurve eckig aussieht.
 *
 * Faktor 0.4 (statt des "reinen" Catmull-Rom-Werts 1/3) gibt eine etwas
 * großzügigere Rundung, was bei handschriftlichen Strichen natürlicher
 * wirkt, ohne zu überschwingen.
 */
    private centripetalControlPoints(
        p0: { x: number; y: number },
        p1: { x: number; y: number },
        p2: { x: number; y: number },
        p3: { x: number; y: number },
        applyCornerDamping: boolean = false,
    ): { c1: { x: number; y: number }; c2: { x: number; y: number } } {
        // Richtung der Tangenten: Nachbar zu Nachbar.
        let d1x = p2.x - p0.x;
        let d1y = p2.y - p0.y;
        let d2x = p3.x - p1.x;
        let d2y = p3.y - p1.y;

        // Sonderfall Endpunkte: wenn p0 == p1 oder p3 == p2 (Ränder), ist die
        // gemittelte Richtung null. Dann direkt die Segmentrichtung nehmen.
        const len1 = Math.hypot(d1x, d1y);
        if (len1 < 1e-9) {
            d1x = p2.x - p1.x;
            d1y = p2.y - p1.y;
        }
        const len2 = Math.hypot(d2x, d2y);
        if (len2 < 1e-9) {
            d2x = p2.x - p1.x;
            d2y = p2.y - p1.y;
        }

        // Normieren.
        const n1 = Math.hypot(d1x, d1y) || 1;
        const n2 = Math.hypot(d2x, d2y) || 1;
        d1x /= n1; d1y /= n1;
        d2x /= n2; d2y /= n2;

        // Handle-Länge: proportional zur LÄNGE DES AKTUELLEN SEGMENTS.
        const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const handleLen = segLen * 0.4;

        let damp1 = 1, damp2 = 1;
        if (applyCornerDamping) {
            damp1 = this.cornerSharpnessFactor(p0, p1, p2);
            damp2 = this.cornerSharpnessFactor(p1, p2, p3);
        }

        return {
            c1: { x: p1.x + d1x * handleLen * damp1, y: p1.y + d1y * handleLen * damp1 },
            c2: { x: p2.x - d2x * handleLen * damp2, y: p2.y - d2y * handleLen * damp2 },
        };
    }

    private cornerSharpnessFactor(prev: { x: number; y: number }, curr: { x: number; y: number }, next: { x: number; y: number }): number {
        const inX = curr.x - prev.x, inY = curr.y - prev.y;
        const outX = next.x - curr.x, outY = next.y - curr.y;
        const inLen = Math.hypot(inX, inY);
        const outLen = Math.hypot(outX, outY);
        if (inLen < 1e-6 || outLen < 1e-6) return 1;
        const cos = Math.max(-1, Math.min(1, (inX * outX + inY * outY) / (inLen * outLen)));
        // cos <= 0 entspricht einem rechten Winkel oder schärfer: Tangente an
        // dieser Ecke vollständig kappen, damit lange gerade Streckenab-
        // schnitte davor/danach nicht durch die Kurveninterpolation
        // aufgebogen werden.
        if (cos <= 0) return 0;
        // Für sanftere Richtungswechsel kubisch statt linear abschwächen:
        // mittelstarke Ecken beulen deutlich weniger aus, echte, sanfte
        // Rundungen (kleine Winkeländerungen) bleiben weiterhin glatt.
        return cos * cos * cos;
    }

    private linePointsToPathData(points: LinePoint[], closed: boolean = false): string {
        if (points.length === 0) return "";
        const n = points.length;
        if (n === 1) return `M ${points[0].x} ${points[0].y}`;

        let d = `M ${points[0].x} ${points[0].y}`;
        const segmentCount = closed ? n : n - 1;

        for (let i = 1; i <= segmentCount; i++) {
            const idx = i % n;
            const prevIdx = (i - 1) % n;
            const prev = points[prevIdx];
            const curr = points[idx];
            const kind = curr.segment ?? "straight";

            if (kind === "step") {
                d += ` L ${curr.x} ${prev.y} L ${curr.x} ${curr.y}`;
            } else if (kind === "curve") {
                const beforeIdx = closed ? (prevIdx - 1 + n) % n : Math.max(prevIdx - 1, 0);
                const afterIdx = closed ? (idx + 1) % n : Math.min(idx + 1, n - 1);
                const before = points[beforeIdx];
                const after = points[afterIdx];
                const { c1, c2 } = this.centripetalControlPoints(before, prev, curr, after, false);
                d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${curr.x} ${curr.y}`;
            } else {
                d += ` L ${curr.x} ${curr.y}`;
            }
        }
        if (closed) d += " Z";
        return d;
    }

    public drawVectorObject(pageId: string, obj: VectorObject): void {
        const isHighlighterObject = this.isHighlighterObject(obj);
        const targetSvg = isHighlighterObject
            ? this.ui.highlightLayers.get(pageId)
            : this.ui.annotationLayers.get(pageId);
        if (!targetSvg) return;

        const page = this.getPageDefinition(pageId);
        const invert = page ? this.isPageInverted(page) : false;
        const displayObj = invert ? this.toDisplayColors(obj) : obj;

        switch (displayObj.type) {
            case "freehand": this.drawFreehandPath(targetSvg, displayObj, pageId); break;
            case "line":
            case "arrow": this.drawLineOrArrow(targetSvg, displayObj, pageId); break;
            case "polygon": this.drawPolygon(targetSvg, displayObj, pageId); break;
            case "rectangle": this.drawRectangle(targetSvg, displayObj, pageId); break;
            case "triangle": this.drawTriangle(targetSvg, displayObj, pageId); break;
            case "ellipse": this.drawEllipse(targetSvg, displayObj, pageId); break;
            case "diamond": this.drawDiamond(targetSvg, displayObj, pageId); break;
        }
    }

    /** true, wenn dieses Objekt (Freihand-Textmarker ODER eine als "isHighlighter" markierte Form) wie ein Textmarker behandelt werden soll: eigene Ebene mit Multiply/Screen-Blendmodus statt der normalen Vektor-Ebene. */
    private isHighlighterObject(obj: VectorObject): boolean {
        if (obj.type === "freehand") return obj.highlighter === true;
        return (obj as any).isHighlighter === true;
    }

    /** Reduziert wie bei Freihand-Textmarkern die Deckkraft im (invertierten) Dark Mode, damit die Markierung dort nicht zu dominant wirkt. */
    private applyHighlighterOpacity(el: SVGElement, obj: VectorObject, pageId: string): void {
        if (!this.isHighlighterObject(obj)) return;
        const page = this.getPageDefinition(pageId);
        if (page && this.isPageInverted(page)) {
            el.setAttribute("opacity", "0.6");
        }
    }

    // ============================================================
    //  STIFT / FREIHAND
    // ============================================================
    private getActivePenPreset(): PenPreset {
        const preset = isPenTool(this.currentTool) ? this.penPresets.get(this.currentTool) : undefined;
        return preset ?? this.penPresets.get("pen-fineliner")!;
    }

    private computePressureWidth(preset: PenPreset, pressure: number | undefined): number {
        if (!preset.pressure.enabled) return preset.strokeWidth;
        const p = pressure !== undefined ? Math.max(0, Math.min(1, pressure)) : 0.5;
        const maxWidth = preset.strokeWidth;
        const minWidth = maxWidth * preset.pressure.minFactor;
        let t: number;
        switch (preset.pressure.curve) {
            case "quadratic": t = p * p; break;
            case "sqrt": t = Math.sqrt(p); break;
            case "ease": t = p * p * (3 - 2 * p); break;
            default: t = p;
        }
        return minWidth + (maxWidth - minWidth) * t;
    }

    /**
 * Baut geglättete Pfad-Daten (Catmull-Rom/Bézier) für eine offene
 * Punktfolge, analog zu smoothFreehandPathData(), aber wahlweise ohne
 * führendes "M" – damit sich die Kurve nahtlos an einen zuvor erzeugten
 * Pfadabschnitt anhängen lässt (siehe buildVariableWidthPathData()).
 */
    private smoothContourPathData(points: { x: number; y: number }[], includeMoveTo: boolean = true): string {
        if (points.length === 0) return "";
        if (points.length === 1) {
            return `${includeMoveTo ? "M" : "L"} ${points[0].x} ${points[0].y}`;
        }
        if (points.length === 2) {
            const start = includeMoveTo ? `M ${points[0].x} ${points[0].y} ` : `L ${points[0].x} ${points[0].y} `;
            return `${start}L ${points[1].x} ${points[1].y}`;
        }

        let d = includeMoveTo ? `M ${points[0].x} ${points[0].y}` : `L ${points[0].x} ${points[0].y}`;
        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[i - 1] ?? points[i];
            const p1 = points[i];
            const p2 = points[i + 1];
            const p3 = points[i + 2] ?? p2;
            const { c1, c2 } = this.centripetalControlPoints(p0, p1, p2, p3, false);
            d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
        }
        return d;
    }

    /** Setzt Pfad + Darstellung (fest vs. variabel breit) auf einem Freihand-Path-Element. */
    private applyFreehandPathAttributes(path: SVGPathElement, points: StrokePoint[], color: string): void {
        if (points.length === 0) return;
        const widths = points.map(p => p.w);

        if (isUniformWidth(widths)) {
            path.setAttribute("d", this.smoothFreehandPathData(points));
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", color);
            path.setAttribute("stroke-width", widths[0].toString());
            path.setAttribute("stroke-linecap", "round");
            path.setAttribute("stroke-linejoin", "round");
            path.removeAttribute("fill-rule");
        } else {
            path.setAttribute("d", buildVariableWidthPathData(points));
            path.setAttribute("fill", color);
            path.setAttribute("fill-rule", "nonzero");
            path.removeAttribute("stroke");
            path.removeAttribute("stroke-width");
            path.removeAttribute("stroke-linecap");
            path.removeAttribute("stroke-linejoin");
        }
    }

    private drawFreehandPath(svg: SVGSVGElement, obj: FreehandObject, pageId: string): void {
        if (obj.points.length === 0) return;

        const pointsWithWidth = obj.points.map(p => {
            let w = obj.strokeWidth;
            if (obj.pressureEnabled && p.p !== undefined) {
                const pressure = Math.max(0, Math.min(1, p.p));
                let t: number;
                switch (obj.pressureCurve) {
                    case "quadratic": t = pressure * pressure; break;
                    case "sqrt": t = Math.sqrt(pressure); break;
                    case "ease": t = pressure * pressure * (3 - 2 * pressure); break;
                    default: t = pressure;
                }
                const minWidth = obj.strokeWidth * obj.pressureMinFactor;
                w = minWidth + (obj.strokeWidth - minWidth) * t;
            }
            return { ...p, w };
        });

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        this.applyFreehandPathAttributes(path, pointsWithWidth, obj.color);
        path.setAttribute("data-object-id", obj.id);
        this.applyHighlighterOpacity(path, obj, pageId);
        svg.appendChild(path);
    }

    private drawLineOrArrow(svg: SVGSVGElement, obj: LineObject | ArrowObject, pageId: string): void {
        if (obj.points.length < 2) return;

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", this.linePointsToPathData(obj.points));
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", obj.color);
        path.setAttribute("stroke-width", obj.width.toString());
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("data-object-id", obj.id);
        this.applyHighlighterOpacity(path, obj, pageId);
        svg.appendChild(path);

        if (obj.type !== "arrow") {
            this.renderLineLabel(svg, path, obj, pageId);
            return;
        }

        const totalLength = path.getTotalLength();
        if (totalLength <= 0) return;

        const arrowSize = Math.max(obj.width * 3, 6);
        const cutLength = arrowSize * 0.82;

        let startCut = 0, endCut = 0;
        if (obj.arrowStart) startCut = Math.min(cutLength, totalLength * 0.45);
        if (obj.arrowEnd) endCut = Math.min(cutLength, totalLength * 0.45);

        const visibleLength = totalLength - startCut - endCut;
        if (visibleLength > 0) {
            if (startCut > 0 || endCut > 0) {
                path.setAttribute("stroke-dasharray", `${visibleLength} ${totalLength}`);
                path.setAttribute("stroke-dashoffset", (-startCut).toString());
            }
        } else {
            path.setAttribute("stroke-dasharray", "0 999999");
        }

        if (obj.arrowEnd) this.drawArrowhead(svg, path, totalLength, obj.color, obj.width, obj.id, "end", obj.arrowSize);
        if (obj.arrowStart) this.drawArrowhead(svg, path, totalLength, obj.color, obj.width, obj.id, "start", obj.arrowSize);

        this.renderLineLabel(svg, path, obj, pageId);
    }

    private drawArrowhead(
        svg: SVGSVGElement,
        path: SVGPathElement,
        totalLength: number,
        color: string,
        strokeWidth: number,
        objectId: string,
        side: "start" | "end",
        explicitSize?: number,
    ): void {
        // Größeres Epsilon für stabilere Tangente (v. a. bei Kurven).
        const epsilon = Math.min(4, Math.max(1, totalLength * 0.08));

        const tipLength = side === "end" ? totalLength : 0;
        const nearLength = side === "end"
            ? Math.max(0, totalLength - epsilon)
            : Math.min(totalLength, epsilon);

        const tip = path.getPointAtLength(tipLength);
        const near = path.getPointAtLength(nearLength);

        let dx = tip.x - near.x, dy = tip.y - near.y;
        if (Math.hypot(dx, dy) < 1e-6) { dx = 1; dy = 0; }
        const angle = Math.atan2(dy, dx);

        const size = explicitSize ?? Math.max(strokeWidth * 3, 6);
        const backAngle1 = angle + Math.PI - Math.PI / 7;
        const backAngle2 = angle + Math.PI + Math.PI / 7;
        const back1 = { x: tip.x + size * Math.cos(backAngle1), y: tip.y + size * Math.sin(backAngle1) };
        const back2 = { x: tip.x + size * Math.cos(backAngle2), y: tip.y + size * Math.sin(backAngle2) };

        const head = document.createElementNS("http://www.w3.org/2000/svg", "path");
        head.setAttribute("d", `M ${tip.x} ${tip.y} L ${back1.x} ${back1.y} L ${back2.x} ${back2.y} Z`);
        head.setAttribute("fill", color);
        head.setAttribute("stroke", "none");
        head.setAttribute("data-object-id", objectId);
        head.setAttribute("data-arrowhead", side);
        svg.appendChild(head);
    }

    private drawPolygon(svg: SVGSVGElement, obj: PolygonObject, pageId: string): void {
        if (obj.points.length < 2) return;
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", this.linePointsToPathData(obj.points, true));
        path.setAttribute("stroke", obj.strokeColor);
        path.setAttribute("stroke-width", obj.strokeWidth.toString());
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("fill", obj.fillColor ?? "none");
        path.setAttribute("fill-opacity", (obj.fillOpacity ?? 1).toString());
        path.setAttribute("data-object-id", obj.id);
        this.applyHighlighterOpacity(path, obj, pageId);
        svg.appendChild(path);
        if (obj.label) {
            const cx = obj.points.reduce((s, p) => s + p.x, 0) / obj.points.length;
            const cy = obj.points.reduce((s, p) => s + p.y, 0) / obj.points.length;
            this.renderShapeLabel(svg, obj.id, obj.label, cx, cy, undefined);
        }
    }

    private drawRectangle(svg: SVGSVGElement, obj: RectangleObject, pageId: string): void {
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", obj.x.toString());
        rect.setAttribute("y", obj.y.toString());
        rect.setAttribute("width", obj.width.toString());
        rect.setAttribute("height", obj.height.toString());
        rect.setAttribute("stroke", obj.strokeColor);
        rect.setAttribute("stroke-width", obj.strokeWidth.toString());
        rect.setAttribute("fill", obj.fillColor ?? "none");
        rect.setAttribute("fill-opacity", (obj.fillOpacity ?? 1).toString());
        rect.setAttribute("data-object-id", obj.id);
        if (obj.rotation) {
            const cx = obj.x + obj.width / 2;
            const cy = obj.y + obj.height / 2;
            rect.setAttribute("transform", `rotate(${obj.rotation} ${cx} ${cy})`);
        }
        this.applyHighlighterOpacity(rect, obj, pageId);
        svg.appendChild(rect);
        if (obj.label) {
            this.renderShapeLabel(svg, obj.id, obj.label, obj.x + obj.width / 2, obj.y + obj.height / 2, obj.rotation);
        }
    }

    private drawTriangle(svg: SVGSVGElement, obj: TriangleObject, pageId: string): void {
        const { x, y, width, height } = obj;
        const points = obj.variant === "right"
            ? `${x},${y + height} ${x},${y} ${x + width},${y + height}`
            : `${x + width / 2},${y} ${x},${y + height} ${x + width},${y + height}`;
        const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        poly.setAttribute("points", points);
        poly.setAttribute("stroke", obj.strokeColor);
        poly.setAttribute("stroke-width", obj.strokeWidth.toString());
        poly.setAttribute("fill", obj.fillColor ?? "none");
        poly.setAttribute("fill-opacity", (obj.fillOpacity ?? 1).toString());
        poly.setAttribute("data-object-id", obj.id);
        if (obj.rotation) {
            const cx = x + width / 2;
            const cy = y + height / 2;
            poly.setAttribute("transform", `rotate(${obj.rotation} ${cx} ${cy})`);
        }
        this.applyHighlighterOpacity(poly, obj, pageId);
        svg.appendChild(poly);
        if (obj.label) {
            const centroidX = obj.variant === "right" ? x + width / 3 : x + width / 2;
            const centroidY = y + (height * 2) / 3;
            this.renderShapeLabel(svg, obj.id, obj.label, centroidX, centroidY, obj.rotation);
        }
    }

    private drawDiamond(svg: SVGSVGElement, obj: DiamondObject, pageId: string): void {
        const { x, y, width, height } = obj;
        const points = `${x + width / 2},${y} ${x + width},${y + height / 2} ${x + width / 2},${y + height} ${x},${y + height / 2}`;
        const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        poly.setAttribute("points", points);
        poly.setAttribute("stroke", obj.strokeColor);
        poly.setAttribute("stroke-width", obj.strokeWidth.toString());
        poly.setAttribute("fill", obj.fillColor ?? "none");
        poly.setAttribute("fill-opacity", (obj.fillOpacity ?? 1).toString());
        poly.setAttribute("data-object-id", obj.id);
        if (obj.rotation) {
            const cx = x + width / 2;
            const cy = y + height / 2;
            poly.setAttribute("transform", `rotate(${obj.rotation} ${cx} ${cy})`);
        }
        this.applyHighlighterOpacity(poly, obj, pageId);
        svg.appendChild(poly);
        if (obj.label) {
            this.renderShapeLabel(svg, obj.id, obj.label, x + width / 2, y + height / 2, obj.rotation);
        }
    }

    private drawEllipse(svg: SVGSVGElement, obj: EllipseObject, pageId: string): void {
        const ellipse = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
        ellipse.setAttribute("cx", obj.cx.toString());
        ellipse.setAttribute("cy", obj.cy.toString());
        ellipse.setAttribute("rx", obj.rx.toString());
        ellipse.setAttribute("ry", obj.ry.toString());
        ellipse.setAttribute("stroke", obj.strokeColor);
        ellipse.setAttribute("stroke-width", obj.strokeWidth.toString());
        ellipse.setAttribute("fill", obj.fillColor ?? "none");
        ellipse.setAttribute("fill-opacity", (obj.fillOpacity ?? 1).toString());
        ellipse.setAttribute("data-object-id", obj.id);
        if (obj.rotation) {
            ellipse.setAttribute("transform", `rotate(${obj.rotation} ${obj.cx} ${obj.cy})`);
        }
        this.applyHighlighterOpacity(ellipse, obj, pageId);
        svg.appendChild(ellipse);
        if (obj.label) {
            this.renderShapeLabel(svg, obj.id, obj.label, obj.cx, obj.cy, obj.rotation);
        }
    }

    /** Rendert eine mittige Text-Beschriftung für eine geschlossene Form (Rechteck, Ellipse, Dreieck, Polygon, Raute). */
    private renderShapeLabel(
        svg: SVGSVGElement,
        objId: string,
        label: ShapeLabel,
        centerX: number,
        centerY: number,
        rotationDeg: number | undefined,
    ): void {
        if (!label.text.trim()) return;
        const fontSize = label.fontSize ?? 14;
        const lines = label.text.split(/\r?\n/);
        const lineHeight = fontSize * 1.2;

        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("data-label-owner", objId);
        g.setAttribute("data-shape-label", "1");
        g.style.pointerEvents = "none";
        let transform = `translate(${centerX} ${centerY})`;
        if (rotationDeg) transform += ` rotate(${rotationDeg})`;
        g.setAttribute("transform", transform);

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("font-size", fontSize.toString());
        text.setAttribute("fill", label.color ?? "#1a1a1a");
        text.setAttribute("font-family", "sans-serif");
        const startY = -((lines.length - 1) * lineHeight) / 2 + fontSize * 0.35;
        lines.forEach((line, i) => {
            const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
            tspan.setAttribute("x", "0");
            tspan.setAttribute("y", (startY + i * lineHeight).toString());
            tspan.textContent = line;
            text.appendChild(tspan);
        });
        g.appendChild(text);
        svg.appendChild(g);
    }

    /**
     * Rendert eine Beschriftung für eine Linie/einen Pfeil. Im Modus "inline"
     * liegt der Text direkt auf der Linie (die Linie wird an der Stelle per
     * dasharray-Lücke unterbrochen). Im Modus "box" erscheint zusätzlich ein
     * kleiner Kasten, der die Linie an dieser Stelle überdeckt.
     *
     * BEKANNTE EINSCHRÄNKUNG: Ist an derselben Linie bereits wegen einer
     * Pfeilspitze ein dasharray gesetzt, wird die Lücke für das Label NICHT
     * zusätzlich eingefügt (ein SVG-Pfad kann nur ein dasharray-Muster
     * gleichzeitig haben) - der Text erscheint dann über der durchgezogenen
     * Linie statt in einer Lücke.
     */
    private renderLineLabel(svg: SVGSVGElement, path: SVGPathElement, obj: LineObject | ArrowObject, pageId: string): void {
        const label = obj.label;
        if (!label || !label.text.trim()) return;
        const totalLength = path.getTotalLength();
        if (totalLength <= 0) return;

        const fontSize = label.fontSize ?? 14;
        const lines = label.text.split(/\r?\n/);
        const maxCharsLine = Math.max(...lines.map(l => l.length), 1);
        const textWidth = maxCharsLine * fontSize * 0.6;
        const textHeight = lines.length * fontSize * 1.2;

        const mid = totalLength / 2;
        const epsilon = Math.min(4, Math.max(0.5, totalLength * 0.1));
        const p1 = path.getPointAtLength(Math.max(0, mid - epsilon));
        const p2 = path.getPointAtLength(Math.min(totalLength, mid + epsilon));
        const midPoint = path.getPointAtLength(mid);
        let angleDeg = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
        if (angleDeg > 90 || angleDeg < -90) angleDeg += 180; // Text nicht auf dem Kopf stehend darstellen

        const gapLength = Math.min(totalLength * 0.9, textWidth + fontSize);
        const gapStart = Math.max(0, mid - gapLength / 2);
        if (!path.getAttribute("stroke-dasharray")) {
            path.setAttribute("stroke-dasharray", `${gapStart} ${gapLength} ${totalLength}`);
        }

        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("data-label-owner", obj.id);
        g.setAttribute("data-line-label", "1");
        g.setAttribute("transform", `translate(${midPoint.x} ${midPoint.y}) rotate(${angleDeg})`);
        g.style.pointerEvents = "none";

        if (label.mode === "box") {
            const boxPadding = fontSize * 0.3;
            const boxW = textWidth + boxPadding * 2;
            const boxH = textHeight + boxPadding * 2;
            const page = this.getPageDefinition(pageId);
            const invert = page ? this.isPageInverted(page) : false;
            const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute("x", (-boxW / 2).toString());
            rect.setAttribute("y", (-boxH / 2).toString());
            rect.setAttribute("width", boxW.toString());
            rect.setAttribute("height", boxH.toString());
            rect.setAttribute("fill", invert ? "#1e1e1e" : "#ffffff");
            rect.setAttribute("stroke", obj.color);
            rect.setAttribute("stroke-width", "0.75");
            rect.setAttribute("rx", "3");
            g.appendChild(rect);
        }

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("font-size", fontSize.toString());
        text.setAttribute("fill", label.color ?? obj.color);
        text.setAttribute("font-family", "sans-serif");
        const lineHeight = fontSize * 1.2;
        const startY = -((lines.length - 1) * lineHeight) / 2 + fontSize * 0.35;
        lines.forEach((line, i) => {
            const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
            tspan.setAttribute("x", "0");
            tspan.setAttribute("y", (startY + i * lineHeight).toString());
            tspan.textContent = line;
            text.appendChild(tspan);
        });
        g.appendChild(text);
        svg.appendChild(g);
    }

    // ============================================================
    //  HIT-TEST FÜR RADIERER
    // ============================================================
    private elementHitTest(el: SVGGraphicsElement, point: { x: number; y: number }, threshold: number): boolean {
        const svgRoot = el.ownerSVGElement;
        if (!svgRoot) return false;
        const elCTM = el.getCTM();
        const rootCTM = svgRoot.getCTM();
        if (!elCTM || !rootCTM) return false;

        let localPt: DOMPoint;
        try {
            // elCTM.inverse() wirft bei einer entarteten (nicht
            // invertierbaren) Matrix - z. B. durch eine kurzzeitige
            // Vorschau-Transformation mit Skalierung nahe 0 während eines
            // Resize-Drags. Ohne Abfangen bricht das JEDEN weiteren
            // Radierer-Trefftest auf der Seite ab, solange das Element
            // existiert - sichtbar als "Radierer reagiert nicht mehr".
            const toLocal = elCTM.inverse().multiply(rootCTM);
            const pt = svgRoot.createSVGPoint();
            pt.x = point.x;
            pt.y = point.y;
            localPt = pt.matrixTransform(toLocal);
        } catch {
            return false;
        }

        try {
            if (el.getAttribute("fill") && el.getAttribute("fill") !== "none" && (el as any).isPointInFill) {
                if ((el as any).isPointInFill(localPt)) return true;
            }
        } catch { /* ignore */ }

        const bbox = el.getBBox();
        if (
            localPt.x < bbox.x - threshold || localPt.x > bbox.x + bbox.width + threshold ||
            localPt.y < bbox.y - threshold || localPt.y > bbox.y + bbox.height + threshold
        ) {
            return false;
        }
        return this.distanceToElementEdge(el, { x: localPt.x, y: localPt.y }) <= threshold;
    }

    private distanceToElementEdge(el: SVGGraphicsElement, point: { x: number; y: number }): number {
        const tag = el.tagName.toLowerCase();
        if (tag === "path") return this.distanceToSampledPath(el as SVGPathElement, point);
        if (tag === "polygon") {
            const svgPoints = (el as SVGPolygonElement).points;
            const verts: { x: number; y: number }[] = [];
            for (let i = 0; i < svgPoints.numberOfItems; i++) {
                const p = svgPoints.getItem(i);
                verts.push({ x: p.x, y: p.y });
            }
            return this.distanceToPolyline(verts, point, true);
        }
        if (tag === "rect") {
            const x = parseFloat(el.getAttribute("x") || "0");
            const y = parseFloat(el.getAttribute("y") || "0");
            const w = parseFloat(el.getAttribute("width") || "0");
            const h = parseFloat(el.getAttribute("height") || "0");
            const corners = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
            return this.distanceToPolyline(corners, point, true);
        }
        if (tag === "ellipse") {
            const cx = parseFloat(el.getAttribute("cx") || "0");
            const cy = parseFloat(el.getAttribute("cy") || "0");
            const rx = parseFloat(el.getAttribute("rx") || "1");
            const ry = parseFloat(el.getAttribute("ry") || "1");
            return this.ellipseEdgeDistance(cx, cy, rx, ry, point);
        }
        return Infinity;
    }

    private distanceToSampledPath(path: SVGPathElement, point: { x: number; y: number }): number {
        const length = path.getTotalLength();
        if (length === 0) {
            const p = path.getPointAtLength(0);
            return Math.hypot(p.x - point.x, p.y - point.y);
        }
        const steps = Math.min(200, Math.max(20, Math.floor(length / 2)));
        let minDist = Infinity;
        for (let i = 0; i <= steps; i++) {
            const p = path.getPointAtLength((length * i) / steps);
            const dist = Math.hypot(p.x - point.x, p.y - point.y);
            if (dist < minDist) minDist = dist;
        }
        return minDist;
    }

    private distanceToPolyline(verts: { x: number; y: number }[], point: { x: number; y: number }, closed: boolean): number {
        let minDist = Infinity;
        const n = verts.length;
        const limit = closed ? n : n - 1;
        for (let i = 0; i < limit; i++) {
            const dist = this.distancePointToSegment(point, verts[i], verts[(i + 1) % n]);
            if (dist < minDist) minDist = dist;
        }
        return minDist;
    }

    private distancePointToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
        const dx = b.x - a.x, dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    }

    private ellipseEdgeDistance(cx: number, cy: number, rx: number, ry: number, point: { x: number; y: number }): number {
        const theta = Math.atan2((point.y - cy) / ry, (point.x - cx) / rx);
        const at = (t: number) => ({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
        let best = at(theta);
        let bestDist = Math.hypot(point.x - best.x, point.y - best.y);
        for (const delta of [-0.05, 0.05]) {
            const p = at(theta + delta);
            const d = Math.hypot(point.x - p.x, point.y - p.y);
            if (d < bestDist) { bestDist = d; best = p; }
        }
        return bestDist;
    }

    private findTopmostObjectAt(pageId: string, point: { x: number; y: number }): SVGElement | null {
        const elements = this.ui.queryAllObjectElements(pageId);
        for (let i = elements.length - 1; i >= 0; i--) {
            if (this.elementHitTest(elements[i], point, 5)) return elements[i];
        }
        return null;
    }

    /**
 * Prüft, ob der Punkt (in SVG-Koordinaten der Seitensicht) auf einem der
 * aktuell ausgewählten Textblöcke liegt. Wird von startSelectionInteraction()
 * genutzt, um zu entscheiden, ob ein Move-Drag gestartet werden soll.
 */
    private pointHitsAnySelectedTextBlock(pageId: string, point: { x: number; y: number }): boolean {
        if (this.selectedTextBlockIds.size === 0) return false;
        const blocks = this.textBlocksCache.get(pageId) ?? [];
        const svg = this.ui.annotationLayers.get(pageId);
        if (!svg) return false;
        const vb = svg.getAttribute("viewBox")?.split(/\s+/).map(Number);
        if (!vb) return false;
        const vbW = vb[2];
        const scaleForPage = this.pageScales.get(pageId) ?? DEFAULT_RENDER_SCALE;
        // Textblöcke werden mit `scaleForPage` multipliziert positioniert (siehe
        // PdfComposeUI.renderTextBlock: left = entry.x * scale). Daher hier die
        // Koordinaten mit demselben Faktor zurückrechnen.
        const pagePointX = point.x;
        const pagePointY = point.y;
        const _ = vbW; // nur zur Klarheit der Einheit (Punkt ist bereits in SVG-viewBox)
        for (const block of blocks) {
            if (!this.selectedTextBlockIds.has(block.id)) continue;
            const bx = block.x * scaleForPage;
            const by = block.y * scaleForPage;
            const bw = block.width * scaleForPage;
            // Höhe unbekannt - konservativ schätzen: mindestens 40 viewBox-Einheiten.
            const bh = 40;
            if (pagePointX >= bx && pagePointX <= bx + bw &&
                pagePointY >= by && pagePointY <= by + bh) {
                return true;
            }
        }
        return false;
    }

    // ============================================================
    //  ENDPUNKT-BINDUNGEN (Linien/Pfeile an Formen anheften)
    // ============================================================

    /** Achsenparallele Bounding-Box + Rotation einer bindbaren Form, im un-rotierten Koordinatensystem. */
    private getShapeBoundsForBinding(obj: VectorObject): { x: number; y: number; width: number; height: number; rotation: number } | null {
        switch (obj.type) {
            case "rectangle":
            case "diamond":
                return { x: obj.x, y: obj.y, width: obj.width, height: obj.height, rotation: obj.rotation ?? 0 };
            case "triangle": {
                const width = obj.width ?? obj.size ?? 0;
                const height = obj.height ?? obj.size ?? 0;
                return { x: obj.x, y: obj.y, width, height, rotation: obj.rotation ?? 0 };
            }
            case "ellipse":
                return { x: obj.cx - obj.rx, y: obj.cy - obj.ry, width: obj.rx * 2, height: obj.ry * 2, rotation: obj.rotation ?? 0 };
            case "polygon": {
                const xs = obj.points.map(p => p.x), ys = obj.points.map(p => p.y);
                return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), rotation: 0 };
            }
            default:
                return null;
        }
    }

    /** Berechnet den absoluten Punkt für eine gespeicherte relative Bindungsposition (ax/ay, 0..1) auf einer Form. */
    private resolveBindingPoint(target: VectorObject, ax: number, ay: number): { x: number; y: number } | null {
        const bounds = this.getShapeBoundsForBinding(target);
        if (!bounds) return null;
        const localX = bounds.x + ax * bounds.width;
        const localY = bounds.y + ay * bounds.height;
        if (!bounds.rotation) return { x: localX, y: localY };
        const cx = bounds.x + bounds.width / 2;
        const cy = bounds.y + bounds.height / 2;
        return this.rotatePoint({ x: localX, y: localY }, { x: cx, y: cy }, bounds.rotation);
    }

    /** Kehrt resolveBindingPoint() um: aus einem absoluten Punkt die relative (0..1) Position auf der Form. */
    private computeBindingFraction(target: VectorObject, point: { x: number; y: number }): { ax: number; ay: number } | null {
        const bounds = this.getShapeBoundsForBinding(target);
        if (!bounds || bounds.width === 0 || bounds.height === 0) return null;
        let local = point;
        if (bounds.rotation) {
            const cx = bounds.x + bounds.width / 2;
            const cy = bounds.y + bounds.height / 2;
            local = this.rotatePoint(point, { x: cx, y: cy }, -bounds.rotation);
        }
        const ax = (local.x - bounds.x) / bounds.width;
        const ay = (local.y - bounds.y) / bounds.height;
        return { ax: Math.max(0, Math.min(1, ax)), ay: Math.max(0, Math.min(1, ay)) };
    }

    /** true, wenn `point` innerhalb (± margin) der Bounding-Box einer bindbaren Form liegt. */
    private isPointNearOrInShapeBounds(obj: VectorObject, point: { x: number; y: number }, margin: number = 6): boolean {
        const bounds = this.getShapeBoundsForBinding(obj);
        if (!bounds) return false;
        let local = point;
        if (bounds.rotation) {
            const cx = bounds.x + bounds.width / 2;
            const cy = bounds.y + bounds.height / 2;
            local = this.rotatePoint(point, { x: cx, y: cy }, -bounds.rotation);
        }
        return local.x >= bounds.x - margin && local.x <= bounds.x + bounds.width + margin &&
            local.y >= bounds.y - margin && local.y <= bounds.y + bounds.height + margin;
    }

    /** Sucht die oberste bindbare Form (Rechteck/Ellipse/Dreieck/Raute/Polygon) unter `point`. */
    private findBindableShapeAt(pageId: string, point: { x: number; y: number }, excludeId?: string): VectorObject | null {
        const objects = this.getPageAnnotations(pageId);
        const bindableTypes = new Set(["rectangle", "ellipse", "triangle", "diamond", "polygon"]);
        for (let i = objects.length - 1; i >= 0; i--) {
            const obj = objects[i];
            if (obj.id === excludeId) continue;
            if (!bindableTypes.has(obj.type)) continue;
            if (this.isPointNearOrInShapeBounds(obj, point)) return obj;
        }
        return null;
    }

    /** Hebt die Form hervor, über der gerade ein Linien-/Pfeil-Endpunkt gehalten wird (visuelle Rückmeldung für die Bindung). */
    private setBindTargetHighlight(pageId: string, objectId: string | null): void {
        if (this.currentBindHighlightId === objectId) return;
        if (this.currentBindHighlightId) {
            this.ui.findObjectElementById(pageId, this.currentBindHighlightId)?.classList.remove("pdfcompose-bind-target");
        }
        this.currentBindHighlightId = objectId;
        if (objectId) {
            this.ui.findObjectElementById(pageId, objectId)?.classList.add("pdfcompose-bind-target");
        }
    }

    /**
     * Rechnet für alle Linien/Pfeile mit Endpunkt-Bindung den tatsächlichen
     * Punkt anhand der AKTUELLEN Position/Rotation/Größe der Zielform neu
     * aus. Wird vor jedem Speichern aufgerufen (siehe setPageAnnotations),
     * damit gebundene Pfeile automatisch "mitwandern", egal ob die Zielform
     * verschoben, skaliert oder rotiert wurde.
     */
    private resolveAllBindings(objects: VectorObject[]): VectorObject[] {
        const byId = new Map(objects.map(o => [o.id, o]));
        let changed = false;
        const result = objects.map(obj => {
            if (obj.type !== "line" && obj.type !== "arrow") return obj;
            if (!obj.startBinding && !obj.endBinding) return obj;
            const points = [...obj.points];
            let touched = false;
            if (obj.startBinding) {
                const target = byId.get(obj.startBinding.objectId);
                const p = target ? this.resolveBindingPoint(target, obj.startBinding.ax, obj.startBinding.ay) : null;
                if (p) { points[0] = { ...points[0], x: p.x, y: p.y }; touched = true; }
            }
            if (obj.endBinding) {
                const target = byId.get(obj.endBinding.objectId);
                const p = target ? this.resolveBindingPoint(target, obj.endBinding.ax, obj.endBinding.ay) : null;
                if (p) { points[points.length - 1] = { ...points[points.length - 1], x: p.x, y: p.y }; touched = true; }
            }
            if (touched) changed = true;
            return touched ? { ...obj, points } : obj;
        });
        return changed ? result : objects;
    }

    // ============================================================
    //  PERSISTENZ & CACHE
    // ============================================================
    public getPageAnnotations(pageId: string): VectorObject[] {
        const cached = this.annotationsCache.get(pageId);
        if (cached) return cached;
        if (!this.currentFile) return [];

        let objects: VectorObject[] = [];
        try {
            // Der eigene, synchron gehaltene Stand hat Vorrang vor dem (nachhinkenden) metadataCache
            let encoded = this.currentDocument?.annotations[pageId];
            if (encoded === undefined) {
                const doc = parseFrontmatter(this.app.metadataCache.getFileCache(this.currentFile));
                encoded = doc.annotations[pageId];
            }
            objects = decodeAnnotations(encoded ?? []);
        } catch (e) {
            console.warn(`PdfCompose: Annotationen von Seite ${pageId} konnten nicht dekodiert werden`, e);
        }

        const labels = this.shapeLabelsCache.get(pageId) ?? [];
        for (const labelEntry of labels) {
            const shape = objects.find((o) => o.id === labelEntry.shapeId);
            if (!shape) continue;
            (shape as any).label = {
                text: labelEntry.text,
                fontSize: labelEntry.fontSize,
                color: labelEntry.color,
                mode: labelEntry.mode,
            };
        }

        this.annotationsCache.set(pageId, objects);
        return objects;
    }

    private async setPageAnnotations(
        pageId: string,
        objects: VectorObject[],
        options: { removedIds?: Set<string> } = {}
    ): Promise<void> {
        const resolved = this.resolveAllBindings(objects);
        this.annotationsCache.set(pageId, resolved);
        // Schnellpfad: nur Entfernen und keine Bindungs-Änderungen -> kein Komplett-Redraw
        const fast = !!options.removedIds && resolved === objects;
        if (fast) this.removeObjectElements(pageId, options.removedIds!);
        const encoded = encodeAnnotations(resolved);
        await this.writeAnnotations(pageId, encoded);
        if (!fast) this.redrawPageFromCache(pageId);
    }

    private removeObjectElements(pageId: string, ids: Set<string>): void {
        for (const layer of this.ui.getObjectLayers(pageId)) {
            layer.querySelectorAll<SVGElement>("[data-object-id], [data-label-owner]").forEach((el) => {
                const id = el.getAttribute("data-object-id") ?? el.getAttribute("data-label-owner");
                if (id && ids.has(id)) el.remove();
            });
        }
        if (pageId === this.selectionPageId) void this.renderSelectionHandles();
    }

    private async writeAnnotations(pageId: string, encoded: string[]): Promise<void> {
        if (!this.currentFile) return;
        if (this.currentDocument) this.currentDocument.annotations[pageId] = encoded;
        await this.modifyFrontmatterSilently((frontmatter) => {
            if (!frontmatter.annotations) frontmatter.annotations = {};
            frontmatter.annotations[pageId] = encoded;
        });
    }

    private redrawPageFromCache(pageId: string): void {
        const svg = this.ui.annotationLayers.get(pageId);
        const highlightSvg = this.ui.highlightLayers.get(pageId);
        if (!svg) return;
        if (this.handleDragMode !== null && pageId === this.selectionPageId) return;

        svg.querySelectorAll("[data-object-id], [data-label-owner]").forEach(el => el.remove());
        svg.querySelector(".pdfcompose-selection-handles")?.remove();
        highlightSvg?.querySelectorAll("[data-object-id], [data-label-owner]").forEach(el => el.remove());

        // getPageAnnotations lädt bei leerem Cache nach, statt eine leere Seite zu zeichnen
        const objects = this.getPageAnnotations(pageId);
        for (const obj of objects) {
            try {
                this.drawVectorObject(pageId, obj);
            } catch (e) {
                console.warn("PdfCompose: Objekt konnte nicht gezeichnet werden", obj.id, e);
            }
        }
        this.ui.updateSelectionHighlight(pageId, this.selectedIds, this.selectedTextBlockIds, this.selectedPdfAnnotationIds);
        if (pageId === this.selectionPageId) {
            void this.renderSelectionHandles();
        }
    }

    private async addObjectRaw(pageId: string, obj: VectorObject): Promise<void> {
        const existing = this.getPageAnnotations(pageId);
        await this.setPageAnnotations(pageId, [...existing, obj]);
    }



    private async removeObjectsRaw(pageId: string, ids: Set<string>): Promise<void> {
        const existing = this.getPageAnnotations(pageId);
        const remaining = existing.filter(o => !ids.has(o.id));
        await this.setPageAnnotations(pageId, remaining, { removedIds: ids });
    }

    private async saveNewObject(pageId: string, obj: VectorObject): Promise<void> {
        await this.addObjectRaw(pageId, obj);
        this.pushUndo({
            label: "add-object",
            undo: async () => { await this.removeObjectsRaw(pageId, new Set([obj.id])); },
            redo: async () => { await this.addObjectRaw(pageId, obj); },
        });
    }

    private async deleteAnnotationObjects(pageId: string, idsToRemove: Set<string>): Promise<void> {
        if (idsToRemove.size === 0) return;
        const existing = this.getPageAnnotations(pageId);
        const removed = existing.filter(o => idsToRemove.has(o.id));
        if (removed.length === 0) return;

        await this.removeObjectsRaw(pageId, idsToRemove);

        this.pushUndo({
            label: "delete-objects",
            undo: async () => {
                const current = this.getPageAnnotations(pageId);
                await this.setPageAnnotations(pageId, [...current, ...removed]);
            },
            redo: async () => { await this.removeObjectsRaw(pageId, idsToRemove); },
        });
    }

    // ============================================================
    //  STILÄNDERUNGEN
    // ============================================================
    private renderAnnotationPanel(): void {
        const hasSelection = this.selectedIds.size > 0;
        const selectedTypes = hasSelection ? this.getSelectedObjectTypes() : new Set<VectorObject["type"]>();
        const hasFreehandSelection = hasSelection && selectedTypes.has("freehand");

        let style: {
            strokeColor: string;
            strokeWidth: number;
            fillEnabled: boolean;
            fillColor: string;
            fillOpacity: number;
            segmentKind: LineSegmentKind;
            arrowSide: ArrowSide;
            arrowSize?: number;
            selectionMode: SelectionMode;
            pressure: PressureSettings;
            highlighter: boolean;
            eraserTargets: FilterTargets;
            selectionTargets: FilterTargets;
            isHighlighterShape: boolean;
        };

        if (hasSelection && this.selectionPageId) {
            const objects = this.getPageAnnotations(this.selectionPageId);
            const selectedObjects = objects.filter(o => this.selectedIds.has(o.id));
            if (selectedObjects.length > 0) {
                const ref = selectedObjects[0];
                let strokeColor = this.styleStrokeColor;
                let strokeWidth = this.styleStrokeWidth;
                let fillColor = this.styleFillColor;
                let fillOpacity = this.styleFillOpacity;
                let segmentKind = this.styleSegmentKind;
                let arrowSide = this.styleArrowSide;
                let fillEnabled = this.styleFillEnabled;

                // Stile aus dem ersten Objekt extrahieren
                if ('color' in ref) {
                    strokeColor = ref.color;
                    if ('width' in ref && typeof ref.width === 'number') {
                        strokeWidth = ref.width;
                    }
                } else if ('strokeColor' in ref) {
                    strokeColor = ref.strokeColor;
                    if ('strokeWidth' in ref && typeof ref.strokeWidth === 'number') {
                        strokeWidth = ref.strokeWidth;
                    }
                }
                if ('fillColor' in ref) {
                    fillColor = ref.fillColor || this.styleFillColor;
                    fillOpacity = ref.fillOpacity !== undefined ? ref.fillOpacity : this.styleFillOpacity;
                    fillEnabled = ref.fillColor !== undefined && ref.fillColor !== null && ref.fillColor !== "";
                }
                let isHighlighterShape = this.styleShapeHighlighter;
                if ('isHighlighter' in ref) {
                    isHighlighterShape = (ref as any).isHighlighter === true;
                }
                if (ref.type === "line" || ref.type === "arrow" || ref.type === "polygon") {
                    if (ref.points.length > 1 && ref.points[1].segment) {
                        segmentKind = ref.points[1].segment;
                    }
                }
                if (ref.type === "arrow") {
                    const start = ref.arrowStart || false;
                    const end = ref.arrowEnd || false;
                    if (start && end) arrowSide = "both";
                    else if (start) arrowSide = "start";
                    else if (end) arrowSide = "end";
                    else arrowSide = "end";
                }
                let arrowSize: number | undefined = undefined;
                if (ref.type === "arrow") {
                    arrowSize = ref.arrowSize;
                }

                style = {
                    strokeColor,
                    strokeWidth,
                    fillEnabled,
                    fillColor,
                    fillOpacity,
                    segmentKind,
                    arrowSide,
                    arrowSize,
                    selectionMode: this.selectionMode,
                    pressure: { enabled: false, minFactor: 0, curve: "linear" },
                    highlighter: false,
                    isHighlighterShape,
                    eraserTargets: this.eraserTargets,
                    selectionTargets: this.selectionTargets,
                };

                if (hasFreehandSelection) {
                    const firstFreehand = selectedObjects.find(o => o.type === "freehand") as FreehandObject | undefined;
                    if (firstFreehand) {
                        // Werte aus dem Objekt übernehmen
                        style.pressure = {
                            enabled: firstFreehand.pressureEnabled ?? false,
                            minFactor: firstFreehand.pressureMinFactor ?? 0,
                            curve: firstFreehand.pressureCurve ?? "linear",
                        };
                        style.highlighter = firstFreehand.highlighter ?? false;
                        style.strokeWidth = firstFreehand.strokeWidth;
                    } else {
                        // Fallback: aktiver Stift
                        const pen = this.getActivePenPreset();
                        style.pressure = pen.pressure;
                        style.highlighter = pen.highlighter;
                        style.strokeWidth = pen.strokeWidth;
                    }
                }
            } else {
                style = this.getDefaultStyle();
            }
        } else {
            style = this.getDefaultStyle();
        }

        this.ui.renderAnnotationPanel(
            this.currentTool,
            style,
            hasSelection,
            selectedTypes,
            this.selectionPageId,
            hasFreehandSelection,
            {
                onStyleChange: (patch: any) => {
                    if (this.selectedIds.size > 0) {
                        this.schedulePersistStyleToSelection(patch);
                    } else if (isPenTool(this.currentTool)) {
                        const pen = this.penPresets.get(this.currentTool);
                        if (pen) this.applyPenStylePatch(pen, patch);
                    } else {
                        // Globale Stile ändern
                        if (patch.strokeColor !== undefined) this.styleStrokeColor = patch.strokeColor;
                        if (patch.strokeWidth !== undefined) this.styleStrokeWidth = patch.strokeWidth;
                        if (patch.fillColor !== undefined) {
                            this.styleFillColor = patch.fillColor;
                            this.styleFillEnabled = true;
                        }
                        if (patch.fillOpacity !== undefined) {
                            this.styleFillOpacity = patch.fillOpacity;
                            this.styleFillEnabled = true;
                        }
                        if (patch.segmentKind !== undefined) this.styleSegmentKind = patch.segmentKind;
                        if (patch.arrowStart !== undefined || patch.arrowEnd !== undefined) {
                            const start = patch.arrowStart ?? (this.styleArrowSide === 'start' || this.styleArrowSide === 'both');
                            const end = patch.arrowEnd ?? (this.styleArrowSide === 'end' || this.styleArrowSide === 'both');
                            if (start && end) this.styleArrowSide = 'both';
                            else if (start) this.styleArrowSide = 'start';
                            else if (end) this.styleArrowSide = 'end';
                            else this.styleArrowSide = 'end';
                        }
                        this.renderAnnotationPanel();
                    }
                },
                onSelectionModeChange: (mode: SelectionMode) => {
                    this.selectionMode = mode;
                    this.renderAnnotationPanel();
                },
                onEraserTargetsChange: (patch: Partial<FilterTargets>) => {
                    this.eraserTargets = { ...this.eraserTargets, ...patch };
                    this.renderAnnotationPanel();
                },
                onSelectionTargetsChange: (patch: Partial<FilterTargets>) => {
                    Object.assign(this.selectionTargets, patch);
                    this.renderAnnotationPanel();
                },
            }
        );

        this.updateActionButtonsState();
    }

    /** Hilfsmethode für den Standard-Stil (keine Auswahl). */
    private getDefaultStyle(): {
        strokeColor: string;
        strokeWidth: number;
        fillEnabled: boolean;
        fillColor: string;
        fillOpacity: number;
        segmentKind: LineSegmentKind;
        arrowSide: ArrowSide;
        arrowSize?: number;
        selectionMode: SelectionMode;
        pressure: PressureSettings;
        highlighter: boolean;
        isHighlighterShape: boolean;
        eraserTargets: FilterTargets;
        selectionTargets: FilterTargets;
    } {
        const pen = isPenTool(this.currentTool) ? this.penPresets.get(this.currentTool) : undefined;
        return {
            strokeColor: pen ? pen.color : this.styleStrokeColor,
            strokeWidth: pen ? pen.strokeWidth : this.styleStrokeWidth,
            fillEnabled: this.styleFillEnabled,
            fillColor: this.styleFillColor,
            fillOpacity: this.styleFillOpacity,
            segmentKind: this.styleSegmentKind,
            arrowSide: this.styleArrowSide,
            arrowSize: this.styleArrowSize,
            selectionMode: this.selectionMode,
            pressure: pen ? pen.pressure : { enabled: false, minFactor: 0, curve: "linear" },
            highlighter: pen ? pen.highlighter : false,
            isHighlighterShape: this.styleShapeHighlighter,
            eraserTargets: this.eraserTargets,
            selectionTargets: this.selectionTargets,
        };
    }

    private applyPenStylePatch(pen: PenPreset, patch: Record<string, any>): void {
        if (patch.strokeColor !== undefined) pen.color = patch.strokeColor;
        if (patch.strokeWidth !== undefined) pen.strokeWidth = patch.strokeWidth;
        if (patch.pressureEnabled !== undefined) pen.pressure.enabled = patch.pressureEnabled;
        if (patch.pressureMinFactor !== undefined) pen.pressure.minFactor = patch.pressureMinFactor;
        if (patch.pressureCurve !== undefined) pen.pressure.curve = patch.pressureCurve as PressureCurve;
        if (patch.highlighter !== undefined) pen.highlighter = patch.highlighter;

        if (patch.strokeColor !== undefined) {
            this.ui.updatePenToolColor(pen.id, pen.color);
        }
        this.renderAnnotationPanel();
    }

    private getSelectedObjectTypes(): Set<VectorObject["type"]> {
        const types = new Set<VectorObject["type"]>();
        if (!this.selectionPageId) return types;
        for (const obj of this.getPageAnnotations(this.selectionPageId)) {
            if (this.selectedIds.has(obj.id)) types.add(obj.type);
        }
        return types;
    }

    private schedulePersistStyleToSelection(patch: Record<string, any>): void {
        this.pendingStylePatch = { ...(this.pendingStylePatch ?? {}), ...patch };
        if (this.styleWriteDebounceTimer !== null) {
            window.clearTimeout(this.styleWriteDebounceTimer);
        }
        this.styleWriteDebounceTimer = window.setTimeout(() => {
            const patchToApply = this.pendingStylePatch;
            this.pendingStylePatch = null;
            this.styleWriteDebounceTimer = null;
            if (!patchToApply) return;
            void this.applyStyleToSelection(patchToApply).then(() => {
                this.renderAnnotationPanel();
            });
        }, 250);
    }

    private async applyStylePatchRaw(
        pageId: string,
        ids: Set<string>,
        patch: Partial<{
            strokeColor: string;
            strokeWidth: number;
            fillColor: string | undefined;
            fillOpacity: number;
            segmentKind: LineSegmentKind;
            arrowStart: boolean;
            arrowEnd: boolean;
            arrowSize: number;
            highlighter: boolean;
            pressureEnabled: boolean;
            pressureMinFactor: number;
            pressureCurve: PressureCurve;
            isHighlighter?: boolean;
        }>
    ): Promise<void> {
        const objects = this.getPageAnnotations(pageId);
        const updated = objects.map((obj): VectorObject => {
            if (!ids.has(obj.id)) return obj;
            const next: any = { ...obj };

            // --- Allgemeine Felder ---
            if (patch.strokeColor !== undefined) {
                if ("color" in next) next.color = patch.strokeColor;
                if ("strokeColor" in next) next.strokeColor = patch.strokeColor;
            }
            if (patch.strokeWidth !== undefined) {
                if ("width" in next) next.width = patch.strokeWidth;
                if ("strokeWidth" in next) next.strokeWidth = patch.strokeWidth;
                // Bei Freihand: nur strokeWidth speichern, nicht w der Punkte ändern!
                if (obj.type === "freehand") {
                    next.strokeWidth = patch.strokeWidth;
                    // w wird beim Zeichnen dynamisch berechnet
                }
            }
            if (patch.fillColor !== undefined && "fillColor" in next) {
                next.fillColor = patch.fillColor;
            }
            if (patch.fillOpacity !== undefined && "fillOpacity" in next) {
                next.fillOpacity = patch.fillOpacity;
            }
            if (patch.segmentKind !== undefined &&
                (obj.type === "line" || obj.type === "arrow" || obj.type === "polygon")) {
                next.points = next.points.map((point: LinePoint, index: number) =>
                    index === 0 ? point : { ...point, segment: patch.segmentKind }
                );
            }
            if (obj.type === "arrow") {
                if (patch.arrowStart !== undefined) next.arrowStart = patch.arrowStart;
                if (patch.arrowEnd !== undefined) next.arrowEnd = patch.arrowEnd;
                if (patch.arrowSize !== undefined) next.arrowSize = patch.arrowSize;
            }
            if (patch.isHighlighter !== undefined && obj.type !== "freehand") {
                next.isHighlighter = patch.isHighlighter;
            }

            // --- Freihand‑spezifische Felder ---
            if (obj.type === "freehand") {
                if (patch.highlighter !== undefined) next.highlighter = patch.highlighter;
                if (patch.pressureEnabled !== undefined) next.pressureEnabled = patch.pressureEnabled;
                if (patch.pressureMinFactor !== undefined) next.pressureMinFactor = patch.pressureMinFactor;
                if (patch.pressureCurve !== undefined) next.pressureCurve = patch.pressureCurve;
            }

            return next as VectorObject;
        });

        await this.setPageAnnotations(pageId, updated);
    }

    private async applyStyleToSelection(patch: Partial<{
        strokeColor: string;
        strokeWidth: number;
        fillColor: string | undefined;
        fillOpacity: number;
        segmentKind: LineSegmentKind;
        arrowStart: boolean;
        arrowEnd: boolean;
        arrowSize: number;
    }>): Promise<void> {
        const pageId = this.selectionPageId;
        if (!pageId || this.selectedIds.size === 0) return;

        const ids = new Set(this.selectedIds);
        const before = this.getPageAnnotations(pageId).filter(o => ids.has(o.id));

        await this.applyStylePatchRaw(pageId, ids, patch);

        // Seite neu zeichnen und Panel aktualisieren
        this.redrawPageFromCache(pageId);
        this.renderAnnotationPanel();

        this.pushUndo({
            label: "style-selection",
            undo: async () => {
                const current = this.getPageAnnotations(pageId);
                const map = new Map(before.map(o => [o.id, o]));
                const restored = current.map(o => map.get(o.id) ?? o);
                await this.setPageAnnotations(pageId, restored);
                this.redrawPageFromCache(pageId);
                this.renderAnnotationPanel();
            },
            redo: async () => {
                await this.applyStylePatchRaw(pageId, ids, patch);
                this.redrawPageFromCache(pageId);
                this.renderAnnotationPanel();
            },
        });
    }

    // ============================================================
    //  AUSWAHL-HANDLES
    // ============================================================
    private async renderSelectionHandles(): Promise<void> {
        if (!this.selectionPageId || this.selectedIds.size === 0) {
            for (const svg of this.ui.annotationLayers.values()) {
                svg.querySelector(".pdfcompose-selection-handles")?.remove();
            }
            this.ui.selectionHandlesGroup = null;
            return;
        }
        const objects = this.getPageAnnotations(this.selectionPageId);
        const selected = objects.filter(o => this.selectedIds.has(o.id));
        if (selected.length === 0) {
            this.selectedIds.clear();
            this.selectionPageId = null;
            return;
        }
        const pageId = this.selectionPageId;
        this.ui.renderSelectionHandles(
            pageId,
            this.selectedIds,
            objects,
            (
                evt: PointerEvent,
                mode: "rotate" | "scale-corner",
                svg: SVGSVGElement,
                cornerIdx?: number,
            ) => this.startHandleDrag(evt, mode, svg, cornerIdx ?? 0)
        );

        if (selected.length === 1) {
            const obj = selected[0];
            const boundIndices = new Set<number>();
            if (obj.type === "line" || obj.type === "arrow") {
                if ((obj as any).startBinding) boundIndices.add(0);
                if ((obj as any).endBinding) boundIndices.add(obj.points.length - 1);
            }
            this.ui.renderPointHandles(
                pageId,
                obj,
                (evt, index, svg) => this.startPointDrag(evt, pageId, obj.id, index, svg),
                boundIndices
            );

            const handles = this.ui.selectionHandlesGroup
                ?.querySelectorAll<SVGCircleElement>(".pdfcompose-point-handle");
            if (handles) {
                for (const handle of Array.from(handles)) {
                    const indexAttr = handle.getAttribute("data-point-index");
                    if (indexAttr === null) continue;
                    const idx = parseInt(indexAttr, 10);
                    handle.addEventListener("contextmenu", (e: MouseEvent) => {
                        this.onPointContextMenu(e, pageId, obj.id, idx);
                    });
                }
            }
        }
    }

    // ============================================================
    //  UNDO / REDO
    // ============================================================
    private pushUndo(command: UndoableCommand): void {
        this.undoManager.push(command);
        this.ui?.updateUndoRedoButtons(this.undoManager.canUndo(), this.undoManager.canRedo());
    }

    public async undo(): Promise<void> {
        if (!this.undoManager.canUndo()) return;
        await this.undoManager.undo();
        this.ui?.updateUndoRedoButtons(this.undoManager.canUndo(), this.undoManager.canRedo());
    }

    public async redo(): Promise<void> {
        if (!this.undoManager.canRedo()) return;
        await this.undoManager.redo();
        this.ui?.updateUndoRedoButtons(this.undoManager.canUndo(), this.undoManager.canRedo());
    }

    private isViewFocused(): boolean {
        const active = document.activeElement as HTMLElement | null;
        if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable)) {
            return false;
        }
        if (active && this.containerEl.contains(active)) return true;
        return this.app.workspace.getActiveViewOfType(PdfComposeView) === this;
    }

    /** Registriert Touch-/Pinch-Handling. Ersetzt den früheren Inline-Block in onOpen(). */
    private registerTouchGestureHandlers(): void {
        const pagesEl = this.ui.pagesContainerEl;
        const isOnPages = (e: Event) => e.target instanceof Node && pagesEl.contains(e.target);

        // Verhindert, dass horizontale Wischgesten die native Obsidian-Seitenleiste
        // öffnen. Bei zwei Fingern auf der Seitenfläche zusätzlich die native
        // Scroll-/Zoom-Geste unterdrücken, damit sie nicht parallel zum eigenen
        // Pinch-Zoom scrollt (und pointercancel auslöst).
        this.registerDomEvent(this.containerEl, "touchstart", (e: TouchEvent) => {
            e.stopPropagation();
            if (e.touches.length >= 2 && e.cancelable && isOnPages(e)) e.preventDefault();
        }, { capture: true, passive: false });
        this.registerDomEvent(this.containerEl, "touchmove", (e: TouchEvent) => {
            e.stopPropagation();
            if (e.touches.length >= 2 && e.cancelable && isOnPages(e)) e.preventDefault();
        }, { capture: true, passive: false });

        this.registerDomEvent(pagesEl, "pointerdown", (e: PointerEvent) => {
            if (e.pointerType !== "touch") return;

            // Der erste Finger einer neuen Geste ist immer "primary". Dann kann es
            // keine anderen aktiven Touch-Pointer geben -> veraltete Einträge
            // (verlorene pointerup/pointercancel) verwerfen.
            if (e.isPrimary) this.resetTouchTracking();

            this.activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (this.activeTouchPointers.size === 2) {
                this.cancelActiveTouchInteractions();
                const [a, b] = Array.from(this.activeTouchPointers.values());
                this.pinchStartDistance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
                this.pinchStartZoom = this.zoomLevel;
                this.pinchAnchor = this.captureZoomAnchor((a.x + b.x) / 2, (a.y + b.y) / 2);
            }
        }, { capture: true });

        this.registerDomEvent(pagesEl, "pointermove", (e: PointerEvent) => {
            if (e.pointerType !== "touch" || !this.activeTouchPointers.has(e.pointerId)) return;
            this.activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (this.activeTouchPointers.size >= 2 && this.pinchStartDistance) {
                e.preventDefault();
                const [a, b] = Array.from(this.activeTouchPointers.values());
                const distance = Math.hypot(a.x - b.x, a.y - b.y);
                const factor = distance / this.pinchStartDistance;
                const midX = (a.x + b.x) / 2;
                const midY = (a.y + b.y) / 2;
                this.setZoom(this.pinchStartZoom * factor, midX, midY, true, this.pinchAnchor);
            }
        }, { capture: true });

        const endTouchPointer = (e: PointerEvent) => {
            if (e.pointerType !== "touch") return;
            this.activeTouchPointers.delete(e.pointerId);
            if (this.activeTouchPointers.size < 2) {
                const wasPinching = this.pinchStartDistance !== null;
                this.pinchStartDistance = null;
                this.pinchAnchor = null;
                if (wasPinching) {
                    this.applyZoom(false);
                }
                // Bleibt nach Ende eines Pinch noch ein Finger auf der Fläche,
                // Scrollen mit diesem Finger sofort weiterführen.
                if (this.activeTouchPointers.size === 1 && this.plugin.settings.restrictDrawingToStylus) {
                    const [[remainingId, pos]] = Array.from(this.activeTouchPointers.entries());
                    this.manualPanPointerId = remainingId;
                    this.manualPanStart = { x: pos.x, y: pos.y };
                    this.manualPanSvg = null;
                    this.manualPanScrollStart = {
                        left: this.ui.pagesContainerEl.scrollLeft,
                        top: this.ui.pagesContainerEl.scrollTop,
                    };
                }
            }
        };
        this.registerDomEvent(pagesEl, "pointerup", endTouchPointer, { capture: true });
        this.registerDomEvent(pagesEl, "pointercancel", endTouchPointer, { capture: true });

        // Zusätzliche Absicherung, falls die App den Fokus verliert.
        this.registerDomEvent(window, "blur", () => this.resetTouchTracking());
    }

    private resetTouchTracking(): void {
        this.activeTouchPointers.clear();
        this.pinchStartDistance = null;
        this.pinchAnchor = null;
    }

    /**
     * Merkt sich, welche Seite unter dem Bildschirmpunkt liegt und wo (relativ
     * zur Seiten-Box) - unabhängig von Padding, Zentrierung und CSS-Zoom-Semantik.
     * Binärsuche über die (nach Dokumentreihenfolge sortierten) Seiten-Wrapper.
     */
    private captureZoomAnchor(clientX: number, clientY: number): ZoomAnchor | null {
        const list = this.pageWrapperList;
        if (list.length === 0) return null;
        const horizontal = this.plugin.settings.horizontalLayout;
        const pos = horizontal ? clientX : clientY;
        const endOf = (el: HTMLElement) => {
            const r = el.getBoundingClientRect();
            return horizontal ? r.right : r.bottom;
        };

        let lo = 0, hi = list.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (endOf(list[mid]) < pos) lo = mid + 1;
            else hi = mid;
        }
        const el = list[lo];
        const pageId = el.dataset.pageId;
        const r = el.getBoundingClientRect();
        if (!pageId || r.width <= 0 || r.height <= 0) return null;
        return { pageId, fx: (clientX - r.left) / r.width, fy: (clientY - r.top) / r.height };
    }

    /** Scrollt so, dass der gemerkte Punkt der Seite wieder unter (clientX, clientY) liegt. */
    private restoreZoomAnchor(anchor: ZoomAnchor, clientX: number, clientY: number): void {
        const container = this.ui?.pagesContainerEl;
        const el = this.pagePlaceholders.get(anchor.pageId);
        if (!container || !el) return;
        const r = el.getBoundingClientRect(); // erzwingt Layout nach dem Zoom
        if (r.width <= 0 || r.height <= 0) return;
        const dx = (r.left + anchor.fx * r.width) - clientX;
        const dy = (r.top + anchor.fy * r.height) - clientY;
        container.scrollTo({
            left: container.scrollLeft + dx,
            top: container.scrollTop + dy,
            behavior: "instant" as ScrollBehavior, // nie animieren, sonst "schwimmt" der Zoom
        });
    }

    // ============================================================
    //  ZOOM
    // ============================================================
    public getZoomLevel(): number {
        return this.zoomLevel;
    }

    public setZoom(
        value: number,
        cursorX?: number,
        cursorY?: number,
        liveOnly: boolean = false,
        anchor: ZoomAnchor | null = null,
    ): void {
        const clamped = Math.max(
            PdfComposeView.ZOOM_MIN,
            Math.min(PdfComposeView.ZOOM_MAX, value)
        );
        const rounded = Math.round(clamped * 100) / 100;
        if (rounded === this.zoomLevel && !anchor) return;

        // Ohne Cursor (Buttons, Strg+0): um die Mitte des sichtbaren Bereichs zoomen.
        let px = cursorX;
        let py = cursorY;
        const container = this.ui?.pagesContainerEl;
        if ((px === undefined || py === undefined) && container) {
            const r = container.getBoundingClientRect();
            px = r.left + r.width / 2;
            py = r.top + r.height / 2;
        }
        const hasPoint = px !== undefined && py !== undefined;
        const useAnchor = hasPoint ? (anchor ?? this.captureZoomAnchor(px!, py!)) : null;

        if (rounded !== this.zoomLevel) {
            this.zoomLevel = rounded;
            this.applyZoom(liveOnly);
        }
        if (useAnchor && hasPoint) this.restoreZoomAnchor(useAnchor, px!, py!);
    }

    public zoomIn(cursorX?: number, cursorY?: number): void {
        this.setZoom(this.zoomLevel + PdfComposeView.ZOOM_STEP, cursorX, cursorY);
    }

    public zoomOut(cursorX?: number, cursorY?: number): void {
        this.setZoom(this.zoomLevel - PdfComposeView.ZOOM_STEP, cursorX, cursorY);
    }

    public resetZoom(): void {
        this.setZoom(1);
    }

    /**
     * Wendet den aktuellen Zoomfaktor über CSS "zoom" auf den Container an,
     * der ALLE Seiten enthält. Da "zoom" (anders als transform: scale) das
     * Layout selbst reskaliert, werden dadurch automatisch auch die vom
     * Benutzer erstellten Elemente korrekt mitskaliert: Canvas, Textmarker-/
     * Annotations-Ebenen (SVG), PDF-Textebene, Textblöcke und
     * PDF-Anmerkungsboxen. Deren Positionierung basiert bereits auf lokalen
     * Pixel-Koordinaten relativ zur jeweiligen Seiten-Wrapper-Box.
     *
     * Einzige Ausnahme: Die Verbindungslinien zwischen PDF-Textmarkierung und
     * Anmerkungsbox (PdfComposeUI.updateConnector) werden anhand
     * tatsächlicher Bildschirmkoordinaten berechnet und müssen nach einer
     * Zoomänderung explizit neu gezeichnet werden.
     */
    private applyZoom(liveOnly: boolean = false): void {
        if (!this.ui?.pagesContentEl) return;
        (this.ui.pagesContentEl.style as any).zoom = this.zoomLevel.toString();
        this.ui.updateZoomDisplay(this.zoomLevel);
        if (liveOnly) return;
        this.scheduleRerasterForCurrentZoom();
        if (this.rangeSession) requestAnimationFrame(() => this.layoutRangeSession());
        this.refreshConnectorsAfterLayoutChange();
    }

    /** Ermittelt den zum aktuellen Zoom passenden Raster-Auflösungsfaktor (siehe RASTER_ZOOM_THRESHOLDS). */
    private getRasterMultiplierForZoom(zoom: number): number {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (zoom < 1) return Math.max(0.5, zoom) * dpr;
        const thresholds = PdfComposeView.RASTER_ZOOM_THRESHOLDS;
        let base = thresholds[0];
        for (const t of thresholds) if (zoom >= t) base = t;
        return Math.min(
            base * dpr,
            Platform.isMobile ? PdfComposeView.MOBILE_MAX_RASTER_MULTIPLIER : PdfComposeView.MAX_RASTER_MULTIPLIER,
        );
    }

    // ============================================================
    //  VOLLBILD
    // ============================================================
    public toggleFullscreen(): void {
        this.setFullscreen(!this.isFullscreen);
    }

    /**
     * Blendet Obsidians Kopfleiste (Titel + Drei-Punkte-Menü), die Tab-Leiste
     * und die untere Leiste (Statusleiste bzw. mobile Navigationsleiste) aus.
     * Die eigentliche Ausblendung passiert per CSS (siehe styles.css).
     */
    public setFullscreen(value: boolean): void {
        if (this.isFullscreen === value) return;
        this.isFullscreen = value;

        const doc = this.containerEl.ownerDocument;
        doc.body.classList.toggle("pdfcompose-fullscreen", value);
        this.containerEl.classList.toggle("pdfcompose-fullscreen-leaf", value);

        if (value) {
            this.containerEl.closest(".workspace-tabs")?.classList.add("pdfcompose-fullscreen-tabs");
        } else {
            doc.querySelectorAll(".pdfcompose-fullscreen-tabs")
                .forEach((el) => el.classList.remove("pdfcompose-fullscreen-tabs"));
        }

        this.ui?.setFullscreenState(value);
        this.ui?.closeMoreOptions();

        window.requestAnimationFrame(() => {
            this.updateCurrentPageHighlight();
            this.refreshConnectorsAfterLayoutChange();
        });

        if (value) new Notice("Fullscreen active - exit via the ⋮ menu.");
    }

    /** Auflösungsfaktor für eine Seite, begrenzt durch ein Pixel-Budget pro Canvas. */
    private getTargetRasterMultiplier(pageId: string): number {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const wanted = this.getRasterMultiplierForZoom(this.zoomLevel);
        const size = this.pageLogicalSize.get(pageId);
        if (!size || size.width <= 0 || size.height <= 0) return wanted;
        const maxPixels = Platform.isMobile ? 8_000_000 : 20_000_000;
        const maxByBudget = Math.sqrt(maxPixels / (size.width * size.height));
        return Math.max(Math.min(dpr, wanted), Math.min(wanted, maxByBudget));
    }

    private scheduleRerasterForCurrentZoom(): void {
        if (this.rerasterTimer !== null) window.clearTimeout(this.rerasterTimer);
        this.rerasterTimer = window.setTimeout(() => {
            this.rerasterTimer = null;
            if (!this.currentDocument) return;
            let busy = false;
            for (const pageId of this.mountedPageIds) {
                const page = this.getPageDefinition(pageId);
                if (!page) continue;
                const target = this.getTargetRasterMultiplier(pageId);
                const current = this.pageRasterMultiplier.get(pageId) ?? 0;
                if (target <= current + 0.01) continue;
                if (this.rerasteringPageIds.has(pageId)) { busy = true; continue; }
                void this.reRasterPage(page, target);
            }
            if (busy) this.scheduleRerasterForCurrentZoom();
        }, 200);
    }

    /**
     * Zeichnet die Canvas einer einzelnen Seite mit höherer Bitmap-Auflösung
     * neu (schärfer bei starkem Zoom). Die CSS-Anzeigegröße bleibt dabei
     * bewusst UNVERÄNDERT (canvas.style.width/height) – nur die interne
     * Pixeldichte steigt. Dadurch bleiben alle Koordinatensysteme (Textebene,
     * Annotations-/Textmarker-SVGs, Textblöcke, PDF-Anmerkungsboxen), die auf
     * der festen Anzeigegröße basieren, unangetastet; nur CSS "zoom" auf dem
     * gemeinsamen Container skaliert am Ende alles sichtbar hoch.
     */
    private async reRasterPage(page: PageDefinition, multiplier: number): Promise<void> {
        if (this.rerasteringPageIds.has(page.id)) return;
        this.rerasteringPageIds.add(page.id);
        const generationAtStart = this.pageMountGeneration.get(page.id) ?? 0;
        try {
            const wrapper = this.ui.pagesContentEl.querySelector(
                `[data-page-id="${page.id}"] .pdfcompose-page-wrapper`
            ) as HTMLElement | null;
            const canvas = wrapper?.querySelector(".pdfcompose-page-canvas") as HTMLCanvasElement | null;
            const logicalSize = this.pageLogicalSize.get(page.id);
            if (!wrapper || !canvas || !logicalSize) return;

            if (isBlankPage(page)) {
                const size = typeof page.size === "object" ? page.size : PAGE_SIZES[page.size ?? "A4"];
                const rasterScale = DEFAULT_RENDER_SCALE * multiplier;
                canvas.width = size.width * rasterScale;
                canvas.height = size.height * rasterScale;
                const ctx = canvas.getContext("2d");
                const dark = this.isPageInverted(page);
                if (ctx) drawTemplatePattern(ctx, page.template ?? "blank", size.width, size.height, rasterScale, dark);
            } else if (isPdfPage(page) && this.currentDocument) {
                const sourcePath = this.currentDocument.sources[page.src];
                if (!sourcePath) return;
                await this.renderer.renderPageToCanvas(sourcePath, page.srcPage, canvas, {
                    scale: DEFAULT_RENDER_SCALE * multiplier,
                    rotate: page.rotate ?? 0,
                });
                await this.applyColorModeToPageCanvas(
                    page, wrapper, canvas, sourcePath,
                    DEFAULT_RENDER_SCALE * multiplier,
                    logicalSize.width, logicalSize.height,   // NEU
                );
            } else {
                return;
            }

            // Wurde die Seite während dieser asynchronen Rasterung aus- und
            // wieder eingehängt (schnelles Scrollen/Zoomen), ist dieses
            // Ergebnis veraltet: der jetzt sichtbare Canvas gehört bereits zu
            // einem neuen Mount-Zyklus. Anwenden würde pageRasterMultiplier
            // fälschlich auf "aktuell" setzen, obwohl der tatsächlich sichtbare
            // Canvas eine andere (niedrigere) Auflösung hat - Folge: spätere
            // Zoom-Änderungen lösen dann KEIN erneutes Rastern mehr aus und
            // Ebenen (u. a. Textmarker) bleiben dauerhaft in falscher/leerer
            // Auflösung stecken.
            if ((this.pageMountGeneration.get(page.id) ?? 0) !== generationAtStart) {
                return;
            }

            canvas.style.width = `${logicalSize.width}px`;
            canvas.style.height = `${logicalSize.height}px`;
            this.pageRasterMultiplier.set(page.id, multiplier);
        } finally {
            this.rerasteringPageIds.delete(page.id);
            this.refreshConnectorsAfterLayoutChange();
        }
    }

    /**
     * Berechnet die Verbindungslinien (Markierung ↔ Anmerkungsbox) neu.
     * Zwei aufeinanderfolgende Frames werden abgewartet, damit ein durch
     * CSS "zoom" bzw. eine Neu-Rasterung ausgelöster Reflow sicher
     * abgeschlossen ist, bevor getBoundingClientRect() ausgewertet wird.
     */
    private refreshConnectorsAfterLayoutChange(): void {
        // Zuerst zwei Frames abwarten, dann noch einen kurzen Timeout
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                // Alle Connectors neu zeichnen (für alle Seiten)
                for (const [pageId, entries] of this.pdfAnnotationsCache.entries()) {
                    for (const entry of entries) {
                        this.ui.updateConnector(pageId, entry);
                    }
                }
            });
        });
    }

    // ============================================================
    //  WERKZEUG-UMSCHALTUNG
    // ============================================================
    private async setActiveTool(tool: AnnotationTool): Promise<void> {
        if (tool !== "none") this.endRangeSession();
        this.cancelMultiPointDrawing();

        if (this.currentTool !== tool) {
            this.clearSelection();
        }

        const previousTool = this.currentTool;
        this.currentTool = tool;

        // Zustand laufender Interaktionen bei JEDEM Werkzeugwechsel
        // zurücksetzen - nicht nur beim Wechsel zu "none". Ein durch eine
        // Ausnahme oder Race-Condition nicht sauber beendeter Zustand
        // (z. B. ein Freihand-Rest) blieb sonst bestehen, wenn direkt von
        // Stift auf Radierer gewechselt wurde.
        if (previousTool !== tool) {
            this.activeStrokePath?.remove();
            this.activePointerId = null;
            this.activeStroke = null;
            this.activeStrokeColor = null;
            this.activeStrokePath = null;
            this.activeStrokePageId = null;

            this.eraserPointerId = null;
            this.lastErasePoint = null;
            this.pendingEraseIds.clear();
            this.pendingEraseAnnotationIds.clear();
            this.pendingEraseTextBlockIds.clear();

            this.dragPreviewEl?.remove();
            this.dragPointerId = null;
            this.dragStart = null;
            this.dragPageId = null;
            this.dragPreviewEl = null;

            this.selectionPointerId = null;
            this.selectionDragStart = null;
            this.selectionPreviewEl?.remove();
            this.selectionPreviewEl = null;
            this.lassoPoints = null;

            this.isMovingSelection = false;
            this.moveOrigin = null;
            this.moveSnapshot = null;

            this.textDragPreviewEl?.remove();
            this.textDragPointerId = null;
            this.textDragStart = null;
            this.textDragPageId = null;
            this.textDragPreviewEl = null;
        }

        if (this.ui) {
            this.ui.setActiveTool(this.currentTool);
            this.ui.updateAnnotationLayerInteractivity(this.currentTool);
            this.renderAnnotationPanel();
            this.ui.collapseSidebarIfPanelWrapped();
        }

        await this.renderSelectionHandles();
    }

    private refreshAnnotationPanel(): void {
        if (!this.ui) return;

        const hasSelection = this.selectedIds.size > 0;
        const selectedTypes = hasSelection
            ? this.getSelectedObjectTypes()
            : new Set<VectorObject["type"]>();
        const hasFreehandSelection = hasSelection && selectedTypes.has("freehand");

        this.ui.panelControls = {};

        this.ui.renderAnnotationPanel(
            this.currentTool,
            {
                strokeColor: isPenTool(this.currentTool) ? this.penPresets.get(this.currentTool)?.color ?? this.styleStrokeColor : this.styleStrokeColor,
                strokeWidth: isPenTool(this.currentTool) ? this.penPresets.get(this.currentTool)?.strokeWidth ?? this.styleStrokeWidth : this.styleStrokeWidth,
                fillEnabled: this.styleFillEnabled,
                fillColor: this.styleFillColor,
                fillOpacity: this.styleFillOpacity,
                segmentKind: this.styleSegmentKind,
                arrowSide: this.styleArrowSide,
                arrowSize: this.styleArrowSize,
                selectionMode: this.selectionMode,
                pressure: isPenTool(this.currentTool) ? this.penPresets.get(this.currentTool)?.pressure ?? { enabled: false, minFactor: 0, curve: "linear" } : { enabled: false, minFactor: 0, curve: "linear" },
                highlighter: isPenTool(this.currentTool) ? this.penPresets.get(this.currentTool)?.highlighter ?? false : false,
                eraserTargets: this.eraserTargets,
                selectionTargets: this.selectionTargets,
                isHighlighterShape: this.styleShapeHighlighter,
            },
            hasSelection,
            selectedTypes,
            this.selectionPageId,
            hasFreehandSelection,
            {
                onStyleChange: (patch: any) => {
                    if (this.selectedIds.size > 0) {
                        void this.schedulePersistStyleToSelection(patch);
                    } else {
                        if (patch.strokeColor !== undefined) this.styleStrokeColor = patch.strokeColor;
                        if (patch.strokeWidth !== undefined) this.styleStrokeWidth = patch.strokeWidth;
                        if (patch.fillColor !== undefined) {
                            this.styleFillColor = patch.fillColor;
                            this.styleFillEnabled = true;
                        }
                        if (patch.fillOpacity !== undefined) {
                            this.styleFillOpacity = patch.fillOpacity;
                            this.styleFillEnabled = true;
                        }
                        if (patch.segmentKind !== undefined) this.styleSegmentKind = patch.segmentKind;
                        if (patch.arrowStart !== undefined || patch.arrowEnd !== undefined) {
                            const start = patch.arrowStart ?? (this.styleArrowSide === 'start' || this.styleArrowSide === 'both');
                            const end = patch.arrowEnd ?? (this.styleArrowSide === 'end' || this.styleArrowSide === 'both');
                            if (start && end) this.styleArrowSide = 'both';
                            else if (start) this.styleArrowSide = 'start';
                            else if (end) this.styleArrowSide = 'end';
                            else this.styleArrowSide = 'end';
                        }
                        this.refreshAnnotationPanel();
                    }
                },
                onSelectionModeChange: (mode: SelectionMode) => {
                    this.selectionMode = mode;
                    this.refreshAnnotationPanel();
                },
                onEraserTargetsChange: (patch: Partial<FilterTargets>) => {
                    this.eraserTargets = { ...this.eraserTargets, ...patch };
                    this.refreshAnnotationPanel();
                },
                onSelectionTargetsChange: (patch: Partial<FilterTargets>) => {
                    this.selectionTargets = { ...this.selectionTargets, ...patch };
                    this.refreshAnnotationPanel();
                },
            }
        );

        this.updateActionButtonsState();
    }

    private async modifyFrontmatterWithUndo(
        apply: (frontmatter: any) => void,
        invert: (frontmatter: any) => void,
        label: string
    ): Promise<void> {
        await this.modifyFrontmatterStructural(apply);
        this.pushUndo({
            label,
            undo: async () => { await this.modifyFrontmatterStructural(invert); },
            redo: async () => { await this.modifyFrontmatterStructural(apply); },
        });
    }

    /**
 * Wandelt die Metadaten-Arrays (textBlocks, pdfAnnotations, ocrBlocks) im
 * Frontmatter in Maps { id: komprimierterString } um. Zwei Effekte:
 *
 *  1. GIT-FREUNDLICH: Jeder Eintrag steht auf einer eigenen Zeile. Eine
 *     Änderung an einem Block verändert genau eine Zeile statt eines
 *     ganzen Blobs.
 *
 *  2. READING-VIEW: Obsidian schreibt flache Arrays in der Properties-
 *     Ansicht vollständig aus (ein Chip pro Eintrag, jeder Chip wird
 *     unverkürzt gerendert, solange er nicht zu breit wird). Maps
 *     dagegen werden als "…"-Zusammenfassung dargestellt - genau wie
 *     das bereits vorhandene `annotations`-Feld.
 *
 * Die Reihenfolge der Einträge entspricht der Einfügereihenfolge der
 * Objekt-Keys; js-yaml erhält diese beim Dump (relevant für die
 * Anzeige-/Render-Reihenfolge auf der Seite).
 */
    private compressFrontmatterMetas(fm: any): void {
        const keys = ["textBlocks", "pdfAnnotations", "ocrBlocks", "shapeLabels"] as const;
        for (const key of keys) {
            const raw = fm[key];
            if (!Array.isArray(raw)) continue;

            if (raw.length === 0) {
                fm[key] = undefined;
                continue;
            }

            const map: Record<string, string> = {};
            for (const entry of raw) {
                const id = (entry as any)?.id;
                if (typeof id !== "string" || id.length === 0) continue;
                map[id] = compressText(JSON.stringify(entry));
            }
            fm[key] = Object.keys(map).length === 0 ? undefined : map;
        }
    }

    /**
 * Ändert Frontmatter und Body einer .md-Datei in einem einzigen, atomaren Schritt.
 * @param frontmatterUpdater - Funktion, die das geparste Frontmatter-Objekt modifiziert
 * @param bodyUpdater - Funktion, die den aktuellen Body-String entgegennimmt und den neuen Body zurückgibt
 */
    private async updateFileAtomic(
        frontmatterUpdater: (fm: any) => void,
        bodyUpdater: (body: string) => string,
        silent: boolean = true
    ): Promise<void> {
        if (!this.currentFile) return;
        const raw = await this.app.vault.read(this.currentFile);
        const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---/);
        let frontmatter: any = {};
        let body = raw;
        if (frontmatterMatch) {
            try {
                frontmatter = YAML.load(frontmatterMatch[1]) || {};
            } catch {
                // Fallback
            }
            body = raw.slice(frontmatterMatch[0].length).trimStart();
        }

        if (frontmatter.textBlocks !== undefined) frontmatter.textBlocks = decompressMetaArray(frontmatter.textBlocks) ?? [];
        if (frontmatter.pdfAnnotations !== undefined) frontmatter.pdfAnnotations = decompressMetaArray(frontmatter.pdfAnnotations) ?? [];
        if (frontmatter.ocrBlocks !== undefined) frontmatter.ocrBlocks = decompressMetaArray(frontmatter.ocrBlocks) ?? [];
        if (frontmatter.shapeLabels !== undefined) frontmatter.shapeLabels = decompressMetaArray(frontmatter.shapeLabels) ?? [];

        frontmatterUpdater(frontmatter);

        let newBody = bodyUpdater(body);
        newBody = this.reorderBodyBlocks(newBody, frontmatter);

        this.compressFrontmatterMetas(frontmatter);

        const newFrontmatterStr = YAML.dump(frontmatter).trim();
        const newContent = `---\n${newFrontmatterStr}\n---\n${newBody}`;

        if (silent) this.suppressNextChange();
        else this.suppressExpiries = [];
        await this.app.vault.modify(this.currentFile, newContent);
    }

    /**
     * Liest die aktuelle Datei, sortiert den Body gemäß der aktuellen Seitenreihenfolge
     * (aus this.currentDocument) und schreibt die Datei neu.
     */
    private async reorderAllBodyBlocks(): Promise<void> {
        if (!this.currentFile || !this.currentDocument) return;
        const raw = await this.app.vault.read(this.currentFile);
        const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---/);
        let frontmatter: any = {};
        let body = raw;
        if (frontmatterMatch) {
            try {
                frontmatter = YAML.load(frontmatterMatch[1]) || {};
            } catch {
                // Fallback
            }
            body = raw.slice(frontmatterMatch[0].length).trimStart();
        }

        // Dekomprimieren der Metadaten-Felder (falls vorhanden)
        if (frontmatter.textBlocks) frontmatter.textBlocks = decompressMetaArray(frontmatter.textBlocks);
        if (frontmatter.pdfAnnotations) frontmatter.pdfAnnotations = decompressMetaArray(frontmatter.pdfAnnotations);
        if (frontmatter.ocrBlocks) frontmatter.ocrBlocks = decompressMetaArray(frontmatter.ocrBlocks);
        if (frontmatter.shapeLabels) frontmatter.shapeLabels = decompressMetaArray(frontmatter.shapeLabels);

        // Die im Dateisystem aktuell vorhandene Reihenfolge NICHT mit dem
        // (möglicherweise veralteten) In-Memory-Snapshot überschreiben. Der
        // Snapshot wird nur dann als Fallback genutzt, wenn in der Datei
        // überhaupt keine Seitenliste steht.
        if (!Array.isArray(frontmatter.pages) || frontmatter.pages.length === 0) {
            frontmatter.pages = this.currentDocument.pages;
        }
        // Body neu sortieren
        const newBody = this.reorderBodyBlocks(body, frontmatter);

        // Metadaten wieder komprimieren
        this.compressFrontmatterMetas(frontmatter);

        const newFrontmatterStr = YAML.dump(frontmatter).trim();
        const newContent = `---\n${newFrontmatterStr}\n---\n${newBody}`;

        this.suppressNextChange();
        await this.app.vault.modify(this.currentFile, newContent);
    }

    private static pageMarkerRegex(): RegExp {
        return /<!--pdfcompose-page\s+id="([^"]+)"[^>]*-->/g;
    }

    private pageMarkerFor(pageId: string, pageIndex: number): string {
        return `<!--pdfcompose-page id="${pageId}" index="${pageIndex + 1}"-->`;
    }

    /**
     * Entfernt alle bereits bekannten (und an anderer Stelle wieder frisch
     * eingefügten) Blöcke aus einem Textabschnitt. Was übrig bleibt, ist vom
     * Nutzer frei verfasster Markdown-Text. Überzählige Leerzeilen, die durchs
     * Herausschneiden entstehen, werden eingedampft.
     */
    private stripKnownBlocks(section: string, knownBlocks: { id: string; serialized: string }[]): string {
        let result = section;
        for (const block of knownBlocks) {
            if (result.includes(block.serialized)) {
                result = result.split(block.serialized).join("");
            }
        }
        return result.replace(/\n{3,}/g, "\n\n").trim();
    }

    /**
     * Zerlegt den Dateikörper anhand der Seiten-Marker-Kommentare
     * (<!--pdfcompose-page id="…"-->) in Abschnitte und entfernt daraus alle
     * bekannten Blöcke (Textblöcke, PDF-Anmerkungen, OCR-Ergebnisse). Was je
     * Seite übrig bleibt, ist vom Nutzer frei zwischen/neben den Blöcken
     * verfasster Markdown-Text.
     *
     * Der Schlüssel "" steht für Text VOR dem allerersten Marker (bzw. den
     * gesamten Body, falls noch gar kein Marker vorhanden ist – z. B. in
     * Dateien, die vor Einführung dieser Marker gespeichert wurden). Dieser
     * Text wird beim Wiederaufbau nicht verworfen, sondern unverändert an den
     * Anfang der Datei gestellt, da er keiner bestimmten Seite sicher
     * zugeordnet werden kann.
     */
    private extractFreeTextByPage(
        body: string,
        knownBlocks: { id: string; serialized: string }[]
    ): Map<string, string> {
        const markerPositions: { pageId: string; index: number; length: number }[] = [];
        const regex = PdfComposeView.pageMarkerRegex();
        let match: RegExpExecArray | null;
        while ((match = regex.exec(body)) !== null) {
            markerPositions.push({ pageId: match[1], index: match.index, length: match[0].length });
        }

        const result = new Map<string, string>();
        const firstMarkerIndex = markerPositions.length > 0 ? markerPositions[0].index : -1;

        const leading = firstMarkerIndex === -1 ? body : body.slice(0, firstMarkerIndex);
        result.set("", this.stripKnownBlocks(leading, knownBlocks));

        for (let i = 0; i < markerPositions.length; i++) {
            const marker = markerPositions[i];
            const contentStart = marker.index + marker.length;
            const contentEnd = i + 1 < markerPositions.length ? markerPositions[i + 1].index : body.length;
            const raw = body.slice(contentStart, contentEnd);
            const stripped = this.stripKnownBlocks(raw, knownBlocks);
            const existing = result.get(marker.pageId);
            result.set(marker.pageId, existing ? `${existing}\n${stripped}`.trim() : stripped);
        }

        return result;
    }

    /**
 * Findet alle automatisch erzeugten Überschriften-Blöcke (inkl. Marker-
 * Kommentaren) im Body. Der zurückgegebene "id"-Wert ist die pageId, damit
 * der Block beim Neuaufbau des Body eindeutig einer Seite zugeordnet werden
 * kann.
 */
    private extractAutoHeadingBlocks(body: string): { id: string; serialized: string }[] {
        const blocks: { id: string; serialized: string }[] = [];
        const re = /<!--pdfcompose-auto-heading-start\s+id="([^"]+)"-->[\s\S]*?<!--pdfcompose-auto-heading-end\s+id="\1"-->/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(body)) !== null) {
            blocks.push({ id: match[1], serialized: match[0] });
        }
        return blocks;
    }

    /**
     * Baut den Überschriftentext aus der in den Einstellungen hinterlegten
     * Syntax. Unterstützte Platzhalter:
     *   $1 = Seitenzahl im PDF-Compose-Dokument (1-basiert)
     *   $2 = Name der Quelle (bzw. "Leerseite" für Blank-Seiten)
     *   $3 = Seitenzahl innerhalb der Quelle
     * Unbekannte $N-Platzhalter bleiben unverändert stehen, damit z. B. auch
     * wörtliche "$"-Zeichen möglich sind.
     */
    private buildPageHeadingText(page: any, pageIndex: number): string {
        const template = this.plugin.settings.pageHeadingsSyntax ?? "";
        if (!template.trim()) return "";

        const replacements: Record<string, string> = {
            "1": String(pageIndex + 1),
            "2": page.type === "blank" ? "Leerseite" : (page.src ?? ""),
            "3": page.srcPage != null ? String(page.srcPage) : "",
        };

        return template.replace(/\$([0-9]+)/g, (match, n) => replacements[n] ?? match);
    }

    /** Extrahiert den Text aller PDF-Seiten (nur PDF-Seiten, keine Blank-Seiten) in den pdfTextCache. */
    private async extractAllPdfTextIntoCache(): Promise<void> {
        this.pdfTextCache.clear();
        if (!this.currentDocument) return;
        for (const page of this.currentDocument.pages) {
            if (!isPdfPage(page)) continue;
            const sourcePath = this.currentDocument.sources[page.src];
            if (!sourcePath) continue;
            try {
                const text = await this.renderer.getPageText(sourcePath, page.srcPage);
                if (text && text.trim()) {
                    this.pdfTextCache.set(page.id, text.trim());
                }
            } catch {
                // PDF-Text konnte nicht extrahiert werden – Block für diese Seite überspringen.
            }
        }
    }

    /** Aktiviert/deaktiviert die Speicherung des PDF-Textes im Body (Frontmatter-Feld savePdfText). */
    /**
     * Wird vom Schnellzugriff-Toggle in der View aufgerufen (siehe
     * PdfComposeUI.buildStylusOnlyToggle). Ändert dieselbe Einstellung wie
     * "Nur Stift zeichnet" in den Plugin-Einstellungen und speichert sie -
     * betrifft shouldIgnoreForDrawing() sofort für alle offenen Seiten.
     */
    private async setRestrictDrawingToStylus(value: boolean): Promise<void> {
        this.plugin.settings.restrictDrawingToStylus = value;
        await this.plugin.saveSettings();
    }

    private async setSavePdfText(value: boolean): Promise<void> {
        if (!this.currentFile || !this.currentDocument) return;
        const prior = this.currentDocument.savePdfText === true;
        if (prior === value) return;

        if (value) {
            await this.extractAllPdfTextIntoCache();
        } else {
            this.pdfTextCache.clear();
        }

        await this.updateFileAtomic(
            (fm) => {
                if (value) fm.savePdfText = true;
                else delete fm.savePdfText;
            },
            (body) => body,
        );

        this.currentDocument.savePdfText = value;
    }

    /** Findet alle automatisch erzeugten PDF-Text-Blöcke (inkl. Marker) im Body. */
    private extractAutoPdfTextBlocks(body: string): { id: string; serialized: string }[] {
        const blocks: { id: string; serialized: string }[] = [];
        const re = /<!--pdfcompose-pdftext\s+id="([^"]+)"-->[\s\S]*?<!--pdfcompose-pdftext-end\s+id="\1"-->/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(body)) !== null) {
            blocks.push({ id: match[1], serialized: match[0] });
        }
        return blocks;
    }

    /** Baut den kompletten PDF-Text-Block (Marker + eingeklappter Callout) für eine Seite. */
    private buildPdfTextBlock(pageId: string, text: string): string {
        const wrapped = this.wrapPdfText(text, 100);
        const calloutBody = wrapped
            .split("\n")
            .map((line) => (line.length > 0 ? `> ${line}` : ">"))
            .join("\n");
        return (
            `<!--pdfcompose-pdftext id="${pageId}"-->\n` +
            `> [!pdftext]- PDF-Text (automatisch extrahiert)\n` +
            `${calloutBody}\n` +
            `<!--pdfcompose-pdftext-end id="${pageId}"-->`
        );
    }

    /** Zeilenumbruch für den PDF-Text (rein kosmetisch; Inhalt bleibt unverändert). */
    private wrapPdfText(text: string, width: number): string {
        const words = text.split(/\s+/).filter((w) => w.length > 0);
        if (words.length === 0) return "";
        const lines: string[] = [];
        let current = "";
        for (const word of words) {
            if (current.length > 0 && current.length + 1 + word.length > width) {
                lines.push(current);
                current = word;
            } else if (current.length > 0) {
                current += " " + word;
            } else {
                current = word;
            }
        }
        if (current.length > 0) lines.push(current);
        return lines.join("\n");
    }

    /**
 * Sortiert alle Blöcke (Text, Anmerkung, OCR) im Body gemäß der Seitenreihenfolge im Frontmatter.
 * Blöcke, deren pageId nicht in den Metadaten vorkommt, werden verworfen.
 */
    private reorderBodyBlocks(body: string, frontmatter: any): string {
        // 1. Alle bekannten Blöcke aus dem Body extrahieren
        const textBlocks = extractAllTextBlocks(body);
        const annotBlocks = extractAllPdfAnnotations(body);
        const ocrBlocks = extractAllOcrBlocks(body);
        const autoHeadingBlocks = this.extractAutoHeadingBlocks(body);
        const pdfTextBlocks = this.extractAutoPdfTextBlocks(body);

        // Inhaltliche Blöcke (Text, Anmerkung, OCR) werden neu geschrieben;
        // Auto-Überschriften und PDF-Text-Blöcke werden nur entfernt und frisch erzeugt.
        const shapeLabelBlocks = extractAllShapeLabels(body);
        const contentBlocks = [...textBlocks, ...annotBlocks, ...ocrBlocks, ...shapeLabelBlocks];
        const allKnownBlocks = [
            ...contentBlocks,
            ...autoHeadingBlocks,
            ...pdfTextBlocks];

        // 2. Map: ID -> serialisierter Block-String (nur Inhaltsblöcke)
        const blockMap = new Map<string, string>();
        for (const b of contentBlocks) {
            blockMap.set(b.id, b.serialized);
        }

        // Bestehende PDF-Text-Blöcke nach pageId merken (werden wiederverwendet,
        // falls für eine Seite kein frischer Text im Cache vorliegt).
        const pdfTextBlockByPageId = new Map<string, string>();
        for (const b of pdfTextBlocks) {
            pdfTextBlockByPageId.set(b.id, b.serialized);
        }

        // 3. Metadaten aus dem Frontmatter für pageId-Lookup
        const textMeta = frontmatter.textBlocks || [];
        const annotMeta = frontmatter.pdfAnnotations || [];
        const ocrMeta = frontmatter.ocrBlocks || [];
        const shapeLabelMeta = frontmatter.shapeLabels || [];

        const idToPageId = new Map<string, string>();
        for (const meta of textMeta) idToPageId.set(meta.id, meta.pageId);
        for (const meta of annotMeta) idToPageId.set(meta.id, meta.pageId);
        for (const meta of ocrMeta) idToPageId.set(meta.id, meta.pageId);
        for (const meta of shapeLabelMeta) idToPageId.set(meta.id, meta.pageId);

        // 4. Gruppiere die Blöcke nach pageId, behalte Reihenfolge aus contentBlocks
        const pageBlockIds = new Map<string, string[]>();
        for (const entry of contentBlocks) {
            const pageId = idToPageId.get(entry.id);
            if (!pageId) continue;
            const list = pageBlockIds.get(pageId) || [];
            list.push(entry.id);
            pageBlockIds.set(pageId, list);
        }

        // 5. Frei verfassten Text je Seite ermitteln
        const freeTextByPageId = this.extractFreeTextByPage(body, allKnownBlocks);
        for (const meta of shapeLabelMeta) idToPageId.set(meta.id, meta.pageId);

        // 6. Body neu aufbauen
        const pageOrder: string[] = (frontmatter.pages || []).map((p: any) => p.id);
        const knownPageIds = new Set(pageOrder);

        const headingsEnabled = this.plugin.settings.pageHeadingsEnabled !== false;
        const headingSyntax = this.plugin.settings.pageHeadingsSyntax ?? "";
        const savePdfTextEnabled = frontmatter.savePdfText === true;

        let newBody = "";

        const orphanText = (freeTextByPageId.get("") ?? "").trim();
        if (orphanText) {
            newBody += orphanText + "\n\n";
        }

        for (let i = 0; i < pageOrder.length; i++) {
            const pageId = pageOrder[i];
            const ids = pageBlockIds.get(pageId) || [];
            const freeText = (freeTextByPageId.get(pageId) ?? "").trim();

            // Vorhandenen PDF-Text-Block für diese Seite bestimmen (auch bei
            // einer Seite ohne Freitext/Blöcke – reiner PDF-Text ist Inhalt genug).
            const cachedPdfText = savePdfTextEnabled ? this.pdfTextCache.get(pageId) : undefined;
            const existingPdfTextBlock = savePdfTextEnabled ? pdfTextBlockByPageId.get(pageId) : undefined;
            const willHavePdfTextBlock = !!(cachedPdfText && cachedPdfText.trim()) || !!existingPdfTextBlock;

            if (ids.length === 0 && !freeText && !willHavePdfTextBlock) continue;

            newBody += this.pageMarkerFor(pageId, i) + "\n";

            // Auto-Überschrift
            if (headingsEnabled && headingSyntax.trim()) {
                const page = (frontmatter.pages as any[]).find((p: any) => p.id === pageId);
                if (page && page.type !== "blank") {
                    const heading = this.buildPageHeadingText(page, i);
                    if (heading.trim()) {
                        newBody += `<!--pdfcompose-auto-heading-start id="${pageId}"-->\n`;
                        newBody += heading + "\n";
                        newBody += `<!--pdfcompose-auto-heading-end id="${pageId}"-->\n`;
                    }
                }
            }

            // PDF-Text direkt unter der Überschrift (eingeklappter Callout).
            if (savePdfTextEnabled) {
                if (cachedPdfText && cachedPdfText.trim()) {
                    newBody += this.buildPdfTextBlock(pageId, cachedPdfText) + "\n";
                } else if (existingPdfTextBlock) {
                    // Cache leer (z. B. Extraktion noch nicht abgeschlossen) – vorhandenen Block erhalten.
                    newBody += existingPdfTextBlock + "\n";
                }
            }

            if (freeText) {
                newBody += freeText + "\n";
            }
            for (const id of ids) {
                const serialized = blockMap.get(id);
                if (serialized) {
                    newBody += serialized + "\n";
                }
            }
            newBody += "\n";
        }

        // Text zu Markern, deren Seite es nicht mehr gibt, nicht stillschweigend
        // verwerfen.
        for (const [pageId, text] of freeTextByPageId.entries()) {
            if (pageId === "" || knownPageIds.has(pageId)) continue;
            if (!text.trim()) continue;
            newBody += this.pageMarkerFor(pageId, pageOrder.length) + "\n" + text.trim() + "\n\n";
        }

        return newBody.trim();
    }

    // ============================================================
    //  SEITEN-VERSCHIEBEN / LÖSCHEN / ROTIEREN
    // ============================================================
    /** Serialisiert Seiten-Verschiebe-Operationen. Verhindert, dass zwei schnell
 *  aufeinanderfolgende Drops mit halb-fertigen Zuständen konkurrieren. */
    private moveChain: Promise<void> = Promise.resolve();

    private movePagesToIndex(
        sourceIds: string[],
        targetPageId: string
    ): Promise<void> {
        // Neue Aktion an die Kette anhängen. Egal ob der Vorgänger erfolgreich
        // war oder nicht - die nächste Aktion startet auf jeden Fall.
        const run = this.moveChain.then(
            () => this.doMovePagesToIndex(sourceIds, targetPageId),
            () => this.doMovePagesToIndex(sourceIds, targetPageId)
        );
        // Kette darf nie "brechen", sonst blockiert der nächste Drop ewig.
        this.moveChain = run.catch(() => { /* swallow */ });
        return run;
    }

    private async doMovePagesToIndex(
        sourceIds: string[],
        targetPageId: string
    ): Promise<void> {
        if (!this.currentFile) return;

        // Datei direkt lesen - NICHT metadataCache, der kann nach einem
        // schnell vorausgegangenen Schreibvorgang noch veraltet sein.
        const raw = await this.app.vault.read(this.currentFile);
        const match = raw.match(/^---\n([\s\S]*?)\n---/);
        if (!match) return;
        let fm: any;
        try { fm = YAML.load(match[1]) || {}; } catch { return; }
        if (!Array.isArray(fm.pages)) return;

        const sourceSet = new Set(sourceIds);
        const currentOrder: string[] = fm.pages.map((p: any) => p.id);
        const orderedSourceIds = currentOrder.filter(id => sourceSet.has(id));
        if (orderedSourceIds.length === 0) return;
        if (sourceSet.has(targetPageId)) return;
        if (!currentOrder.includes(targetPageId)) return;

        // ----- Einfüge-Semantik ---------------------------------------------
        // * Liegt MINDESTENS EINE Quell-Seite ursprünglich VOR der Ziel-Seite:
        //   Quell-Seiten entfernen -> Ziel rückt nach vorne -> Quell-Seiten
        //   HINTER Ziel einfügen (in ihrer ursprünglichen relativen Reihenfolge).
        // * Liegen ALLE Quell-Seiten hinter Ziel:
        //   Quell-Seiten VOR Ziel einfügen.
        const targetOriginalIdx = currentOrder.indexOf(targetPageId);
        const minSourceIdx = Math.min(
            ...orderedSourceIds.map(id => currentOrder.indexOf(id))
        );
        const insertAfterTarget = minSourceIdx < targetOriginalIdx;
        // --------------------------------------------------------------------

        const priorOrder = [...currentOrder];

        const apply = (fmArg: any) => {
            const pages = fmArg.pages as any[];

            // 1. Quell-Seiten entfernen (in ihrer ursprünglichen Reihenfolge).
            const removed: any[] = [];
            for (const id of orderedSourceIds) {
                const idx = pages.findIndex((p: any) => p.id === id);
                if (idx !== -1) removed.push(pages.splice(idx, 1)[0]);
            }

            // 2. Ziel-Seite in der REDUZIERTEN Liste wiederfinden.
            const tIdx = pages.findIndex((p: any) => p.id === targetPageId);
            if (tIdx === -1) {
                // Sollte nicht passieren (Target war zuvor in der Liste).
                // Sicherheitshalber hinten anhängen statt Datenverlust.
                pages.push(...removed);
                return;
            }

            // 3. Quell-Seiten an der korrekten Stelle einfügen.
            const insertAt = insertAfterTarget ? tIdx + 1 : tIdx;
            pages.splice(insertAt, 0, ...removed);
        };

        const invert = (fmArg: any) => {
            const pages = fmArg.pages as any[];
            const byId = new Map(pages.map((p: any) => [p.id, p]));
            fmArg.pages = priorOrder.map(id => byId.get(id)).filter(Boolean);
        };

        await this.modifyFrontmatterWithUndo(apply, invert, "move-pages");

        this.pendingScrollPageId = orderedSourceIds[0];
        await this.reorderAllBodyBlocks();
    }

    private normalizePdfName(name: string): string {
        return name
            .toLowerCase()
            .replace(/\.pdf$/i, "")
            .replace(/[\s._-]+/g, "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");
    }

    private getPdfFileName(path: string): string {
        return path
            .split("/")
            .pop()
            ?.replace(/\.pdf$/i, "") ?? path;
    }

    private levenshteinDistance(a: string, b: string): number {
        const matrix: number[][] = [];

        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }

        return matrix[b.length][a.length];
    }

    private findReplacementPdfPaths(
        originalPath: string,
        limit: number = 8
    ): string[] {
        const files = this.app.vault
            .getFiles()
            .filter(file => file.extension.toLowerCase() === "pdf");

        const originalName =
            this.normalizePdfName(
                this.getPdfFileName(originalPath)
            );

        if (!originalName) return [];

        /*
         * 1. Exakter Dateiname, unabhängig vom Pfad.
         */
        const exactMatches = files
            .filter(file =>
                this.normalizePdfName(file.basename) === originalName &&
                file.path !== originalPath
            )
            .sort((a, b) =>
                a.path.localeCompare(b.path, "de")
            );

        if (exactMatches.length > 0) {
            return exactMatches
                .slice(0, limit)
                .map(file => file.path);
        }

        /*
         * 2. Ähnliche Namen.
         */
        const scored = files
            .filter(file => file.path !== originalPath)
            .map(file => {
                const candidate =
                    this.normalizePdfName(file.basename);

                const distance =
                    this.levenshteinDistance(
                        originalName,
                        candidate
                    );

                const maxLength =
                    Math.max(
                        originalName.length,
                        candidate.length
                    );

                const similarity =
                    maxLength === 0
                        ? 0
                        : 1 - distance / maxLength;

                /*
                 * Zusätzlich Bonus, wenn ein Name den anderen enthält.
                 */
                const containsBonus =
                    candidate.includes(originalName) ||
                        originalName.includes(candidate)
                        ? 0.15
                        : 0;

                return {
                    path: file.path,
                    score: similarity + containsBonus,
                    distance,
                };
            })
            .filter(entry => entry.score >= 0.35)
            .sort((a, b) => {
                if (b.score !== a.score) {
                    return b.score - a.score;
                }

                return a.path.localeCompare(
                    b.path,
                    "de"
                );
            });

        return scored
            .slice(0, limit)
            .map(entry => entry.path);
    }

    private async changeSourcePath(
        sourceName: string
    ): Promise<void> {
        if (!this.currentDocument) return;

        const currentPath =
            this.currentDocument.sources[sourceName];

        if (!currentPath) {
            new Notice(
                `Source "${sourceName}" not found.`
            );
            return;
        }

        const suggestions =
            this.findReplacementPdfPaths(
                currentPath
            );

        new ChangeSourcePathModal(
            this.app,
            sourceName,
            currentPath,
            suggestions,
            async (newPath) => {
                const oldPath = currentPath;

                await this.modifyFrontmatterWithUndo(
                    (fm) => {
                        if (!fm.sources) {
                            fm.sources = {};
                        }

                        fm.sources[sourceName] =
                            newPath;
                    },
                    (fm) => {
                        if (!fm.sources) {
                            fm.sources = {};
                        }

                        fm.sources[sourceName] =
                            oldPath;
                    },
                    "change-source-path"
                );
            }
        ).open();
    }

    // ============================================================
    //  SUCHFUNKTION
    // ============================================================
    public performSearch(query: string): void {
        void this._performSearch(query);
    }

    private async _performSearch(query: string): Promise<void> {
        this.ui.clearHighlights();
        this.allMatches = [];
        this.currentMatchIndex = -1;

        if (!query.trim()) {
            this.ui.searchResultsEl.empty();
            this.ui.searchResultsEl.style.display = "none";
            this.foundPageIds.clear();
            this.ui.updateSidebarHighlights(this.foundPageIds);
            return;
        }

        // 1. Frontmatter parsen (wird für Parser und für die Schleifen benötigt)
        if (!this.currentFile) return;
        const cache = this.app.metadataCache.getFileCache(this.currentFile);
        const doc = parseFrontmatter(cache);

        // 2. Caches für Textblöcke und Anmerkungen aus der Datei neu laden
        const rawContent = await this.app.vault.cachedRead(this.currentFile);
        this.textBlocksCache = groupTextBlocksByPage(parseTextBlocks(rawContent, doc));
        this.pdfAnnotationsCache = groupPdfAnnotationsByPage(parsePdfAnnotations(rawContent, doc));
        // OCR-Cache bleibt unverändert, da er beim Speichern aktualisiert wird

        if (this.plugin.settings.ocrEnabled && this.plugin.settings.ocrRunOnSearch) {
            await this.ensureOcrUpToDate();
        }

        const textMaxDistance = this.plugin.settings.textSearchMaxDistance;
        const ocrMaxDistance = this.plugin.settings.ocrSearchMaxDistance;

        const results: SearchResultItem[] = [];

        // --- 1. PDF-Text ---
        for (let i = 0; i < doc.pages.length; i++) {
            const page = doc.pages[i];
            if (!isPdfPage(page)) continue;
            const sourcePath = doc.sources[page.src];
            if (!sourcePath) continue;
            try {
                const items = await this.renderer.getPageTextItems(sourcePath, page.srcPage);
                const fullText = items.map(item => item.str).join(' ');
                const pageMatches: { x: number; y: number; width: number; height: number }[] = [];
                let bestDistance = Infinity;
                for (const item of items) {
                    const found = findFuzzyTextMatches(item.str, query, textMaxDistance);
                    for (const f of found) {
                        const rect = this.computeFuzzyMatchRect(item, f);
                        if (rect) pageMatches.push(rect);
                        if (f.distance < bestDistance) bestDistance = f.distance;
                    }
                }
                if (pageMatches.length > 0) {
                    results.push({
                        category: "pdf",
                        pageId: page.id,
                        pageIndex: i,
                        snippet: this.buildContextSnippet(fullText, query, textMaxDistance),
                        matches: pageMatches,
                        distance: bestDistance,
                    });
                }
            } catch (e) {
                console.warn(`Suche auf Seite ${page.id} fehlgeschlagen`, e);
            }
        }

        // --- 2. OCR (Handschrift) ---
        for (const [pageId, entries] of this.ocrCache.entries()) {
            const pageIndex = doc.pages.findIndex(p => p.id === pageId);
            if (pageIndex === -1) continue;
            for (const entry of entries) {
                const fullText = entry.words.map(w => w.text).join(' ');
                const wordMatches = findFuzzyWordSequenceMatches(entry.words, query, ocrMaxDistance);
                for (const wm of wordMatches) {
                    const rect = this.mergeOcrWordRects(entry.words.slice(wm.startIndex, wm.endIndex + 1));
                    const charIndex = this.ocrWordCharOffset(entry.words, wm.startIndex);
                    results.push({
                        category: "ocr",
                        pageId,
                        pageIndex,
                        snippet: this.buildSnippetAt(fullText, charIndex, wm.text.length),
                        matches: [rect],
                        distance: wm.distance,
                    });
                }
            }
        }

        // --- 3. Textblöcke ---
        for (const [pageId, entries] of this.textBlocksCache.entries()) {
            const pageIndex = doc.pages.findIndex(p => p.id === pageId);
            if (pageIndex === -1) continue;
            for (const entry of entries) {
                const found = findFuzzyTextMatches(entry.markdown, query, textMaxDistance);
                if (found.length === 0) continue;
                results.push({
                    category: "textblock",
                    pageId,
                    pageIndex,
                    snippet: this.buildContextSnippet(entry.markdown, query, textMaxDistance),
                    matches: [],
                    distance: found[0].distance,
                    blockId: entry.id,
                });
            }
        }

        // --- 4. PDF-Anmerkungen ---
        for (const [pageId, entries] of this.pdfAnnotationsCache.entries()) {
            const pageIndex = doc.pages.findIndex(p => p.id === pageId);
            if (pageIndex === -1) continue;
            for (const entry of entries) {
                const found = findFuzzyTextMatches(entry.markdown, query, textMaxDistance);
                if (found.length === 0) continue;
                results.push({
                    category: "annotation",
                    pageId,
                    pageIndex,
                    snippet: this.buildContextSnippet(entry.markdown, query, textMaxDistance),
                    matches: [],
                    distance: found[0].distance,
                    blockId: entry.id,
                });
            }
        }

        // --- Gruppieren & Sortieren ---
        const categoryOrder: SearchResultCategory[] = ["pdf", "ocr", "textblock", "annotation"];
        const grouped: SearchResultItem[] = [];
        for (const cat of categoryOrder) {
            const items = results.filter(r => r.category === cat);
            if (cat === "ocr") {
                items.sort((a, b) => a.distance - b.distance || a.pageIndex - b.pageIndex);
            } else {
                items.sort((a, b) => a.pageIndex - b.pageIndex);
            }
            grouped.push(...items);
        }

        // --- Highlights vorbereiten ---
        this.allMatches = [];
        for (const r of grouped) {
            for (const rect of r.matches) {
                this.allMatches.push({ pageId: r.pageId, rect });
            }
        }

        this.foundPageIds = new Set(grouped.map(r => r.pageId));
        this.ui.updateSidebarHighlights(this.foundPageIds);
        this.ui.renderAllHighlights(this.allMatches);
        this.ui.showSearchResults(grouped, query);
        this.applySearchHighlightsToBlocks(results);
        this.goToNextMatch();
    }

    private applySearchHighlightsToBlocks(results: SearchResultItem[]): void {
        // Sammle IDs pro Seite
        const textBlockMap = new Map<string, Set<string>>();
        const annotMap = new Map<string, Set<string>>();

        for (const r of results) {
            if (!r.blockId) continue;
            if (r.category === 'textblock') {
                if (!textBlockMap.has(r.pageId)) textBlockMap.set(r.pageId, new Set());
                textBlockMap.get(r.pageId)!.add(r.blockId);
            } else if (r.category === 'annotation') {
                if (!annotMap.has(r.pageId)) annotMap.set(r.pageId, new Set());
                annotMap.get(r.pageId)!.add(r.blockId);
            }
        }

        // Für jede Seite die Highlights setzen (leeres Set entfernt alle)
        const allPageIds = new Set([...textBlockMap.keys(), ...annotMap.keys()]);
        for (const pageId of allPageIds) {
            this.ui.highlightTextBlocks(pageId, textBlockMap.get(pageId) ?? new Set());
            this.ui.highlightAnnotations(pageId, annotMap.get(pageId) ?? new Set());
        }
    }

    public async renderSearchPreview(
        pageId: string,
        rect: { x: number; y: number; width: number; height: number },
        canvas: HTMLCanvasElement
    ): Promise<void> {
        if (!this.currentDocument) return;
        const page = this.currentDocument.pages.find((p) => p.id === pageId);
        if (!page) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const targetW = canvas.width;
        const targetH = canvas.height;

        // Höher aufgelöste Rasterung für lesbare Vorschau (skaliert später auf die
        // Bitmap-Größe des Canvas herunter, wenn dieses per CSS verkleinert ist).
        const scale = 2.0;

        try {
            // --- 1. Basis-Canvas (PDF / Leerseite) ---
            let sourceCanvas: HTMLCanvasElement | null = null;

            if (isPdfPage(page)) {
                const sourcePath = this.currentDocument.sources[page.src];
                if (!sourcePath) return;
                const offscreen = document.createElement("canvas");
                await this.renderer.renderPageToCanvas(sourcePath, page.srcPage, offscreen, {
                    scale, rotate: page.rotate ?? 0,
                });
                sourceCanvas = offscreen;
            } else if (isBlankPage(page)) {
                const size = typeof page.size === "object" ? page.size : PAGE_SIZES[page.size ?? "A4"];
                const offscreen = document.createElement("canvas");
                offscreen.width = size.width * scale;
                offscreen.height = size.height * scale;
                const offCtx = offscreen.getContext("2d");
                if (offCtx) {
                    drawTemplatePattern(offCtx, page.template ?? "blank", size.width, size.height, scale);
                }
                sourceCanvas = offscreen;
            }

            if (!sourceCanvas) return;
            const offCtx = sourceCanvas.getContext("2d");
            if (!offCtx) return;

            // --- 2. Textmarkierungen (PDF-Anmerkungen) ---
            const pdfAnnots = this.pdfAnnotationsCache.get(pageId) ?? [];
            for (const entry of pdfAnnots) {
                offCtx.save();
                offCtx.globalAlpha = 0.5;
                offCtx.fillStyle = entry.color;
                for (const r of entry.rects) {
                    offCtx.fillRect(r.x * scale, r.y * scale, r.width * scale, r.height * scale);
                }
                offCtx.restore();
            }

            // --- 3. Vektorannotationen (Freihand, Linien, Pfeile, Formen) ---
            const rawAnnots = this.currentDocument.annotations[pageId];
            if (rawAnnots) {
                let objects: VectorObject[] = [];
                try { objects = decodeAnnotations(rawAnnots); } catch { /* ignore */ }
                for (const obj of objects) {
                    try {
                        this.drawVectorObjectOnCanvas(offCtx, obj, scale);
                    } catch { /* ignore */ }
                }
            }

            // --- 4. Textblöcke als Platzhalter ---
            const textBlocks = this.textBlocksCache.get(pageId) ?? [];
            if (textBlocks.length > 0) {
                offCtx.save();
                offCtx.fillStyle = "rgba(80, 140, 255, 0.12)";
                offCtx.strokeStyle = "rgba(80, 140, 255, 0.55)";
                offCtx.lineWidth = 1;
                for (const block of textBlocks) {
                    const bx = block.x * scale;
                    const by = block.y * scale;
                    const bw = block.width * scale;
                    const bh = 60 * scale;
                    offCtx.fillRect(bx, by, bw, bh);
                    offCtx.strokeRect(bx, by, bw, bh);
                }
                offCtx.restore();
            }

            // --- 5. Ausschnitt berechnen ---
            const padding = 24;
            const cropX = Math.max(0, (rect.x - padding) * scale);
            const cropY = Math.max(0, (rect.y - padding) * scale);
            const cropW = Math.min(sourceCanvas.width - cropX, (rect.width + 2 * padding) * scale);
            const cropH = Math.min(sourceCanvas.height - cropY, (rect.height + 2 * padding) * scale);
            if (cropW <= 0 || cropH <= 0) return;

            // --- 6. Seitenverhältnis beibehalten (fit mit weißem Hintergrund) ---
            const aspectSrc = cropW / cropH;
            const aspectDst = targetW / targetH;
            let drawW = targetW;
            let drawH = targetH;
            let drawX = 0;
            let drawY = 0;
            if (aspectSrc > aspectDst) {
                drawH = targetW / aspectSrc;
                drawY = (targetH - drawH) / 2;
            } else {
                drawW = targetH * aspectSrc;
                drawX = (targetW - drawW) / 2;
            }

            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, targetW, targetH);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(sourceCanvas, cropX, cropY, cropW, cropH, drawX, drawY, drawW, drawH);

            // --- 7. Treffer-Rahmen ---
            const hlX = drawX + ((rect.x * scale - cropX) / cropW) * drawW;
            const hlY = drawY + ((rect.y * scale - cropY) / cropH) * drawH;
            const hlW = (rect.width * scale / cropW) * drawW;
            const hlH = (rect.height * scale / cropH) * drawH;
            ctx.strokeStyle = "rgba(255, 120, 0, 0.95)";
            ctx.lineWidth = 2;
            ctx.strokeRect(hlX, hlY, hlW, hlH);
        } catch (e) {
            console.warn("PDF Compose: Such-Vorschau fehlgeschlagen", e);
        }
    }

    /**
     * Zeichnet ein Vektorobjekt auf einen 2D-Canvas-Kontext (für die
     * Such-Vorschau). Bewusst vereinfacht: Kurven/Stufen werden als gerade
     * Segmente gerendert - bei der kleinen Vorschaugröße nicht unterscheidbar.
     */
    private drawVectorObjectOnCanvas(
        ctx: CanvasRenderingContext2D,
        obj: VectorObject,
        scale: number,
    ): void {
        switch (obj.type) {
            case "freehand": {
                if (obj.points.length === 0) return;
                ctx.strokeStyle = obj.color;
                ctx.lineWidth = Math.max(0.5, obj.strokeWidth * scale);
                ctx.lineCap = "round";
                ctx.lineJoin = "round";
                ctx.globalAlpha = obj.highlighter ? 0.5 : 1;
                ctx.beginPath();
                ctx.moveTo(obj.points[0].x * scale, obj.points[0].y * scale);
                for (let i = 1; i < obj.points.length; i++) {
                    ctx.lineTo(obj.points[i].x * scale, obj.points[i].y * scale);
                }
                ctx.stroke();
                ctx.globalAlpha = 1;
                break;
            }
            case "line":
            case "arrow": {
                if (obj.points.length < 2) return;
                ctx.strokeStyle = obj.color;
                ctx.lineWidth = Math.max(0.5, obj.width * scale);
                ctx.beginPath();
                ctx.moveTo(obj.points[0].x * scale, obj.points[0].y * scale);
                for (let i = 1; i < obj.points.length; i++) {
                    ctx.lineTo(obj.points[i].x * scale, obj.points[i].y * scale);
                }
                ctx.stroke();
                break;
            }
            case "polygon": {
                if (obj.points.length < 2) return;
                ctx.beginPath();
                ctx.moveTo(obj.points[0].x * scale, obj.points[0].y * scale);
                for (let i = 1; i < obj.points.length; i++) {
                    ctx.lineTo(obj.points[i].x * scale, obj.points[i].y * scale);
                }
                ctx.closePath();
                if (obj.fillColor) {
                    ctx.fillStyle = obj.fillColor;
                    ctx.globalAlpha = obj.fillOpacity ?? 1;
                    ctx.fill();
                    ctx.globalAlpha = 1;
                }
                ctx.strokeStyle = obj.strokeColor;
                ctx.lineWidth = Math.max(0.5, obj.strokeWidth * scale);
                ctx.stroke();
                break;
            }
            case "rectangle": {
                const x = obj.x * scale, y = obj.y * scale, w = obj.width * scale, h = obj.height * scale;
                if (obj.fillColor) {
                    ctx.fillStyle = obj.fillColor;
                    ctx.globalAlpha = obj.fillOpacity ?? 1;
                    ctx.fillRect(x, y, w, h);
                    ctx.globalAlpha = 1;
                }
                ctx.strokeStyle = obj.strokeColor;
                ctx.lineWidth = Math.max(0.5, obj.strokeWidth * scale);
                ctx.strokeRect(x, y, w, h);
                break;
            }
            case "triangle": {
                const width = obj.width ?? obj.size ?? 0;
                const height = obj.height ?? obj.size ?? 0;
                const pts = obj.variant === "right"
                    ? [{ x: obj.x, y: obj.y + height }, { x: obj.x, y: obj.y }, { x: obj.x + width, y: obj.y + height }]
                    : [{ x: obj.x + width / 2, y: obj.y }, { x: obj.x, y: obj.y + height }, { x: obj.x + width, y: obj.y + height }];
                ctx.beginPath();
                ctx.moveTo(pts[0].x * scale, pts[0].y * scale);
                ctx.lineTo(pts[1].x * scale, pts[1].y * scale);
                ctx.lineTo(pts[2].x * scale, pts[2].y * scale);
                ctx.closePath();
                if (obj.fillColor) {
                    ctx.fillStyle = obj.fillColor;
                    ctx.globalAlpha = obj.fillOpacity ?? 1;
                    ctx.fill();
                    ctx.globalAlpha = 1;
                }
                ctx.strokeStyle = obj.strokeColor;
                ctx.lineWidth = Math.max(0.5, obj.strokeWidth * scale);
                ctx.stroke();
                break;
            }
            case "ellipse": {
                ctx.beginPath();
                ctx.ellipse(obj.cx * scale, obj.cy * scale,
                    Math.max(0.1, obj.rx * scale), Math.max(0.1, obj.ry * scale),
                    0, 0, Math.PI * 2);
                if (obj.fillColor) {
                    ctx.fillStyle = obj.fillColor;
                    ctx.globalAlpha = obj.fillOpacity ?? 1;
                    ctx.fill();
                    ctx.globalAlpha = 1;
                }
                ctx.strokeStyle = obj.strokeColor;
                ctx.lineWidth = Math.max(0.5, obj.strokeWidth * scale);
                ctx.stroke();
                break;
            }
            case "diamond": {
                const x = obj.x * scale, y = obj.y * scale, w = obj.width * scale, h = obj.height * scale;
                ctx.beginPath();
                ctx.moveTo(x + w / 2, y);
                ctx.lineTo(x + w, y + h / 2);
                ctx.lineTo(x + w / 2, y + h);
                ctx.lineTo(x, y + h / 2);
                ctx.closePath();
                if (obj.fillColor) {
                    ctx.fillStyle = obj.fillColor;
                    ctx.globalAlpha = obj.fillOpacity ?? 1;
                    ctx.fill();
                    ctx.globalAlpha = 1;
                }
                ctx.strokeStyle = obj.strokeColor;
                ctx.lineWidth = Math.max(0.5, obj.strokeWidth * scale);
                ctx.stroke();
                break;
            }
        }
    }

    /** Baut einen Kontext-Ausschnitt um eine bereits bekannte Trefferposition (charIndex/matchLength). */
    private buildSnippetAt(text: string, charIndex: number, matchLength: number, radius: number = 40): { before: string; match: string; after: string } {
        const start = Math.max(0, charIndex - radius);
        const end = Math.min(text.length, charIndex + matchLength + radius);
        const before = (start > 0 ? "…" : "") + text.substring(start, charIndex);
        const match = text.substring(charIndex, charIndex + matchLength);
        const after = text.substring(charIndex + matchLength, end) + (end < text.length ? "…" : "");
        return { before, match, after };
    }

    /** Sucht den besten (kleinste Distanz) Fuzzy-Treffer in `text` und baut daraus einen Kontext-Ausschnitt. */
    private buildContextSnippet(text: string, query: string, maxDistance: number = 0, radius: number = 40): { before: string; match: string; after: string } {
        const matches = findFuzzyTextMatches(text, query, maxDistance);
        if (matches.length === 0) {
            return { before: text.substring(0, radius), match: "", after: "" };
        }
        const best = matches[0];
        return this.buildSnippetAt(text, best.charIndex, best.text.length, radius);
    }

    /** Rechtecke eines Fuzzy-Treffers innerhalb eines PDF-Textelements (Zeichenposition -> Seitenkoordinaten). */
    private computeFuzzyMatchRect(item: TextItemWithPosition, match: FuzzyTextMatch): { x: number, y: number, width: number, height: number } | null {
        if (item.str.length === 0) return null;
        const charWidth = item.width / item.str.length;
        return {
            x: item.x + match.charIndex * charWidth,
            y: item.y - item.height,
            width: match.text.length * charWidth,
            height: item.height,
        };
    }

    /** Vereinigt die Bounding-Boxen mehrerer aufeinanderfolgender OCR-Wörter zu einem Rechteck. */
    private mergeOcrWordRects(words: OcrWordEntry[]): { x: number, y: number, width: number, height: number } {
        const minX = Math.min(...words.map(w => w.x));
        const minY = Math.min(...words.map(w => w.y));
        const maxX = Math.max(...words.map(w => w.x + w.width));
        const maxY = Math.max(...words.map(w => w.y + w.height));
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    /** Zeichenoffset des Wortes an `wordIndex` innerhalb des mit " " verbundenen Volltexts der OCR-Wörter. */
    private ocrWordCharOffset(words: OcrWordEntry[], wordIndex: number): number {
        let offset = 0;
        for (let i = 0; i < wordIndex; i++) {
            offset += words[i].text.length + 1; // +1 für das trennende Leerzeichen
        }
        return offset;
    }

    public goToNextMatch(): void {
        if (this.allMatches.length === 0) return;
        this.currentMatchIndex = (this.currentMatchIndex + 1) % this.allMatches.length;
        this.setActiveMatch(this.currentMatchIndex);
    }

    public goToPreviousMatch(): void {
        if (this.allMatches.length === 0) return;
        this.currentMatchIndex = (this.currentMatchIndex - 1 + this.allMatches.length) % this.allMatches.length;
        this.setActiveMatch(this.currentMatchIndex);
    }

    public setActiveMatch(index: number): void {
        void this._setActiveMatch(index);
    }

    private async _setActiveMatch(index: number): Promise<void> {
        const match = this.allMatches[index];
        if (match) {
            await this.forceMountPage(match.pageId);
        }

        if (this.plugin.settings.horizontalLayout) {
            // Nur EINE Scroll-Animation: Seite zentrieren. Das Highlight ist im
            // horizontalen Modus (bei nicht zu starkem Zoom) ohnehin sichtbar.
            // Ein zweiter paralleler smooth-Scroll auf das Highlight führte
            // sichtbar zu Ruckeln/"Springen".
            this.ui.setActiveHighlight(index, false);
            if (match) this.ui.scrollToPage(match.pageId);
        } else {
            // Vertikales Layout: bestehende Doppelstrategie beibehalten –
            // zuerst das Highlight zeigen (bei hohen Seiten wichtig), dann die
            // Seite zentrieren.
            this.ui.setActiveHighlight(index, true);
            if (match) this.ui.scrollToPage(match.pageId);
        }
    }

    public jumpToSearchResult(pageId: string): void {
        const index = this.allMatches.findIndex(m => m.pageId === pageId);
        if (index === -1) {
            void this.scrollToPageEnsureMounted(pageId);
            return;
        }
        this.currentMatchIndex = index;
        this.setActiveMatch(index);
    }

    public clearSearchHighlights(): void {
        this.ui.clearHighlights();
        this.allMatches = [];
        this.currentMatchIndex = -1;
        this.foundPageIds.clear();
        this.ui.updateSidebarHighlights(this.foundPageIds);

        // Block-Highlights entfernen
        for (const [pageId, _] of this.textBlocksCache) {
            this.ui.highlightTextBlocks(pageId, new Set());
        }
        for (const [pageId, _] of this.pdfAnnotationsCache) {
            this.ui.highlightAnnotations(pageId, new Set());
        }
    }

    // ============================================================
    //  MODALS (Quelle / Seite hinzufügen, Text anzeigen)
    // ============================================================
    /** Schreibt eine per Debounce noch ausstehende Stiländerung sofort
 *  (siehe schedulePersistStyleToSelection). Da praktisch jede andere
 *  Änderung in diesem Plugin ohnehin sofort persistiert wird, ist dies
 *  der einzige Fall einer "noch ungespeicherten" Änderung - der Button
 *  dient primär als sichtbare Bestätigung/Absicherung. */
    public flushPendingChangesAndNotify(): void {
        if (this.styleWriteDebounceTimer !== null) {
            window.clearTimeout(this.styleWriteDebounceTimer);
            this.styleWriteDebounceTimer = null;
            const pending = this.pendingStylePatch;
            this.pendingStylePatch = null;
            if (pending && this.selectionPageId && this.selectedIds.size > 0) {
                void this.applyStyleToSelection(pending).then(() => {
                    this.renderAnnotationPanel();
                    new Notice("Saved.");
                });
                return;
            }
        }
        new Notice("Saved.");
    }

    private async setColorMode(mode: ColorMode): Promise<void> {
        if (this.colorMode === mode) return;
        const prior = this.colorMode;
        const apply = async (m: ColorMode) => {
            this.colorMode = m;
            if (this.currentDocument) this.currentDocument.colorMode = m;
            this.ui.setColorModeValue(m);
            await this.modifyFrontmatterSilently((fm) => { fm.colorMode = m; });
            await this.remountMountedPages();
        };
        await apply(mode);
        this.pushUndo({
            label: "change-color-mode",
            undo: async () => { await apply(prior); },
            redo: async () => { await apply(mode); },
        });
    }

    /**
 * Erzwingt ein Neuzeichnen aller Seiten, z. B. nachdem sich die globalen
 * Dark-Mode-Filtereinstellungen (Farbton/Monochrom-Tönung) in den
 * Plugin-Einstellungen geändert haben.
 */
    public refreshDarkModeFilters(): void {
        void this.remountMountedPages();
    }

    private async setPageInvert(pageId: string, value: boolean): Promise<void> {
        const page = this.currentDocument?.pages.find(p => p.id === pageId);
        if (!page) return;
        if (value) page.invert = true; else delete page.invert;
        await this.modifyFrontmatterSilently((fm) => {
            const target = (fm.pages as any[]).find((p: any) => p.id === pageId);
            if (!target) return;
            if (value) target.invert = true; else delete target.invert;
        });
        await this.remountPage(pageId);
    }

    /**
     * Kehrt für die aktuell sichtbare Seite die (automatische) Hell-/
     * Dunkel-Anpassung um. Hilft z. B. wenn nach einem Quellwechsel die
     * automatische Erkennung eine Seite falsch einordnet.
     */
    private async toggleInvertForVisiblePage(): Promise<void> {
        const pageId = this.getCurrentVisiblePageId();
        if (!pageId || !this.currentDocument) {
            new Notice("No visible page found.");
            return;
        }
        const page = this.currentDocument.pages.find(p => p.id === pageId);
        if (!page) return;
        const wasInverted = page.invert === true;
        await this.setPageInvert(pageId, !wasInverted);
        this.pushUndo({
            label: "toggle-page-invert",
            undo: async () => { await this.setPageInvert(pageId, wasInverted); },
            redo: async () => { await this.setPageInvert(pageId, !wasInverted); },
        });
    }

    /**
 * Invertiert die Helligkeit der Farben aller aktuell ausgewählten
 * Vektorobjekte und speichert das Ergebnis direkt (mit Undo). Wird vom
 * "Helligkeit invertieren"-Button verwendet, sobald eine Auswahl
 * besteht – ohne Auswahl wirkt derselbe Button stattdessen wie bisher
 * auf die gesamte sichtbare Seite (siehe toggleInvertForVisiblePage).
 */
    private async invertSelectionColors(): Promise<void> {
        const pageId = this.selectionPageId;
        if (!pageId || this.selectedIds.size === 0) return;

        const ids = new Set(this.selectedIds);
        const before = this.getPageAnnotations(pageId).filter(o => ids.has(o.id));
        if (before.length === 0) return;

        await this.invertObjectColorsRaw(pageId, ids);

        this.pushUndo({
            label: "invert-selection-colors",
            undo: async () => {
                const current = this.getPageAnnotations(pageId);
                const map = new Map(before.map(o => [o.id, o]));
                const restored = current.map(o => map.get(o.id) ?? o);
                await this.setPageAnnotations(pageId, restored);
            },
            redo: async () => {
                await this.invertObjectColorsRaw(pageId, ids);
            },
        });
    }

    /** Kehrt die Helligkeit der Farben der übergebenen Objekte um und speichert sie. */
    private async invertObjectColorsRaw(pageId: string, ids: Set<string>): Promise<void> {
        const objects = this.getPageAnnotations(pageId);
        const updated = objects.map((obj): VectorObject => {
            if (!ids.has(obj.id)) return obj;
            switch (obj.type) {
                case "freehand":
                case "line":
                case "arrow":
                    return { ...obj, color: invertLightnessSafe(obj.color) } as VectorObject;
                default:
                    return {
                        ...obj,
                        strokeColor: invertLightnessSafe(obj.strokeColor),
                        fillColor: obj.fillColor ? invertLightnessSafe(obj.fillColor) : obj.fillColor,
                    } as VectorObject;
            }
        });
        await this.setPageAnnotations(pageId, updated);
    }

    public addSource(): void {
        new AddSourceModal(this.app, async (name, path) => {
            const priorExisted = !!this.currentDocument?.sources[name];
            const priorPath = this.currentDocument?.sources[name];

            await this.modifyFrontmatterWithUndo(
                (fm) => {
                    if (!fm.sources) fm.sources = {};
                    fm.sources[name] = path;
                },
                (fm) => {
                    if (!fm.sources) return;
                    if (priorExisted) fm.sources[name] = priorPath;
                    else delete fm.sources[name];
                },
                "add-source"
            );
        }).open();
    }

    public addPage(): void { this.openAddPageModal("end"); }

    private async insertPagesBefore(targetId: string): Promise<void> { this.openAddPageModal("before", targetId); }
    private async insertPagesAfter(targetId: string): Promise<void> { this.openAddPageModal("after", targetId); }

    private openAddPageModal(mode: InsertPositionMode, targetPageId?: string): void {
        if (!this.currentDocument) return;
        const doc = this.currentDocument;
        const initialPosition: InsertPosition = { mode, targetPageId };

        new AddPageModal(
            this.app,
            doc.sources,
            this.renderer,
            this.plugin.settings.templateFolder,
            async (result) => {
                const newPages = this.buildNewPagesFromAddResult(result);
                const newIds = new Set(newPages.map(p => p.id));
                const newSources: Record<string, string> = {};
                if (result.kind === "pdf" && result.isNewSource) newSources[result.sourceName] = result.sourcePath;
                else if (result.kind === "templates") {
                    for (const sel of result.entries) if (sel.kind === "file") newSources[sel.sourceName] = sel.filePath;
                }
                const sourceNames = Object.keys(newSources);
                const position = result.position ?? { mode: "end" };

                await this.modifyFrontmatterWithUndo(
                    (fm) => {
                        if (sourceNames.length > 0) {
                            if (!fm.sources) fm.sources = {};
                            Object.assign(fm.sources, newSources);
                        }
                        const pages = fm.pages as any[];
                        if (position.mode === "end" || !position.targetPageId) {
                            pages.push(...newPages);
                        } else {
                            const idx = pages.findIndex((p: any) => p.id === position.targetPageId);
                            if (idx === -1) pages.push(...newPages);
                            else if (position.mode === "before") pages.splice(idx, 0, ...newPages);
                            else pages.splice(idx + 1, 0, ...newPages);
                        }
                    },
                    (fm) => {
                        fm.pages = fm.pages.filter((p: any) => !newIds.has(p.id));
                        if (fm.sources) for (const name of sourceNames) delete fm.sources[name];
                    },
                    "add-page"
                );
            },
            null,
            doc.pages,
            initialPosition,
        ).open();
    }

    // ============================================================
    //  FRONTMATTER-MODIFIKATION
    // ============================================================
    /** Eigener Schreibvorgang: das nächste "changed"-Event (max. 3 s gültig) nicht neu rendern. */
    private suppressNextChange(): void {
        this.suppressExpiries.push(Date.now() + 3000);
    }

    private consumeSuppressedChange(): boolean {
        const now = Date.now();
        this.suppressExpiries = this.suppressExpiries.filter(t => t > now);
        if (this.suppressExpiries.length === 0) return false;
        this.suppressExpiries.shift();
        return true;
    }

    /** Schreibt Frontmatter, ohne dass die View neu rendert. */
    private async modifyFrontmatterSilently(modifier: (frontmatter: any) => void): Promise<void> {
        this.suppressNextChange();
        await this.modifyFrontmatter(modifier);
    }

    /** Strukturelle Änderung (Seiten, Quellen …): das Event MUSS zum Neu-Rendern führen. */
    private async modifyFrontmatterStructural(modifier: (frontmatter: any) => void): Promise<void> {
        this.suppressExpiries = [];
        await this.modifyFrontmatter(modifier);
    }

    private async modifyFrontmatter(modifier: (frontmatter: any) => void): Promise<void> {
        if (!this.currentFile) return;
        await this.app.fileManager.processFrontMatter(this.currentFile, (frontmatter) => {
            if (frontmatter.pdfcompose !== true) return;
            modifier(frontmatter);
        });
    }

    /** Für Miniaturansichten in der Seitenleiste: Textblöcke einer Seite aus dem aktuellen Cache (ohne Datei-I/O). */
    public getTextBlocksForPage(pageId: string): TextBlockEntry[] {
        return this.textBlocksCache.get(pageId) ?? [];
    }

    public decodeAnnotations(data: string | string[]): VectorObject[] {
        return decodeAnnotations(data);
    }

    // Debug Start
    public toggleOcrDebug(pageId: string): void {
        if (this.ocrDebugEnabledPageIds.has(pageId)) {
            this.removeOcrDebug(pageId);
        } else {
            this.ocrDebugEnabledPageIds.add(pageId);
            this.renderOcrDebugForPage(pageId);
        }
    }

    // Debug-Ebene zeichnen
    public renderOcrDebugForPage(pageId: string): void {
        this.ocrDebugEnabledPageIds.add(pageId);

        const entries = this.ocrCache.get(pageId);
        if (!entries || entries.length === 0) return;

        const wrapper = this.ui.pagesContentEl.querySelector(
            `[data-page-id="${pageId}"] .pdfcompose-page-wrapper`
        ) as HTMLElement | null;
        if (!wrapper) return;

        // Entferne alte Ebene, falls vorhanden
        this.removeOcrDebugLayer(pageId);

        // Neue SVG-Ebene
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.classList.add("pdfcompose-ocr-debug");
        svg.style.position = "absolute";
        svg.style.top = "0";
        svg.style.left = "0";
        svg.style.width = "100%";
        svg.style.height = "100%";
        svg.style.pointerEvents = "none";
        svg.style.zIndex = "50";

        // viewBox aus der Seite ermitteln (aus der annotationLayer)
        const annotSvg = this.ui.annotationLayers.get(pageId);
        if (annotSvg) {
            const viewBox = annotSvg.getAttribute("viewBox");
            if (viewBox) svg.setAttribute("viewBox", viewBox);
        }

        wrapper.appendChild(svg);
        this.ocrDebugLayers.set(pageId, svg);

        // Boxen zeichnen
        const words = entries.flatMap(e => e.words);
        for (const word of words) {
            const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute("x", word.x.toString());
            rect.setAttribute("y", word.y.toString());
            rect.setAttribute("width", word.width.toString());
            rect.setAttribute("height", word.height.toString());
            rect.setAttribute("fill", "rgba(255,0,0,0.2)");
            rect.setAttribute("stroke", "red");
            rect.setAttribute("stroke-width", "1.5");
            rect.setAttribute("stroke-dasharray", "3 3");
            svg.appendChild(rect);

            // Textlabel (nur bei ausreichender Größe)
            if (word.width > 20 && word.height > 10) {
                const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
                text.setAttribute("x", (word.x + 2).toString());
                text.setAttribute("y", (word.y + 12).toString());
                text.setAttribute("font-size", "10");
                text.setAttribute("fill", "red");
                text.setAttribute("font-family", "sans-serif");
                text.textContent = word.text;
                svg.appendChild(text);
            }
        }
    }

    /** Entfernt nur das DOM-Element der Debug-Ebene, OHNE den "aktiviert"-Status zu ändern (wird beim Unmount einer Seite verwendet). */
    private removeOcrDebugLayer(pageId: string): void {
        const svg = this.ocrDebugLayers.get(pageId);
        if (svg) {
            svg.remove();
            this.ocrDebugLayers.delete(pageId);
        }
    }

    // Debug-Ebene entfernen (inkl. "aktiviert"-Status, z. B. per Toggle-Button)
    public removeOcrDebug(pageId: string): void {
        this.ocrDebugEnabledPageIds.delete(pageId);
        this.removeOcrDebugLayer(pageId);
    }

    public toggleAllOcrDebug(visible: boolean): void {
        if (!this.currentDocument) return;
        for (const page of this.currentDocument.pages) {
            if (!this.ocrCache.has(page.id)) continue;
            if (visible) {
                this.ocrDebugEnabledPageIds.add(page.id);
                this.renderOcrDebugForPage(page.id);
            } else {
                this.removeOcrDebug(page.id);
            }
        }
    }

    // ============================================================
    //  BEZIER-DEBUG (nur Diagnose)
    // ============================================================

    /**
     * Zeichnet pro Freihand-Strich:
     *  - rote Kreise: die nach Douglas-Peucker verbliebenen Original-Punkte
     *  - rote gestrichelte Linien: die direkte Polyline zwischen den Punkten
     *  - grüne Kurve: das tatsächlich gerenderte Bezier-Ergebnis
     *  - blaue Linien + blaue Quadrate: Tangenten-Handles (c1, c2) pro Segment
     *
     * Anhand dieser Ebenen lässt sich unmittelbar erkennen, ob die Kurve zu
     * "eckig" wirkt, weil die Punkte zu weit auseinander liegen (dann sind die
     * roten Strecken lang und die grüne Kurve folgt ihnen), ob die Tangenten
     * zu kurz sind (dann laufen die blauen Handles kaum über die Punktmarkierung
     * hinaus), oder ob die Tangenten in die falsche Richtung zeigen.
     */
    public renderBezierDebugForPage(pageId: string): void {
        this.bezierDebugEnabledPageIds.add(pageId);

        const wrapper = this.ui.pagesContentEl.querySelector(
            `[data-page-id="${pageId}"] .pdfcompose-page-wrapper`
        ) as HTMLElement | null;
        if (!wrapper) return;

        this.removeBezierDebugLayer(pageId);

        const annotSvg = this.ui.annotationLayers.get(pageId);
        if (!annotSvg) return;

        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
        const vb = annotSvg.getAttribute("viewBox");
        if (vb) svg.setAttribute("viewBox", vb);
        svg.classList.add("pdfcompose-bezier-debug");
        svg.style.position = "absolute";
        svg.style.top = "0";
        svg.style.left = "0";
        svg.style.width = "100%";
        svg.style.height = "100%";
        svg.style.pointerEvents = "none";
        svg.style.zIndex = "55";
        wrapper.appendChild(svg);
        this.bezierDebugLayers.set(pageId, svg);

        const objects = this.getPageAnnotations(pageId);
        const freehand = objects.filter((o): o is FreehandObject => o.type === "freehand");

        for (const obj of freehand) {
            const pts = obj.points;
            if (pts.length < 2) continue;

            // --- 1. Polyline zwischen Original-Punkten (rot gestrichelt) ---
            for (let i = 0; i < pts.length - 1; i++) {
                const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
                line.setAttribute("x1", pts[i].x.toString());
                line.setAttribute("y1", pts[i].y.toString());
                line.setAttribute("x2", pts[i + 1].x.toString());
                line.setAttribute("y2", pts[i + 1].y.toString());
                line.setAttribute("stroke", "rgba(200, 60, 60, 0.75)");
                line.setAttribute("stroke-width", "0.6");
                line.setAttribute("stroke-dasharray", "2 2");
                svg.appendChild(line);
            }

            // --- 2. Tangenten-Handles pro Segment (blau) ---
            // WICHTIG: exakt dieselbe Funktion wie das echte Rendering. Falls
            // smoothFreehandPathData später auf eine andere Kontrollpunkt-
            // Berechnung umgestellt wird, hier ebenfalls anpassen.
            for (let i = 0; i < pts.length - 1; i++) {
                const p0 = pts[i - 1] ?? pts[i];
                const p1 = pts[i];
                const p2 = pts[i + 1];
                const p3 = pts[i + 2] ?? p2;

                const { c1, c2 } = this.centripetalControlPoints(p0, p1, p2, p3, false);

                const t1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
                t1.setAttribute("x1", p1.x.toString());
                t1.setAttribute("y1", p1.y.toString());
                t1.setAttribute("x2", c1.x.toString());
                t1.setAttribute("y2", c1.y.toString());
                t1.setAttribute("stroke", "rgba(30, 100, 220, 0.9)");
                t1.setAttribute("stroke-width", "0.7");
                svg.appendChild(t1);

                const t2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
                t2.setAttribute("x1", p2.x.toString());
                t2.setAttribute("y1", p2.y.toString());
                t2.setAttribute("x2", c2.x.toString());
                t2.setAttribute("y2", c2.y.toString());
                t2.setAttribute("stroke", "rgba(30, 100, 220, 0.9)");
                t2.setAttribute("stroke-width", "0.7");
                svg.appendChild(t2);

                for (const c of [c1, c2]) {
                    const sq = document.createElementNS("http://www.w3.org/2000/svg", "rect");
                    sq.setAttribute("x", (c.x - 1.5).toString());
                    sq.setAttribute("y", (c.y - 1.5).toString());
                    sq.setAttribute("width", "3");
                    sq.setAttribute("height", "3");
                    sq.setAttribute("fill", "rgba(30, 100, 220, 0.95)");
                    svg.appendChild(sq);
                }
            }

            // --- 3. Tatsächlich gerenderte Bezier-Kurve (grün) ---
            const curve = document.createElementNS("http://www.w3.org/2000/svg", "path");
            curve.setAttribute("d", this.smoothFreehandPathData(pts));
            curve.setAttribute("fill", "none");
            curve.setAttribute("stroke", "rgba(20, 180, 30, 0.9)");
            curve.setAttribute("stroke-width", "1");
            svg.appendChild(curve);

            // --- 3b. Tatsächlich gerenderte Ribbon-Kontur (grün gestrichelt) ---
            //if (!isUniformWidth(obj.points.map(p => p.w || obj.strokeWidth))) {
            const ribbonPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
            // buildVariableWidthPathData liefert eine FILL-Geometrie. Wenn wir sie
            // stroken (fill="none"), sehen wir die Kontur als Umriss.
            ribbonPath.setAttribute("d", buildVariableWidthPathData(
                obj.points.map(p => ({ x: p.x, y: p.y, w: p.w || obj.strokeWidth })),
            ));
            ribbonPath.setAttribute("fill", "none");
            ribbonPath.setAttribute("stroke", "rgba(0, 160, 40, 0.75)");
            ribbonPath.setAttribute("stroke-width", "0.4");
            ribbonPath.setAttribute("stroke-dasharray", "3 2");
            svg.appendChild(ribbonPath);
            //}

            // --- 4. Original-Punkte (rot, oben drauf) ---
            for (let i = 0; i < pts.length; i++) {
                const p = pts[i];
                const circ = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                circ.setAttribute("cx", p.x.toString());
                circ.setAttribute("cy", p.y.toString());
                circ.setAttribute("r", "2");
                circ.setAttribute("fill", "rgba(220, 30, 30, 0.95)");
                circ.setAttribute("stroke", "#ffffff");
                circ.setAttribute("stroke-width", "0.6");
                svg.appendChild(circ);
            }
        }
    }

    private removeBezierDebugLayer(pageId: string): void {
        const svg = this.bezierDebugLayers.get(pageId);
        if (svg) {
            svg.remove();
            this.bezierDebugLayers.delete(pageId);
        }
    }

    public removeBezierDebug(pageId: string): void {
        this.bezierDebugEnabledPageIds.delete(pageId);
        this.removeBezierDebugLayer(pageId);
    }

    public toggleBezierDebug(pageId: string): void {
        if (this.bezierDebugEnabledPageIds.has(pageId)) {
            this.removeBezierDebug(pageId);
        } else {
            this.renderBezierDebugForPage(pageId);
        }
    }

    public toggleAllBezierDebug(visible: boolean): void {
        if (!this.currentDocument) return;
        for (const page of this.currentDocument.pages) {
            if (visible) {
                this.bezierDebugEnabledPageIds.add(page.id);
                this.renderBezierDebugForPage(page.id);
            } else {
                this.removeBezierDebug(page.id);
            }
        }
    }
    // Debug End
}

interface ClipboardContent {
    vectors: VectorObject[];
    textBlocks: TextBlockEntry[];
}

interface PageSnapshot {
    page: PageDefinition;
    objects: VectorObject[];
    textBlocks: TextBlockEntry[];
    pdfAnnotations: PdfAnnotationEntry[];
    ocr: OcrBlockEntry | null;
}

interface PreparedPage {
    page: PageDefinition;
    objects: VectorObject[];
    textBlocks: TextBlockEntry[];
    pdfAnnotations: PdfAnnotationEntry[];
    ocr: OcrBlockEntry | null;
    shapeLabels: ShapeLabelEntry[];
}

interface RangeSession {
    kind: "annotation" | "selection";
    pageId: string;
    wrapper: HTMLElement;
    textLayer: HTMLElement;
    range: Range;
    startHandle: HTMLElement;
    endHandle: HTMLElement;
    toolbar: HTMLElement | null;
    dragging: boolean;
    onRangeChange: (range: Range) => void;
    onCommit: () => void | Promise<void>;
}

interface ZoomAnchor {
    pageId: string;
    /** Relative Position innerhalb der Seiten-Box (0..1, darf leicht außerhalb liegen). */
    fx: number;
    fy: number;
}