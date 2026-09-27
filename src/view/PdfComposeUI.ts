// PdfComposeUI.ts
import { App, Modal, MarkdownRenderer, Component, setIcon, Notice, Menu, MenuItem, TFile, Platform } from "obsidian";
import PdfComposePlugin from "../main";
import { VIEW_TYPE_PDFCOMPOSE, PAGE_SIZES, DEFAULT_RENDER_SCALE } from "./constants";
import { BUILTIN_TEMPLATES, drawTemplatePattern } from "../pdf/TemplatePages";
import {
    PageDefinition,
    PdfComposeDocument,
    PdfPageDefinition,
    BlankPageDefinition,
    isBlankPage,
    isPdfPage,
    VectorObject,
    LineSegmentKind,
    ArrowSide,
    SelectionMode,
    AnnotationTool,
    TOOL_METADATA,
    DEFAULT_PEN_PRESETS,
    PenPreset,
    PressureSettings,
    PressureCurve,
    isPenTool,
    BuiltinTemplateId,
    AddPageResult,
    TemplateSelection,
    FilterTargets,
    ColorMode,
    InsertPosition,
    InsertPositionMode,
} from "../types";
import { TextBlockEntry } from "../parser/TextBlockParser";
import { PdfAnnotationEntry, ConnectorStyle } from "../parser/PdfAnnotationParser";
import { TextItemWithPosition, PdfLinkAnnotation } from "../pdf/PdfPageRenderer";
import { splitHexAlpha, combineHexAlpha } from "../pdf/ColorUtils";
import { SearchResultItem, SearchResultCategory } from "../search/FuzzySearch";
import { decodeAnnotations } from "../pdf/VectorSerializer";

export class PdfComposeUI {
    private plugin: PdfComposePlugin;
    private view: any;
    private container: HTMLElement;

    // Hauptcontainer
    public pagesContainerEl!: HTMLElement;
    public contentAreaEl!: HTMLElement;
    /** Innerer Wrapper für alle Seiten; trägt den Zoom-Faktor (CSS "zoom"). */
    public pagesContentEl!: HTMLElement;

    // Seitenleiste
    public sidebarEl!: HTMLElement;
    public sidebarContentEl!: HTMLElement;
    private sidebarHeaderEl!: HTMLElement;
    private sidebarTabsEl!: HTMLElement;
    private sidebarResizeHandle!: HTMLElement;
    private isSidebarCollapsed: boolean = false;
    private sidebarWidth: number = this.getMinSidebarWidth() + 15; // Standardbreite in px (etwas über dem Minimum)
    private draggingPageId: string | null = null;

    private sidebarThumbObserver: IntersectionObserver | null = null;
    private sidebarThumbTasks: Map<Element, () => Promise<void>> = new Map();
    private thumbPaintQueue: Promise<void> = Promise.resolve();
    private thumbGeneration = 0;
    private currentHighlightedPageId: string | null = null;

    private navLockPageId: string | null = null;
    private navLockTimer: number | null = null;

    // Tab-Inhalte
    private pagesTabContent!: HTMLElement;
    private sourcesTabContent!: HTMLElement;
    private searchTabContent!: HTMLElement;

    // More Options
    private moreOptionsBtn!: HTMLElement;
    private moreOptionsPanel!: HTMLElement;
    private moreOptionsOpen: boolean = false;

    // Seitenliste (Thumbnails)
    public sidebarListEl!: HTMLElement;

    // Quellenliste
    private sourcesListEl!: HTMLElement;

    // Suche
    public searchInputEl!: HTMLInputElement;
    public searchResultsEl!: HTMLElement;
    private highlightEls: (HTMLElement | null)[] = [];

    // Annotationsleiste (bleibt unverändert)
    public annotationToolbarEl!: HTMLElement;
    public annotationPanelEl!: HTMLElement;
    private undoBtn!: HTMLElement;
    private redoBtn!: HTMLElement;
    private zoomControlEl!: HTMLElement;
    private zoomLabelEl!: HTMLElement;
    private pasteBtnEl!: HTMLButtonElement;
    public actionPanelEl!: HTMLElement;
    private copyBtn!: HTMLButtonElement;
    private cutBtn!: HTMLButtonElement;
    private deleteBtn!: HTMLButtonElement;
    private pasteBtn!: HTMLButtonElement;
    private invertBtn!: HTMLButtonElement;
    private colorModeSelectEl!: HTMLSelectElement;
    public bottomRightStackEl!: HTMLElement;
    public toolButtons: Map<AnnotationTool, HTMLElement> = new Map();
    private currentStructureKey: string | null = null;

    // Overlays & Annotation-Layer (von der View gefüllt)
    public pageOverlays: Map<string, HTMLElement> = new Map();
    public annotationLayers: Map<string, SVGSVGElement> = new Map();
    public highlightLayers: Map<string, SVGSVGElement> = new Map();
    public selectionHandlesGroup: SVGGElement | null = null;
    public textBlockLayers: Map<string, HTMLElement> = new Map();
    public annotationColumns: Map<string, HTMLElement> = new Map();
    public connectorLayers: Map<string, SVGSVGElement> = new Map();

    private savePdfTextCheckbox!: HTMLInputElement;

    private readonly groups: { id: string; tools: AnnotationTool[]; default: AnnotationTool }[] = [
        { id: 'selection', tools: ['select-rect', 'select-lasso'], default: 'select-rect' },
        {
            id: 'pen', tools: [
                'pen-fineliner',
                'pen-fountain',
                'pen-pencil',
                'pen-fineliner-red',
                'pen-charcoal',
                'pen-brush',
                'pen-highlighter-yellow',
                'pen-highlighter-blue'
            ],
            default: 'pen-fineliner'
        },
        { id: 'shape', tools: ['line', 'arrow', 'polygon', 'rectangle', 'diamond', 'triangle-equilateral', 'triangle-right', 'ellipse'], default: 'rectangle' }
    ];
    private readonly singleTools: AnnotationTool[] = ['none', 'eraser', 'text'];
    private currentActiveTool: AnnotationTool = "none";
    private groupStates: Map<string, { currentTool: AnnotationTool; isOpen: boolean }> = new Map();
    private groupButtons: Map<string, HTMLElement> = new Map();
    private groupDropdowns: Map<string, HTMLElement> = new Map();
    private onToolSelect: ((tool: AnnotationTool) => void) | null = null;

    private dropTargetPageId: string | null = null;
    private dropAfterTarget: boolean = false;
    private pointerDragSourcePageId: string | null = null;
    private pointerDragPointerId: number | null = null;
    private pointerDragStartPos: { x: number; y: number } | null = null;
    private pointerDragActive: boolean = false;
    private pointerDownStartedOnThumbnail: boolean = false;
    private static readonly DRAG_START_THRESHOLD = 6;
    /** Haltezeit (ms), ab der eine Touch-/Stift-Geste in den Drag-Modus wechselt. */
    private static readonly LONG_PRESS_MS = 350;
    /** Maximale Bewegung (px) VOR dem Long-Press, die noch als "ruhig halten" zählt. */
    private static readonly LONG_PRESS_MOVE_TOLERANCE = 8;
    private pointerLongPressTimer: number | null = null;
    private movePageHandler: ((sourceIds: string[], targetPageId: string) => void) | null = null;
    private scrollToPageHandler: ((pageId: string) => void) | null = null;

    private selectedPageIds: Set<string> = new Set();
    private lastSelectedPageId: string | null = null;
    private pageOrder: string[] = [];
    private pageActionHandlers: {
        onDeletePages: (ids: Set<string>) => void;
        onCopyPages: (ids: Set<string>) => void;
        onRotatePages: (ids: Set<string>) => void;
        hasClipboard: () => boolean;
        onToggleOcrDebug?: (pageId: string) => void;
    } | null = null;

    private pasteBeforeHandler: ((targetId: string) => void) | null = null;
    private pasteAfterHandler: ((targetId: string) => void) | null = null;
    private showTextHandler: ((pageId: string) => void) | null = null;
    private insertPageBeforeHandler: ((targetId: string) => void) | null = null;
    private insertPageAfterHandler: ((targetId: string) => void) | null = null;
    private changePageSourceHandler: ((pageId: string) => void) | null = null;
    private runOcrHandler: ((pageId: string) => void) | null = null;
    private ocrDebugVisible: boolean = false;

    public panelControls: {
        strokeColorInput?: HTMLInputElement;
        strokeAlphaInput?: HTMLInputElement;
        strokeWidthInput?: HTMLInputElement;
        fillToggle?: HTMLInputElement;
        fillColorInput?: HTMLInputElement;
        fillAlphaInput?: HTMLInputElement;
        segmentSelect?: HTMLSelectElement;
        arrowSelect?: HTMLSelectElement;
        arrowSizeInput?: HTMLInputElement;
        modeSelect?: HTMLSelectElement;
        widthReadout?: HTMLElement;
        pressureToggle?: HTMLInputElement;
        pressureDetailsRow?: HTMLElement;
        pressureMinFactorInput?: HTMLInputElement;  // NEU
        pressureCurveSelect?: HTMLSelectElement;
        highlighterToggle?: HTMLInputElement;
        eraserStrokesToggle?: HTMLInputElement;
        eraserShapesToggle?: HTMLInputElement;
        eraserAnnotationsToggle?: HTMLInputElement;
        eraserTextBlocksToggle?: HTMLInputElement;
        eraserHighlightersToggle?: HTMLInputElement;
        shapeHighlighterToggle?: HTMLInputElement;
    } = {};

    // Aktueller Tab
    private currentTab: "pages" | "sources" | "search" = "pages";

    constructor(plugin: PdfComposePlugin, view: any, container: HTMLElement) {
        this.plugin = plugin;
        this.view = view;
        this.container = container;
    }

    // ========== LAYOUT AUFBAUEN ==========
    public buildLayout(): void {
        this.container.empty();
        this.container.addClass("pdfcompose-view-container");
        this.container.setCssStyles({ position: "relative" });

        // Flex-Container (Sidebar + Seitenbereich)
        const flexContainer = this.container.createDiv({ cls: "pdfcompose-flex" });

        // Seitenleiste
        this.sidebarEl = flexContainer.createDiv({ cls: "pdfcompose-sidebar" });
        this.sidebarEl.setCssStyles({ width: this.sidebarWidth + "px", flexShrink: "0" });

        // Header
        this.sidebarHeaderEl = this.sidebarEl.createDiv({ cls: "pdfcompose-sidebar-header" });
        const hamburgerBtn = this.sidebarHeaderEl.createEl("button", {
            cls: "pdfcompose-hamburger",
            text: "☰",
        });
        hamburgerBtn.setAttribute("title", "Show/hide sidebar");
        hamburgerBtn.addEventListener("click", () => this.toggleSidebar());

        const titleEl = this.sidebarHeaderEl.createEl("span", {
            cls: "pdfcompose-sidebar-title",
            text: this.view.currentFile?.basename ?? "PDF Compose",
        });

        // Tabs
        this.sidebarTabsEl = this.sidebarEl.createDiv({ cls: "pdfcompose-sidebar-tabs" });
        const tabs: { id: "pages" | "sources" | "search"; label: string; icon: string }[] = [
            { id: "pages", label: "Pages", icon: "file-stack" },
            { id: "sources", label: "Sources", icon: "folder" },
            { id: "search", label: "Search", icon: "search" },
        ];
        for (const tab of tabs) {
            const btn = this.sidebarTabsEl.createEl("button", { cls: "pdfcompose-tab-btn" });
            setIcon(btn, tab.icon);
            btn.createSpan({ text: tab.label, cls: "pdfcompose-tab-btn-text" });
            btn.dataset.tab = tab.id;
            btn.addEventListener("click", () => this.switchTab(tab.id));
            if (tab.id === "pages") btn.addClass("pdfcompose-tab-active");
        }

        // Content-Bereich der Sidebar
        this.sidebarContentEl = this.sidebarEl.createDiv({ cls: "pdfcompose-sidebar-content" });

        // 1. Seiten-Tab
        this.pagesTabContent = this.sidebarContentEl.createDiv({ cls: "pdfcompose-tab-pane", attr: { "data-tab": "pages" } });
        const addPageBtn = this.pagesTabContent.createEl("button", { cls: "pdfcompose-sidebar-btn" });
        setIcon(addPageBtn, "plus");
        addPageBtn.createSpan({ text: "Add page" });
        addPageBtn.addEventListener("click", () => this.view.addPage());

        const selectionRow = this.pagesTabContent.createDiv({ cls: "pdfcompose-selection-row" });
        const selectAllBtn = selectionRow.createEl("button", { cls: "pdfcompose-sidebar-btn" });
        setIcon(selectAllBtn, "check-check");
        selectAllBtn.createSpan({ text: "Select all" });
        selectAllBtn.addEventListener("click", () => this.selectAllPages());
        const clearSelectionBtn = selectionRow.createEl("button", { cls: "pdfcompose-sidebar-btn" });
        setIcon(clearSelectionBtn, "x");
        clearSelectionBtn.createSpan({ text: "Clear selection" });
        clearSelectionBtn.addEventListener("click", () => this.clearSelection());

        this.sidebarListEl = this.pagesTabContent.createDiv({ cls: "pdfcompose-sidebar-list" });

        // 2. Quellen-Tab
        this.sourcesTabContent = this.sidebarContentEl.createDiv({
            cls: "pdfcompose-tab-pane",
            attr: { "data-tab": "sources" },
        });
        const addSourceBtn = this.sourcesTabContent.createEl("button", { cls: "pdfcompose-sidebar-btn" });
        setIcon(addSourceBtn, "folder-plus");
        addSourceBtn.createSpan({ text: "Add PDF source" });
        addSourceBtn.addEventListener("click", () => this.view.addSource());
        this.sourcesListEl = this.sourcesTabContent.createDiv({ cls: "pdfcompose-sources-list" });

        // 3. Suche-Tab
        this.searchTabContent = this.sidebarContentEl.createDiv({
            cls: "pdfcompose-tab-pane",
            attr: { "data-tab": "search" },
        });
        const searchInputRow = this.searchTabContent.createDiv({ cls: "pdfcompose-search-input-row" });
        this.searchInputEl = searchInputRow.createEl("input", {
            type: "search",
            placeholder: "Search in PDFs…",
            cls: "pdfcompose-search-input",
        });
        this.searchInputEl.setAttribute("enterkeyhint", "search");
        const searchSubmitBtn = searchInputRow.createEl("button", {
            cls: "pdfcompose-search-submit-btn",
            attr: { "aria-label": "Start search", title: "Start search" },
        });
        setIcon(searchSubmitBtn, "search");

        const triggerSearch = () => this.view.performSearch(this.searchInputEl.value);

        this.searchInputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                triggerSearch();
            }
        });
        // Robuster Fallback für Tablet/Mobile: viele virtuelle Tastaturen
        // lösen bei der "Enter"/"Los"/"Suchen"-Taste keinen keydown mit
        // key === "Enter" aus, sondern nur einen "input"-Event vom Typ
        // "insertLineBreak" (bzw. gar keinen erkennbaren Enter-Event).
        this.searchInputEl.addEventListener("input", (e) => {
            const inputType = (e as InputEvent).inputType;
            if (inputType === "insertLineBreak") {
                triggerSearch();
                return;
            }
            if (!this.searchInputEl.value.trim()) {
                this.searchResultsEl.empty();
                this.searchResultsEl.setCssStyles({ display: "none" });
                this.view.clearSearchHighlights();
            }
        });
        searchSubmitBtn.addEventListener("click", (e) => {
            e.preventDefault();
            triggerSearch();
        });

        // Navigation zwischen Treffern
        const searchNavRow = this.searchTabContent.createDiv({ cls: "pdfcompose-search-nav" });
        const prevMatchBtn = searchNavRow.createEl("button", { text: "◀ Previous", cls: "pdfcompose-sidebar-btn" });
        prevMatchBtn.addEventListener("click", () => this.view.goToPreviousMatch());
        const nextMatchBtn = searchNavRow.createEl("button", { text: "Next ▶", cls: "pdfcompose-sidebar-btn" });
        nextMatchBtn.addEventListener("click", () => this.view.goToNextMatch());

        const ocrSection = this.searchTabContent.createDiv({ cls: "pdfcompose-ocr-section" });
        ocrSection.createEl("h4", { text: "OCR" });

        const btnRow = ocrSection.createDiv({ cls: "pdfcompose-ocr-buttons" });
        const runAllBtn = btnRow.createEl("button", { text: "OCR for all pages", cls: "pdfcompose-sidebar-btn" });
        runAllBtn.addEventListener("click", () => this.view.runOcrForDocument());

        const toggleDebugBtn = btnRow.createEl("button", { text: "Show bounding boxes", cls: "pdfcompose-sidebar-btn" });
        toggleDebugBtn.dataset.visible = "false";
        toggleDebugBtn.addEventListener("click", () => {
            const visible = toggleDebugBtn.dataset.visible === "true";
            this.view.toggleAllOcrDebug(!visible);
            toggleDebugBtn.textContent = visible ? "Show bounding boxes" : "Hide bounding boxes";
            toggleDebugBtn.dataset.visible = String(!visible);
        });

        const rerunBtn = btnRow.createEl("button", {
            text: "Re-run OCR completely",
            cls: "pdfcompose-sidebar-btn",
        });
        rerunBtn.setAttribute("title",
            "Re-recognizes ALL pages (including already processed ones). Required after changes " +
            "to the model, settings, or character table – results are fully replaced.");
        rerunBtn.addEventListener("click", () => this.view.runOcrForDocumentForce());

        const bezierDebugBtn = btnRow.createEl("button", {
            text: "Show bezier debug",
            cls: "pdfcompose-sidebar-btn",
        });
        bezierDebugBtn.dataset.visible = "false";
        bezierDebugBtn.setAttribute(
            "title",
            "Draws, per stroke, the Douglas-Peucker points (red), the tangent " +
            "handles (blue), and the rendered bezier curve (green). Shows whether the " +
            "curve looks angular because the points are too far apart or " +
            "because the tangents are too short."
        );
        bezierDebugBtn.addEventListener("click", () => {
            const visible = bezierDebugBtn.dataset.visible === "true";
            this.view.toggleAllBezierDebug(!visible);
            bezierDebugBtn.textContent = visible
                ? "Show bezier debug"
                : "Hide bezier debug";
            bezierDebugBtn.dataset.visible = String(!visible);
        });

        this.searchResultsEl = this.searchTabContent.createDiv({ cls: "pdfcompose-search-results" });
        this.searchResultsEl.setCssStyles({ display: "none" });

        // Standard-Tab aktivieren
        this.switchTab("pages");

        // Resize-Handle
        this.sidebarResizeHandle = this.sidebarEl.createDiv({ cls: "pdfcompose-sidebar-resize" });
        this.sidebarResizeHandle.addEventListener("pointerdown", (e) => this.startResize(e));

        // Hauptbereich (Seiten) - eigener, nicht scrollender Wrapper, damit
        // Werkzeugleiste/Eigenschaften-Panel als Overlay exakt im Bereich
        // rechts der Seitenleiste zentriert werden können (unabhängig vom
        // Scroll-Zustand der Seiten) und ihre Breite relativ zu DIESEM
        // Bereich (nicht zur gesamten View) begrenzt werden kann.
        this.contentAreaEl = flexContainer.createDiv({ cls: "pdfcompose-content-area" });
        this.pagesContainerEl = this.contentAreaEl.createDiv({ cls: "pdfcompose-pages-container" });
        this.pagesContentEl = this.pagesContainerEl.createDiv({ cls: "pdfcompose-pages-content" });

        // Gemeinsamer Overlay-Layer für Toolbar + Eigenschaften-Panel.
        const overlayBar = this.contentAreaEl.createDiv({ cls: "pdfcompose-overlay-bar" });

        const annotationBar = overlayBar.createDiv({ cls: "pdfcompose-annotation-bar" });

        // Undo/Redo-Buttons, direkt links neben der Werkzeugleiste
        const undoRedoGroup = annotationBar.createDiv({ cls: "pdfcompose-undoredo-group" });

        this.undoBtn = undoRedoGroup.createEl("button", { cls: "pdfcompose-tool-btn" });
        setIcon(this.undoBtn, "undo-2");
        this.undoBtn.setAttribute("title", "Undo (Ctrl/Cmd+Z)");
        this.undoBtn.addEventListener("click", () => { void this.view.undo(); });

        this.redoBtn = undoRedoGroup.createEl("button", { cls: "pdfcompose-tool-btn" });
        setIcon(this.redoBtn, "redo-2");
        this.redoBtn.setAttribute("title", "Redo (Ctrl/Cmd+Shift+Z)");
        this.redoBtn.addEventListener("click", () => { void this.view.redo(); });

        this.updateUndoRedoButtons(false, false);

        this.annotationToolbarEl = annotationBar.createDiv({ cls: "pdfcompose-annotation-toolbar" });

        this.annotationPanelEl = overlayBar.createDiv({ cls: "pdfcompose-annotation-panel" });

        this.bottomRightStackEl = this.container.createDiv({ cls: "pdfcompose-bottom-right-stack" });
    }

    private horizontalLayoutCheckbox: HTMLInputElement | null = null;
    private fullscreenIconEl: HTMLElement | null = null;
    private fullscreenLabelEl: HTMLElement | null = null;

    public buildHorizontalLayoutToggle(container: HTMLElement, initialValue: boolean, onChange: (value: boolean) => void): void {
        const row = container.createDiv({ cls: "pdfcompose-colormode-control" });
        const label = row.createEl("label", { cls: "pdfcompose-stylus-toggle-label" });
        setIcon(label, "move-horizontal");
        label.createSpan({ text: "Scroll direction: horizontal" });
        label.setAttribute("title", "Arrange pages horizontally instead of vertically");
        const checkbox = row.createEl("input", { type: "checkbox" }) as HTMLInputElement;
        checkbox.checked = initialValue;
        checkbox.addEventListener("change", () => onChange(checkbox.checked));
        this.horizontalLayoutCheckbox = checkbox;
    }

    public setHorizontalLayoutValue(value: boolean): void {
        if (this.horizontalLayoutCheckbox) this.horizontalLayoutCheckbox.checked = value;
    }

    public buildFullscreenToggle(container: HTMLElement, onToggle: () => void): void {
        const row = container.createDiv({ cls: "pdfcompose-colormode-control" });
        const btn = row.createEl("button", { cls: "pdfcompose-tool-btn" });
        this.fullscreenIconEl = btn.createSpan();
        setIcon(this.fullscreenIconEl, "maximize");
        this.fullscreenLabelEl = btn.createSpan({ text: "Fullscreen" });
        btn.setAttribute(
            "title",
            "Hides the title bar, tab bar and bottom bar of Obsidian. Exit again via this menu."
        );
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.closeMoreOptions();
            onToggle();
        });
    }

    public setFullscreenState(active: boolean): void {
        if (this.fullscreenIconEl) setIcon(this.fullscreenIconEl, active ? "minimize" : "maximize");
        this.fullscreenLabelEl?.setText(active ? "Exit fullscreen" : "Fullscreen");
    }

    /**
 * Schaltet die OCR‑Bounding‑Boxen für alle Seiten mit OCR‑Ergebnissen ein oder aus.
 * @param visible – true: Boxen einblenden, false: ausblenden
 */
    public toggleAllOcrDebug(visible: boolean): void {
        if (!this.view.currentDocument) return;
        for (const page of this.view.currentDocument.pages) {
            if (!this.view.ocrCache.has(page.id)) continue;
            if (visible) {
                this.view.renderOcrDebugForPage(page.id);
            } else {
                this.view.removeOcrDebug(page.id);
            }
        }
    }

    // ========== SIDEBAR EIN-/AUSKLAPPEN ==========
    private toggleSidebar(forceCollapsed?: boolean): void {
        this.isSidebarCollapsed = forceCollapsed ?? !this.isSidebarCollapsed;
        if (this.isSidebarCollapsed) {
            this.sidebarEl.addClass("pdfcompose-sidebar-collapsed");
            this.sidebarEl.setCssStyles({ width: "36px" });
            this.sidebarResizeHandle.setCssStyles({ display: "none" });
        } else {
            this.sidebarEl.removeClass("pdfcompose-sidebar-collapsed");
            this.sidebarEl.setCssStyles({ width: this.sidebarWidth + "px" });
            this.sidebarResizeHandle.setCssStyles({ display: "" });
        }
        this.container.dispatchEvent(new Event("resize"));
    }

    /**
     * Schließt (klappt) die Seitenleiste auf Mobile automatisch ein, sobald
     * das Eigenschaften-Panel wegen Platzmangels unter die Werkzeugleiste
     * umgebrochen ist (siehe .pdfcompose-overlay-bar { flex-wrap: wrap }
     * in styles.css). Auf schmalen Mobile-Bildschirmen verdrängt der
     * umgebrochene Zustand sonst unnötig viel vom ohnehin knappen
     * horizontalen Platz. Öffnet die Seitenleiste NICHT automatisch
     * wieder, sobald der Umbruch verschwindet - das bleibt dem Nutzer
     * überlassen (Hamburger-Button).
     */
    public collapseSidebarIfPanelWrapped(): void {
        if (!Platform.isMobile || this.isSidebarCollapsed) return;
        requestAnimationFrame(() => {
            if (this.isSidebarCollapsed) return;
            const toolbarRect = this.annotationToolbarEl.getBoundingClientRect();
            const panelRect = this.annotationPanelEl.getBoundingClientRect();
            // Leeres Panel (kein Werkzeug/keine Auswahl aktiv) hat keine
            // Ausdehnung - dann kann auch kein Umbruch stattfinden.
            if (panelRect.width === 0 || panelRect.height === 0) return;
            // "Umgebrochen" heißt: das Panel beginnt spürbar unterhalb der
            // Werkzeugleiste, statt daneben in derselben Zeile zu stehen.
            if (panelRect.top > toolbarRect.top + toolbarRect.height / 2) {
                this.toggleSidebar(true);
            }
        });
    }

    /**
     * Mindestbreite der Seitenleiste. Auf Mobile ca. ein Drittel größer als
     * auf Desktop, da die Seitenübersicht (Thumbnail, Checkbox, Label,
     * Menü-Button pro Zeile) bei 225px auf Touch-Geräten kaum noch bedienbar
     * ist. Muss zum CSS-Backstop in styles.css (.pdfcompose-sidebar /
     * body.is-mobile .pdfcompose-sidebar) passen.
     */
    private getMinSidebarWidth(): number {
        return Platform.isMobile ? 300 : 225;
    }

    // ========== RESIZE (Drag) ==========
    private startResize(e: PointerEvent): void {
        e.preventDefault();
        try { this.sidebarResizeHandle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        const pointerId = e.pointerId;
        const startX = e.clientX;
        const startWidth = this.sidebarEl.getBoundingClientRect().width;
        const minWidth = this.getMinSidebarWidth();

        const onMove = (ev: PointerEvent) => {
            if (ev.pointerId !== pointerId) return;
            ev.preventDefault();
            const newWidth = Math.max(minWidth, startWidth + (ev.clientX - startX));
            this.sidebarWidth = newWidth;
            if (!this.isSidebarCollapsed) {
                this.sidebarEl.setCssStyles({ width: newWidth + "px" });
            }
        };

        const onUp = (ev: PointerEvent) => {
            if (ev.pointerId !== pointerId) return;
            this.sidebarResizeHandle.removeEventListener("pointermove", onMove);
            this.sidebarResizeHandle.removeEventListener("pointerup", onUp);
            this.sidebarResizeHandle.removeEventListener("pointercancel", onUp);
            try { this.sidebarResizeHandle.releasePointerCapture(pointerId); } catch { /* ignore */ }
        };

        this.sidebarResizeHandle.addEventListener("pointermove", onMove);
        this.sidebarResizeHandle.addEventListener("pointerup", onUp);
        this.sidebarResizeHandle.addEventListener("pointercancel", onUp);
    }

    // ========== TAB-WECHSEL ==========
    private switchTab(tab: "pages" | "sources" | "search"): void {
        this.currentTab = tab;
        // Tabs aktualisieren
        this.sidebarTabsEl.querySelectorAll(".pdfcompose-tab-btn").forEach((btn) => {
            const btnEl = btn as HTMLButtonElement;
            const tabId = btnEl.dataset.tab;
            if (tabId === tab) {
                btnEl.addClass("pdfcompose-tab-active");
            } else {
                btnEl.removeClass("pdfcompose-tab-active");
            }
        });

        // Inhalte ein-/ausblenden
        const panes = {
            pages: this.pagesTabContent,
            sources: this.sourcesTabContent,
            search: this.searchTabContent,
        };
        for (const [key, pane] of Object.entries(panes)) {
            if (key === tab) {
                pane.setCssStyles({ display: "" });
            } else {
                pane.setCssStyles({ display: "none" });
            }
        }

        // Wenn Suche-Tab aktiv, Fokus ins Suchfeld
        if (tab === "search") {
            setTimeout(() => this.searchInputEl.focus(), 50);
        }
    }

    public setScrollToPageHandler(handler: (pageId: string) => void): void {
        this.scrollToPageHandler = handler;
    }

    // ========== SEITENLISTE (THUMBNAILS) RENDERN ==========
    public renderSidebarThumbnail(
        page: PageDefinition,
        index: number,
        doc: PdfComposeDocument,
        renderer: any,
        sizeHintPx?: { width: number; height: number },
    ): void {
        const item = this.sidebarListEl.createDiv({ cls: "pdfcompose-sidebar-item" });
        item.setAttribute("data-page-id", page.id);
        this.pageOrder.push(page.id);
        item.addEventListener("pointerdown", (e) => this.onSidebarItemPointerDown(e, page.id));

        const thumbContainer = item.createDiv({ cls: "pdfcompose-thumbnail" });
        const thumbScale = 0.12 * 2;
        const canvas = thumbContainer.createEl("canvas", { cls: "pdfcompose-thumb-canvas" });

        const ptSize = isBlankPage(page)
            ? (typeof page.size === "object" ? page.size : PAGE_SIZES[page.size ?? "A4"])
            : (sizeHintPx
                ? { width: sizeHintPx.width / DEFAULT_RENDER_SCALE, height: sizeHintPx.height / DEFAULT_RENDER_SCALE }
                : PAGE_SIZES.A4);
        canvas.width = Math.max(1, Math.round(ptSize.width * thumbScale));
        canvas.height = Math.max(1, Math.round(ptSize.height * thumbScale));

        const paint = async (): Promise<void> => {
            if (isBlankPage(page)) {
                const size = typeof page.size === "object" ? page.size : PAGE_SIZES[page.size ?? "A4"];
                const ctx = canvas.getContext("2d");
                if (ctx) drawTemplatePattern(ctx, page.template ?? "blank", size.width, size.height, thumbScale);
                this.drawThumbnailOverlay(canvas, doc, page, thumbScale);
            } else if (isPdfPage(page)) {
                const sourcePath = doc.sources[page.src];
                if (!sourcePath) {
                    canvas.remove();
                    thumbContainer.createDiv({ text: "Quelle fehlt", cls: "pdfcompose-thumb-error" });
                    return;
                }
                try {
                    await renderer.renderPageToCanvas(sourcePath, page.srcPage, canvas, {
                        scale: thumbScale,
                        rotate: page.rotate ?? 0,
                    });
                    this.drawThumbnailOverlay(canvas, doc, page, thumbScale);
                } catch {
                    canvas.remove();
                    thumbContainer.createDiv({ text: "Fehler", cls: "pdfcompose-thumb-error" });
                }
            }
        };

        if (!this.sidebarThumbObserver) {
            this.sidebarThumbObserver = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const task = this.sidebarThumbTasks.get(entry.target);
                    this.sidebarThumbObserver?.unobserve(entry.target);
                    this.sidebarThumbTasks.delete(entry.target);
                    if (!task) continue;
                    const gen = this.thumbGeneration;
                    this.thumbPaintQueue = this.thumbPaintQueue
                        .then(() => (gen === this.thumbGeneration ? task() : undefined))
                        .catch(() => { /* ignore */ });
                }
            }, { root: this.sidebarContentEl, rootMargin: "300px 0px" });
        }
        this.sidebarThumbTasks.set(item, paint);
        this.sidebarThumbObserver.observe(item);

        const controlRow = item.createDiv({ cls: "pdfcompose-sidebar-controls" });

        const checkbox = controlRow.createEl("input", { type: "checkbox", cls: "pdfcompose-sidebar-checkbox" });
        checkbox.checked = this.selectedPageIds.has(page.id);
        checkbox.setAttribute("draggable", "false");
        checkbox.addEventListener("mousedown", (e) => e.stopPropagation());
        checkbox.addEventListener("click", (e) => this.onCheckboxClick(e as MouseEvent, page.id));

        const infoContainer = controlRow.createDiv({ cls: "pdfcompose-sidebar-info" });
        const label = infoContainer.createDiv({ cls: "pdfcompose-sidebar-label" });
        label.setText(`#${index + 1}`);
        if (isPdfPage(page)) {
            infoContainer.createDiv({ cls: "pdfcompose-sidebar-source" }).setText(`${page.src}: S. ${page.srcPage}`);
        } else if (isBlankPage(page)) {
            infoContainer.createDiv({ cls: "pdfcompose-sidebar-source" }).setText("Blank page");
        }

        const menuBtn = controlRow.createEl("button", { cls: "pdfcompose-sidebar-menu-btn", text: "⋮" });
        menuBtn.setAttribute("draggable", "false");
        menuBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const rect = menuBtn.getBoundingClientRect();
            const menu = this.buildContextMenu(page.id);
            menu.showAtPosition({ x: rect.left, y: rect.bottom });
        });
    }

    public updatePlaceholderSize(pageWrapperEl: HTMLElement, width: number, height: number): void {
        const sk = pageWrapperEl.querySelector<HTMLElement>(".pdfcompose-page-skeleton");
        if (!sk) return;
        sk.setCssStyles({ width: `${width}px`, height: `${height}px` });
    }

    /**
 * Zeichnet eine stark vereinfachte Vorschau der Stift-Striche/Formen und
 * Textblöcke einer Seite auf die (bereits mit Hintergrund gefüllte)
 * Thumbnail-Canvas. Kurven/Stufen werden dabei bewusst als gerade
 * Segmente vereinfacht - bei der winzigen Miniaturgröße macht das
 * visuell keinen wahrnehmbaren Unterschied.
 */
    private drawThumbnailOverlay(
        canvas: HTMLCanvasElement,
        doc: PdfComposeDocument,
        page: PageDefinition,
        scale: number
    ): void {
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const textBlocks = this.view.getTextBlocksForPage?.(page.id) ?? [];
        ctx.fillStyle = "rgba(80, 140, 255, 0.35)";
        for (const block of textBlocks) {
            const placeholderHeight = 14;
            ctx.fillRect(block.x * scale, block.y * scale, block.width * scale, placeholderHeight * scale);
        }

        const raw = doc.annotations[page.id];
        if (!raw || raw.length === 0) return;
        let objects: VectorObject[];
        try {
            objects = decodeAnnotations(raw);
        } catch {
            return;
        }

        for (const obj of objects) {
            try {
                this.drawThumbnailObject(ctx, obj, scale);
            } catch {
                // Ein fehlerhaftes Objekt darf die restliche Miniatur nicht verhindern.
            }
        }
    }

    private drawThumbnailObject(ctx: CanvasRenderingContext2D, obj: VectorObject, scale: number): void {
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
                const { x, y, variant } = obj;
                const pts = variant === "right"
                    ? [{ x, y: y + height }, { x, y }, { x: x + width, y: y + height }]
                    : [{ x: x + width / 2, y }, { x, y: y + height }, { x: x + width, y: y + height }];
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
                ctx.ellipse(obj.cx * scale, obj.cy * scale, Math.max(0.1, obj.rx * scale), Math.max(0.1, obj.ry * scale), 0, 0, Math.PI * 2);
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

    private setDropTargetItem(pageId: string): void {
        if (this.dropTargetPageId === pageId) return;
        this.clearDropTargetHighlight();
        this.dropTargetPageId = pageId;
        const el = this.sidebarListEl.querySelector(`[data-page-id="${pageId}"]`);
        el?.addClass("pdfcompose-sidebar-drop-target");
    }

    private clearDropTargetHighlight(): void {
        if (!this.dropTargetPageId) return;
        const el = this.sidebarListEl.querySelector(`[data-page-id="${this.dropTargetPageId}"]`);
        el?.removeClass("pdfcompose-sidebar-drop-target");
        el?.removeClass("pdfcompose-sidebar-drop-target-after");
        el?.removeClass("pdfcompose-sidebar-drop-target-before");
        this.dropTargetPageId = null;
    }

    private currentDragSourceIds(): string[] {
        if (!this.pointerDragSourcePageId) return [];
        if (this.selectedPageIds.has(this.pointerDragSourcePageId) && this.selectedPageIds.size > 1) {
            return this.pageOrder.filter(id => this.selectedPageIds.has(id));
        }
        return [this.pointerDragSourcePageId];
    }

    private onSidebarItemPointerDown(e: PointerEvent, pageId: string): void {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const target = e.target as HTMLElement;
        if (target.closest(".pdfcompose-sidebar-checkbox") ||
            target.closest(".pdfcompose-sidebar-menu-btn")) return;

        this.pointerDragSourcePageId = pageId;
        this.pointerDragPointerId = e.pointerId;
        this.pointerDragStartPos = { x: e.clientX, y: e.clientY };
        this.pointerDragActive = false;
        this.pointerDownStartedOnThumbnail = !!target.closest(".pdfcompose-thumbnail");

        const item = e.currentTarget as HTMLElement;

        if (e.pointerType === "mouse") {
            // Desktop: sofortige Drag-Bereitschaft, preventDefault ist ok.
            e.preventDefault();
            try { item.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        } else {
            // Touch/Stift: NICHT preventDefault, NICHT setPointerCapture,
            // NICHT touch-action umstellen – sonst startet der Browser nie
            // sein Scrollen und wir können die Seitenliste nicht scrollen.
            // Stattdessen: Long-Press-Timer; erst wenn der feuert, wird die
            // Geste exklusiv übernommen.
            this.pointerLongPressTimer = window.setTimeout(() => {
                this.pointerLongPressTimer = null;
                this.activateSidebarDrag(e.pointerId, pageId, item);
            }, PdfComposeUI.LONG_PRESS_MS);
        }

        item.addEventListener("pointermove", this.onSidebarItemPointerMove);
        item.addEventListener("pointerup", this.onSidebarItemPointerUp);
        item.addEventListener("pointercancel", this.onSidebarItemPointerUp);
        document.addEventListener("pointermove", this.onSidebarItemPointerMove);
        document.addEventListener("pointerup", this.onSidebarItemPointerUp);
        document.addEventListener("pointercancel", this.onSidebarItemPointerUp);
    }

    /** Nach erfolgreichem Long-Press: Geste exklusiv übernehmen. */
    private activateSidebarDrag(pointerId: number, pageId: string, item: HTMLElement): void {
        this.pointerDragActive = true;
        this.draggingPageId = pageId;
        // Erst jetzt touch-action unterbinden und Pointer-Capture setzen.
        this.sidebarContentEl.setCssStyles({ touchAction: "none" });
        this.sidebarListEl.querySelectorAll<HTMLElement>(".pdfcompose-sidebar-item")
            .forEach(el => { el.setCssStyles({ touchAction: "none" }); });
        try { item.setPointerCapture(pointerId); } catch { /* ignore */ }
        for (const id of this.currentDragSourceIds()) {
            this.sidebarListEl.querySelector(`[data-page-id="${id}"]`)
                ?.addClass("pdfcompose-sidebar-dragging");
        }
    }

    private cancelSidebarLongPress(): void {
        if (this.pointerLongPressTimer !== null) {
            window.clearTimeout(this.pointerLongPressTimer);
            this.pointerLongPressTimer = null;
        }
    }

    /**
     * Findet das der Zeigerposition nächstgelegene Sidebar-Item (per Abstand
     * der Mittelpunkte), unabhängig davon, ob der Zeiger gerade über einer
     * Lücke im Grid-Layout steht. document.elementFromPoint() allein reichte
     * nicht aus, da die Sidebar-Liste ein zweispaltiges CSS-Grid mit
     * sichtbaren Lücken zwischen den Kacheln ist - der Zeiger befindet sich
     * beim Ziehen sehr häufig genau in einer solchen Lücke, wodurch
     * elementFromPoint() nur das Grid selbst (statt einer Kachel) lieferte
     * und das Ziel-Highlight ständig verschwand ("unzuverlässig").
     */
    private findNearestSidebarItem(clientX: number, clientY: number, excludeIds: Set<string>): { pageId: string; rect: DOMRect } | null {
        let best: { pageId: string; rect: DOMRect } | null = null;
        let bestDist = Infinity;
        const items = this.sidebarListEl.querySelectorAll<HTMLElement>(".pdfcompose-sidebar-item[data-page-id]");
        items.forEach((el) => {
            const id = el.getAttribute("data-page-id");
            if (!id || excludeIds.has(id)) return;
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dist = Math.hypot(clientX - cx, clientY - cy);
            if (dist < bestDist) {
                bestDist = dist;
                best = { pageId: id, rect };
            }
        });
        return best;
    }

    private onSidebarItemPointerMove = (e: PointerEvent): void => {
        if (this.pointerDragPointerId !== e.pointerId ||
            !this.pointerDragStartPos ||
            !this.pointerDragSourcePageId) return;

        const dx = e.clientX - this.pointerDragStartPos.x;
        const dy = e.clientY - this.pointerDragStartPos.y;
        const dist = Math.hypot(dx, dy);

        // Touch/Stift vor Long-Press: bei zu viel Bewegung abbrechen und dem
        // Browser das Scrollen überlassen. Listeners bleiben dran - der
        // Browser feuert dann pointercancel und onSidebarItemPointerUp räumt auf.
        if (e.pointerType !== "mouse" && !this.pointerDragActive) {
            if (dist > PdfComposeUI.LONG_PRESS_MOVE_TOLERANCE) {
                this.cancelSidebarLongPress();
            }
            return; // kein preventDefault - der Browser scrollt jetzt
        }

        if (!this.pointerDragActive) {
            if (dist < PdfComposeUI.DRAG_START_THRESHOLD) return;
            this.pointerDragActive = true;
            this.draggingPageId = this.pointerDragSourcePageId;
            for (const id of this.currentDragSourceIds()) {
                this.sidebarListEl.querySelector(`[data-page-id="${id}"]`)
                    ?.addClass("pdfcompose-sidebar-dragging");
            }
        }

        e.preventDefault();

        const draggedIds = new Set(this.currentDragSourceIds());
        const nearest = this.findNearestSidebarItem(e.clientX, e.clientY, draggedIds);
        if (nearest) this.setDropTargetItem(nearest.pageId);
        else this.clearDropTargetHighlight();

        this.autoScrollSidebarDuringPointerDrag(e.clientY);
    };

    private onSidebarItemPointerUp = (e: PointerEvent): void => {
        if (this.pointerDragPointerId !== e.pointerId) return;
        this.cancelSidebarLongPress();

        const isCancelled = e.type === "pointercancel";
        const sourceIds = this.currentDragSourceIds();
        const wasActive = this.pointerDragActive;
        const startedOnThumbnail = this.pointerDownStartedOnThumbnail;
        const singlePageId = this.pointerDragSourcePageId;

        const item = this.sidebarListEl.querySelector<HTMLElement>(`[data-page-id="${singlePageId}"]`);
        item?.removeEventListener("pointermove", this.onSidebarItemPointerMove);
        item?.removeEventListener("pointerup", this.onSidebarItemPointerUp);
        item?.removeEventListener("pointercancel", this.onSidebarItemPointerUp);
        document.removeEventListener("pointermove", this.onSidebarItemPointerMove);
        document.removeEventListener("pointerup", this.onSidebarItemPointerUp);
        document.removeEventListener("pointercancel", this.onSidebarItemPointerUp);
        if (item && item.hasPointerCapture(e.pointerId)) {
            try { item.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        }

        this.sidebarContentEl.setCssStyles({ touchAction: "" });
        this.sidebarListEl.querySelectorAll<HTMLElement>(".pdfcompose-sidebar-item")
            .forEach(el => { el.setCssStyles({ touchAction: "" }); });
        for (const id of sourceIds) {
            this.sidebarListEl.querySelector(`[data-page-id="${id}"]`)
                ?.removeClass("pdfcompose-sidebar-dragging");
        }
        this.clearDropTargetHighlight();

        this.draggingPageId = null;
        this.pointerDragSourcePageId = null;
        this.pointerDragPointerId = null;
        this.pointerDragStartPos = null;
        this.pointerDragActive = false;
        this.pointerDownStartedOnThumbnail = false;

        // Vom Browser abgebrochene Geste (Scrollen übernommen): weder Drop noch Tap.
        if (isCancelled) return;

        if (wasActive) {
            const draggedIds = new Set(sourceIds);
            const nearest = this.findNearestSidebarItem(e.clientX, e.clientY, draggedIds);
            if (nearest && sourceIds.length > 0 && this.movePageHandler &&
                !sourceIds.includes(nearest.pageId)) {
                this.movePageHandler(sourceIds, nearest.pageId);
            }
            return;
        }

        if (!startedOnThumbnail || !singlePageId) return;
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
            this.handleItemSelectClick(singlePageId, e);
        } else {
            this.scrollToPageHandler?.(singlePageId);
        }
    };

    /** Auto-Scroll der Seitenleiste während eines per Pointer gezogenen Seiten-Reorderings. */
    private autoScrollSidebarDuringPointerDrag(clientY: number): void {
        const scrollEl = this.sidebarContentEl;
        if (!scrollEl) return;
        const rect = scrollEl.getBoundingClientRect();
        const margin = 36;
        const distanceFromTop = clientY - rect.top;
        const distanceFromBottom = rect.bottom - clientY;
        if (distanceFromTop < margin) {
            scrollEl.scrollTop -= Math.max(2, (margin - distanceFromTop) / 2);
        } else if (distanceFromBottom < margin) {
            scrollEl.scrollTop += Math.max(2, (margin - distanceFromBottom) / 2);
        }
    }

    /** Schaltet alle Seiten zwischen dem letzten Auswahl-Anker und `pageId` (inklusive) EINHEITLICH um: ob der ganze Bereich aus- oder abgewählt wird, entscheidet sich danach, ob `pageId` VOR dieser Aktion bereits ausgewählt war. Ohne vorhandenen Anker wird nur `pageId` selbst umgeschaltet und als neuer Anker gemerkt. */
    private toggleRangeSelection(pageId: string): void {
        if (!this.lastSelectedPageId) {
            if (this.selectedPageIds.has(pageId)) this.selectedPageIds.delete(pageId);
            else this.selectedPageIds.add(pageId);
            this.lastSelectedPageId = pageId;
            return;
        }

        const startIdx = this.pageOrder.indexOf(this.lastSelectedPageId);
        const endIdx = this.pageOrder.indexOf(pageId);
        if (startIdx === -1 || endIdx === -1) return;

        const min = Math.min(startIdx, endIdx);
        const max = Math.max(startIdx, endIdx);

        // Einheitliche Aktion für den gesamten Bereich: War die angeklickte
        // Seite vor dem Klick NICHT ausgewählt, wird der gesamte Bereich
        // ausgewählt - war sie es bereits, wird der gesamte Bereich abgewählt.
        const shouldSelect = !this.selectedPageIds.has(pageId);

        for (let i = min; i <= max; i++) {
            const id = this.pageOrder[i];
            if (shouldSelect) this.selectedPageIds.add(id);
            else this.selectedPageIds.delete(id);
        }
        // Anker bewusst NICHT auf pageId verschieben, damit aufeinander-
        // folgende Shift-Klicks sich weiterhin auf denselben Ausgangspunkt
        // beziehen und der Bereich frei nachjustiert werden kann.
    }

    private onCheckboxClick(e: MouseEvent, pageId: string): void {
        if (e.shiftKey) {
            // Natives Toggle der Checkbox unterdrücken - die Range-Logik
            // übernimmt den Zustand dieser Seite mit, updateSidebarCheckboxes()
            // synchronisiert die Checkbox danach ohnehin.
            e.preventDefault();
            this.toggleRangeSelection(pageId);
        } else {
            const checkbox = e.currentTarget as HTMLInputElement;
            if (checkbox.checked) this.selectedPageIds.add(pageId);
            else this.selectedPageIds.delete(pageId);
            this.lastSelectedPageId = pageId;
        }
        this.updateSidebarCheckboxes();
    }

    /** Shift-/Strg-Klick direkt auf die Zeile (nicht nur auf die Checkbox) für schnellere Mehrfachauswahl. */
    private handleItemSelectClick(pageId: string, e: MouseEvent): void {
        if (e.shiftKey) {
            this.toggleRangeSelection(pageId);
        } else if (e.ctrlKey || e.metaKey) {
            if (this.selectedPageIds.has(pageId)) this.selectedPageIds.delete(pageId);
            else this.selectedPageIds.add(pageId);
            this.lastSelectedPageId = pageId;
        }
        this.updateSidebarCheckboxes();
    }

    private updateSidebarCheckboxes(): void {
        this.sidebarListEl.querySelectorAll('.pdfcompose-sidebar-item').forEach(item => {
            const checkbox = item.querySelector('.pdfcompose-sidebar-checkbox') as HTMLInputElement;
            if (checkbox) {
                const id = item.getAttribute('data-page-id');
                if (id) checkbox.checked = this.selectedPageIds.has(id);
            }
        });
    }

    private buildContextMenu(pageId: string): Menu {
        const menu = new Menu();

        let selectedIds: Set<string>;

        if (this.selectedPageIds.size > 0 && this.selectedPageIds.has(pageId)) {
            selectedIds = this.selectedPageIds;
        } else {
            selectedIds = new Set([pageId]);
        }

        if (selectedIds.size > 0) {
            menu.addItem((item: MenuItem) =>
                item.setTitle("Delete").setIcon("trash").onClick(() =>
                    this.pageActionHandlers!.onDeletePages(selectedIds)));
            menu.addItem((item: MenuItem) =>
                item.setTitle("Copy").setIcon("copy").onClick(() =>
                    this.pageActionHandlers!.onCopyPages(selectedIds)));
            menu.addItem((item: MenuItem) =>
                item.setTitle("Rotate").setIcon("rotate-cw").onClick(() =>
                    this.pageActionHandlers!.onRotatePages(selectedIds)));

            if (selectedIds.size === 1 && this.changePageSourceHandler) {
                menu.addItem((item: MenuItem) =>
                    item.setTitle("Change source / page").setIcon("file-edit").onClick(() =>
                        this.changePageSourceHandler!(pageId)));
            }

            menu.addItem((item: MenuItem) =>
                item.setTitle("Insert page before").setIcon("plus").onClick(() =>
                    this.insertPageBeforeHandler!(pageId)));
            menu.addItem((item: MenuItem) =>
                item.setTitle("Insert page after").setIcon("plus").onClick(() =>
                    this.insertPageAfterHandler!(pageId)));

            if (selectedIds.size === 1 && this.pageActionHandlers!.hasClipboard()) {
                menu.addItem((item: MenuItem) =>
                    item.setTitle("Paste before").setIcon("clipboard-paste").onClick(() =>
                        this.pasteBeforeHandler!(pageId)));
                menu.addItem((item: MenuItem) =>
                    item.setTitle("Paste after").setIcon("clipboard-paste").onClick(() =>
                        this.pasteAfterHandler!(pageId)));
            }

            if (this.showTextHandler) {
                menu.addItem((item: MenuItem) =>
                    item.setTitle("Show page text").setIcon("text").onClick(() =>
                        this.showTextHandler!(pageId)));
            }
        }

        return menu;
    }

    private selectAllPages(): void {
        this.selectedPageIds = new Set(this.pageOrder);
        this.lastSelectedPageId = this.pageOrder[this.pageOrder.length - 1] ?? null;
        this.updateSidebarCheckboxes();
    }

    public clearSelection(): void {
        this.selectedPageIds.clear();
        this.lastSelectedPageId = null;
        this.updateSidebarCheckboxes();
    }

    public setMovePageHandler(
        handler: (sourceIds: string[], targetPageId: string) => void
    ): void {
        this.movePageHandler = handler;
    }

    // ========== QUELLENLISTE RENDERN ==========
    public renderSourcesList(
        sources: Record<string, string>
    ): void {
        this.sourcesListEl.empty();

        if (Object.keys(sources).length === 0) {
            this.sourcesListEl.createDiv({
                cls: "pdfcompose-empty-state",
                text: "No sources defined.",
            });

            return;
        }

        for (const [name, path] of Object.entries(sources)) {
            const item = this.sourcesListEl.createDiv({
                cls: "pdfcompose-source-item",
            });

            item.createSpan({
                text: name,
                cls: "pdfcompose-source-name",
            });

            item.createSpan({
                text: path,
                cls: "pdfcompose-source-path",
            });

            const menuBtn = item.createEl("button", {
                text: "⋮",
                cls: "pdfcompose-source-menu",
                attr: {
                    "aria-label": `Options for source ${name}`,
                    title: "Source options",
                },
            });

            menuBtn.addEventListener("click", (event) => {
                event.stopPropagation();

                const menu = new Menu();

                menu.addItem((menuItem) => {
                    menuItem
                        .setTitle("Adjust file path")
                        .setIcon("file-edit")
                        .onClick(() => {
                            void this.view.changeSourcePath(name);
                        });
                });

                menu.addItem((menuItem) => {
                    menuItem
                        .setTitle("Delete source")
                        .setIcon("trash")
                        .onClick(() => {
                            void this.view.removeSource(name);
                        });
                });

                menu.showAtMouseEvent(event);
            });
        }
    }

    public setPageActionHandlers(handlers: {
        onDeletePages: (ids: Set<string>) => void;
        onCopyPages: (ids: Set<string>) => void;
        onRotatePages: (ids: Set<string>) => void;
        onPasteBefore: (targetId: string) => void;
        onPasteAfter: (targetId: string) => void;
        onInsertPageBefore: (targetId: string) => void;
        onInsertPageAfter: (targetId: string) => void;
        onShowText: (pageId: string) => void;
        onRunOcr: (pageId: string) => void;
        onChangePageSource: (pageId: string) => void;
        hasClipboard: () => boolean;
        onToggleOcrDebug: (pageId: string) => void;
    }): void {
        this.pageActionHandlers = {
            onDeletePages: handlers.onDeletePages,
            onCopyPages: handlers.onCopyPages,
            onRotatePages: handlers.onRotatePages,
            hasClipboard: handlers.hasClipboard,
            onToggleOcrDebug: handlers.onToggleOcrDebug,
        };

        this.pasteBeforeHandler = handlers.onPasteBefore;
        this.pasteAfterHandler = handlers.onPasteAfter;
        this.insertPageBeforeHandler = handlers.onInsertPageBefore;
        this.insertPageAfterHandler = handlers.onInsertPageAfter;
        this.showTextHandler = handlers.onShowText;
        this.runOcrHandler = handlers.onRunOcr;
        this.changePageSourceHandler = handlers.onChangePageSource;
    }

    // ========== SEITENLEISTE LEEREN ==========
    public clearSidebarPages(): void {
        this.sidebarListEl.empty();
        this.pageOrder = [];
        this.selectedPageIds.clear();
        this.lastSelectedPageId = null;
    }

    public clearSidebar(): void {
        this.sidebarListEl.empty();
        this.sourcesListEl.empty();
        this.searchResultsEl.empty();
        this.searchResultsEl.setCssStyles({ display: "none" });
        this.searchInputEl.value = "";
    }

    // ========== SUCHERGEBNISSE ANZEIGEN ==========
    private static readonly SEARCH_CATEGORY_LABELS: Record<SearchResultCategory, string> = {
        pdf: "PDF text",
        ocr: "Handwriting (OCR)",
        textblock: "Text blocks",
        annotation: "Annotations",
    };

    public showSearchResults(results: SearchResultItem[], query: string): void {
        this.searchResultsEl.empty();
        if (results.length === 0) {
            this.searchResultsEl.createDiv({ text: "No matches found." });
            this.searchResultsEl.setCssStyles({ display: "block" });
            return;
        }
        this.searchResultsEl.setCssStyles({ display: "block" });

        let currentCategory: SearchResultCategory | null = null;
        let currentOcrDistance: number | null = null;

        for (const res of results) {
            if (res.category !== currentCategory) {
                currentCategory = res.category;
                currentOcrDistance = null;
                const header = this.searchResultsEl.createDiv({ cls: "pdfcompose-search-group-header" });
                header.setText(PdfComposeUI.SEARCH_CATEGORY_LABELS[res.category]);
            }

            if (res.category === "ocr" && res.distance !== currentOcrDistance) {
                currentOcrDistance = res.distance;
                const subHeader = this.searchResultsEl.createDiv({ cls: "pdfcompose-search-subgroup-header" });
                subHeader.setText(res.distance === 0 ? "Exact matches" : `Distance: ${res.distance}`);
            }

            const item = this.searchResultsEl.createDiv({ cls: "pdfcompose-search-result" });
            item.createSpan({ text: `Page ${res.pageIndex + 1}: `, cls: "pdfcompose-search-result-page" });
            const snippetEl = item.createSpan({ cls: "pdfcompose-search-result-snippet" });
            snippetEl.createSpan({ text: res.snippet.before });
            snippetEl.createSpan({ text: res.snippet.match, cls: "pdfcompose-search-result-hit" });
            snippetEl.createSpan({ text: res.snippet.after });
            item.addEventListener("click", () => {
                this.view.jumpToSearchResult(res.pageId);
            });

            if (res.matches.length > 0) {
                const preview = item.createEl("canvas", { cls: "pdfcompose-search-preview" });
                // CSS-Anzeigegröße fix, Bitmap doppelt so groß → scharfe Darstellung
                // auf Retina-Displays. Die tatsächliche Skalierung des Inhalts erfolgt
                // in view.renderSearchPreview().
                const cssW = 200;
                const cssH = 120;
                preview.setCssStyles({ width: cssW + "px", height: cssH + "px" });
                preview.width = cssW * 2;
                preview.height = cssH * 2;

                const io = new IntersectionObserver((entries) => {
                    for (const e of entries) {
                        if (e.isIntersecting) {
                            io.disconnect();
                            void this.view.renderSearchPreview(res.pageId, res.matches[0], preview);
                        }
                    }
                });
                io.observe(preview);
            }
        }
    }

    /**
 * Setzt/entfernt die Such-Highlight-Klasse auf Textblock-Elementen.
 * @param pageId   – Seite, auf der die Blöcke liegen
 * @param ids      – Set von Block-IDs, die markiert werden sollen (leeres Set = alle Markierungen entfernen)
 */
    public highlightTextBlocks(pageId: string, ids: Set<string>): void {
        const layer = this.textBlockLayers.get(pageId);
        if (!layer) return;
        layer.querySelectorAll<HTMLElement>('.pdfcompose-textblock').forEach(el => {
            const id = el.getAttribute('data-textblock-id');
            if (id && ids.has(id)) {
                el.addClass('pdfcompose-search-highlight');
            } else {
                el.removeClass('pdfcompose-search-highlight');
            }
        });
    }

    /**
     * Setzt/entfernt die Such-Highlight-Klasse auf Anmerkungsboxen.
     * @param pageId   – Seite, auf der die Anmerkungen liegen
     * @param ids      – Set von Anmerkungs-IDs, die markiert werden sollen (leeres Set = alle Markierungen entfernen)
     */
    public highlightAnnotations(pageId: string, ids: Set<string>): void {
        const column = this.annotationColumns.get(pageId);
        if (!column) return;
        column.querySelectorAll<HTMLElement>('.pdfcompose-pdfannot').forEach(el => {
            const id = el.getAttribute('data-pdfannot-id');
            if (id && ids.has(id)) {
                el.addClass('pdfcompose-search-highlight');
            } else {
                el.removeClass('pdfcompose-search-highlight');
            }
        });
    }

    public clearSearchResults(): void {
        this.searchResultsEl.empty();
        this.searchResultsEl.setCssStyles({ display: "none" });
    }

    // ========== SIDEBAR-HIGHLIGHTS (für Suche) ==========
    public updateSidebarHighlights(foundPageIds: Set<string>): void {
        if (!this.sidebarListEl) return;
        const items = this.sidebarListEl.querySelectorAll(".pdfcompose-sidebar-item");
        items.forEach(item => {
            const id = item.getAttribute("data-page-id");
            if (id && foundPageIds.has(id)) {
                item.addClass("pdfcompose-sidebar-highlight");
            } else {
                item.removeClass("pdfcompose-sidebar-highlight");
            }
        });
    }

    /** Markiert das Sidebar-Element der aktuell im Hauptbereich sichtbaren Seite (unabhängig von Such-Highlights). */
    public setCurrentPageHighlight(pageId: string | null): void {
        if (!this.sidebarListEl) return;
        // Während einer programmatischen Navigation (Klick, Suchtreffer) nicht mitwandern
        if (this.navLockPageId !== null) {
            this.extendNavLock(250);
            return;
        }
        this.applyCurrentPageHighlight(pageId);
    }

    private applyCurrentPageHighlight(pageId: string | null): void {
        if (pageId === this.currentHighlightedPageId) return;
        if (this.currentHighlightedPageId) {
            this.sidebarListEl
                .querySelector(`[data-page-id="${this.currentHighlightedPageId}"]`)
                ?.removeClass("pdfcompose-sidebar-current");
        }
        this.currentHighlightedPageId = pageId;
        if (!pageId) return;
        const el = this.sidebarListEl.querySelector<HTMLElement>(`[data-page-id="${pageId}"]`);
        if (!el) return;
        el.addClass("pdfcompose-sidebar-current");
        this.scrollSidebarItemIntoView(el);
    }

    private lockCurrentPageHighlight(pageId: string): void {
        this.navLockPageId = pageId;
        this.extendNavLock(700);
        this.applyCurrentPageHighlight(pageId);
    }

    private extendNavLock(ms: number): void {
        if (this.navLockTimer !== null) window.clearTimeout(this.navLockTimer);
        this.navLockTimer = window.setTimeout(() => {
            this.navLockTimer = null;
            this.navLockPageId = null;
        }, ms);
    }

    private scrollSidebarItemIntoView(el: HTMLElement): void {
        if (this.currentTab !== "pages" || this.isSidebarCollapsed || this.pointerDragActive) return;
        const scrollEl = this.sidebarContentEl;
        if (!scrollEl) return;
        const c = scrollEl.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (c.height === 0 || (r.top >= c.top && r.bottom <= c.bottom)) return;
        scrollEl.scrollTo({
            top: scrollEl.scrollTop + (r.top - c.top) - (c.height - r.height) / 2,
            behavior: "smooth",
        });
    }

    // ========== ANNOTATIONS-WERKZEUGLEISTE ==========
    public buildAnnotationToolbar(onToolSelect: (tool: AnnotationTool) => void): void {
        this.annotationToolbarEl.empty();
        this.toolButtons.clear();
        this.groupButtons.clear();
        this.groupDropdowns.clear();
        this.groupStates.clear();
        this.onToolSelect = onToolSelect;

        const renderSingleTool = (tool: AnnotationTool): void => {
            const meta = TOOL_METADATA[tool] || { label: tool, icon: 'help-circle' };
            const btn = this.annotationToolbarEl.createEl("button", { cls: "pdfcompose-tool-btn" });
            if (tool === "text") {
                setIcon(btn, "text-cursor");
            } else {
                setIcon(btn, meta.icon);
            }
            btn.setAttribute("data-tool", tool);
            btn.setAttribute("title", meta.label);
            btn.addEventListener("click", () => {
                // Erneuter Klick auf das bereits aktive Werkzeug: kein Sprung zum Zeiger.
                if (tool === this.currentActiveTool) return;
                if (this.onToolSelect) this.onToolSelect(tool);
            });
            this.toolButtons.set(tool, btn);
        };

        const renderGroup = (group: { id: string; tools: AnnotationTool[]; default: AnnotationTool }): void => {
            const container = this.annotationToolbarEl.createDiv({ cls: "pdfcompose-tool-group" });

            const defaultTool = group.default;
            const metaDefault = TOOL_METADATA[defaultTool] || { label: defaultTool, icon: 'help-circle' };
            const mainBtn = container.createEl("button", { cls: "pdfcompose-tool-btn" });
            setIcon(mainBtn, metaDefault.icon);
            mainBtn.setAttribute("data-group", group.id);
            mainBtn.setAttribute("title", metaDefault.label);
            mainBtn.addEventListener("click", () => this.toggleGroup(group.id));
            this.groupButtons.set(group.id, mainBtn);

            const dropdown = container.createDiv({ cls: "pdfcompose-dropdown" });
            dropdown.setCssStyles({ display: "none", left: "50%", transform: "translateX(-50%)" });
            for (const tool of group.tools) {
                const meta = TOOL_METADATA[tool] || { label: tool, icon: 'help-circle' };
                const btn = dropdown.createEl("button", { cls: "pdfcompose-tool-btn" });
                setIcon(btn, meta.icon);
                btn.setAttribute("data-tool", tool);
                btn.setAttribute("title", meta.label);
                if (group.id === "pen") {
                    const preset = DEFAULT_PEN_PRESETS.find(p => p.id === tool);
                    if (preset) btn.setCssStyles({ color: splitHexAlpha(preset.color).rgb });
                }
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    // Erneuter Klick auf das bereits aktive Werkzeug: kein Sprung zum Zeiger.
                    if (tool === this.currentActiveTool) return;
                    this.selectGroupTool(group.id, tool);
                });
            }
            this.groupDropdowns.set(group.id, dropdown);

            this.groupStates.set(group.id, {
                currentTool: defaultTool,
                isOpen: false,
            });
            this.updateGroupButton(group.id);
        };

        // Feste, gewünschte Reihenfolge in der Toolbar:
        // Zeiger, Stift, Form, Auswahl, Radiergummi, Text
        renderSingleTool("none");
        renderGroup(this.groups.find(g => g.id === "pen")!);
        renderGroup(this.groups.find(g => g.id === "shape")!);
        renderGroup(this.groups.find(g => g.id === "selection")!);
        renderSingleTool("eraser");
        renderSingleTool("text");
    }

    private updateGroupButton(groupId: string): void {
        const state = this.groupStates.get(groupId);
        if (!state) return;
        const tool = state.currentTool;
        const btn = this.groupButtons.get(groupId);
        if (btn) {
            const meta = TOOL_METADATA[tool] || { label: tool, icon: 'help-circle' };
            setIcon(btn, meta.icon);
            btn.setAttribute("title", meta.label);
            if (groupId === "pen") {
                const preset = DEFAULT_PEN_PRESETS.find(p => p.id === tool);
                btn.setCssStyles({ color: preset ? splitHexAlpha(preset.color).rgb : "" });
            } else {
                btn.setCssStyles({ color: "" });
            }
        }
    }

    public updatePenToolColor(tool: AnnotationTool, color: string): void {
        const btn = this.singleTools.includes(tool)
            ? undefined
            : undefined; // Stifte sind immer Teil der 'pen'-Gruppe, kein Einzel-Button

        for (const [groupId, dropdown] of this.groupDropdowns.entries()) {
            const toolBtn = dropdown.querySelector<HTMLElement>(`[data-tool="${tool}"]`);
            if (toolBtn) toolBtn.setCssStyles({ color: splitHexAlpha(color).rgb });

            const state = this.groupStates.get(groupId);
            if (state?.currentTool === tool) {
                this.updateGroupButton(groupId);
            }
        }
    }

    public toggleGroup(groupId: string): void {
        const state = this.groupStates.get(groupId);
        if (!state) return;
        const currentlyOpen = state.isOpen;
        this.closeAllDropdowns();
        if (!currentlyOpen) {
            state.isOpen = true;
            const dropdown = this.groupDropdowns.get(groupId);
            if (dropdown) {
                dropdown.setCssStyles({ display: "block" });
            }
            const tool = state.currentTool;
            if (this.onToolSelect) this.onToolSelect(tool);
        }
    }

    public selectGroupTool(groupId: string, tool: AnnotationTool): void {
        const state = this.groupStates.get(groupId);
        if (!state) return;
        state.currentTool = tool;
        this.updateGroupButton(groupId);
        if (this.onToolSelect) this.onToolSelect(tool);
        // Dropdown bleibt offen
    }

    public closeAllDropdowns(): void {
        for (const [groupId, state] of this.groupStates) {
            state.isOpen = false;
            const dropdown = this.groupDropdowns.get(groupId);
            if (dropdown) dropdown.setCssStyles({ display: "none" });
        }
    }

    public setActiveTool(tool: AnnotationTool): void {
        this.currentActiveTool = tool;

        // Einzel‑Buttons
        for (const [t, btn] of this.toolButtons.entries()) {
            btn.toggleClass("pdfcompose-tool-btn-active", t === tool);
        }

        // Gruppen‑Buttons und Container-Hervorhebung
        for (const [groupId, state] of this.groupStates) {
            const btn = this.groupButtons.get(groupId);
            if (btn) {
                btn.toggleClass("pdfcompose-tool-btn-active", state.currentTool === tool);
            }
            const container = btn?.parentElement;
            if (container) {
                const group = this.groups.find(g => g.id === groupId);
                if (group) {
                    const isActive = group.tools.includes(tool) || state.currentTool === tool;
                    container.toggleClass("pdfcompose-group-active", isActive);
                }
            }
        }

        // Wenn ein Einzel‑Werkzeug gewählt wird, schließe alle Dropdowns
        if ((this.singleTools as string[]).includes(tool)) {
            this.closeAllDropdowns();
        }
    }

    public updateAnnotationLayerInteractivity(currentTool: AnnotationTool): void {
        const drawable = currentTool !== "none";
        const isSelectionTool = currentTool === "select-rect" || currentTool === "select-lasso";

        for (const svg of this.annotationLayers.values()) {
            svg.setCssStyles({ pointerEvents: drawable ? "auto" : "none" });
            if (isSelectionTool) svg.setCssStyles({ cursor: "default" });
            else if (currentTool === "eraser") svg.setCssStyles({ cursor: "cell" });
            else if (drawable) svg.setCssStyles({ cursor: "crosshair" });
            else svg.setCssStyles({ cursor: "default" });

            const selectionHandles = svg.querySelector(".pdfcompose-selection-handles") as SVGGElement | null;
            if (selectionHandles) {
                selectionHandles.setCssStyles({ pointerEvents: "none" });
                // WICHTIG: auch .pdfcompose-point-handle explizit einschalten.
                selectionHandles
                    .querySelectorAll<SVGElement>(
                        ".pdfcompose-scale-handle, .pdfcompose-rotate-handle, .pdfcompose-point-handle"
                    )
                    .forEach(handle => {
                        handle.setCssStyles({ pointerEvents: "all" });
                    });
            }
        }
    }

    public updateUndoRedoButtons(canUndo: boolean, canRedo: boolean): void {
        if (this.undoBtn) {
            this.undoBtn.toggleClass("pdfcompose-tool-btn-disabled", !canUndo);
            (this.undoBtn as HTMLButtonElement).disabled = !canUndo;
        }
        if (this.redoBtn) {
            this.redoBtn.toggleClass("pdfcompose-tool-btn-disabled", !canRedo);
            (this.redoBtn as HTMLButtonElement).disabled = !canRedo;
        }
    }

    // ========== ZOOM-STEUERUNG ==========
    public buildZoomControl(handlers: {
        onZoomIn: () => void;
        onZoomOut: () => void;
        onZoomReset: () => void;
    }): void {
        this.zoomControlEl = this.bottomRightStackEl.createDiv({
            cls: "pdfcompose-zoom-control",
        });

        const zoomOutBtn = this.zoomControlEl.createEl("button", {
            cls: "pdfcompose-tool-btn",
            text: "−",
        });

        zoomOutBtn.setAttribute(
            "title",
            "Verkleinern (Strg/Cmd + -)"
        );

        zoomOutBtn.addEventListener(
            "click",
            () => handlers.onZoomOut()
        );

        this.zoomLabelEl = this.zoomControlEl.createEl("span", {
            cls: "pdfcompose-zoom-label",
            text: "100%",
        });

        this.zoomLabelEl.setAttribute(
            "title",
            "Zoom zurücksetzen (Strg/Cmd + 0)"
        );

        this.zoomLabelEl.addEventListener(
            "click",
            () => handlers.onZoomReset()
        );

        const zoomInBtn = this.zoomControlEl.createEl("button", {
            cls: "pdfcompose-tool-btn",
            text: "+",
        });

        zoomInBtn.setAttribute(
            "title",
            "Vergrößern (Strg/Cmd + +)"
        );

        zoomInBtn.addEventListener(
            "click",
            () => handlers.onZoomIn()
        );
    }

    public updateZoomDisplay(zoomLevel: number): void {
        if (this.zoomLabelEl) {
            this.zoomLabelEl.setText(`${Math.round(zoomLevel * 100)}%`);
        }
    }

    public updatePasteButton(visible: boolean): void {
        if (!this.pasteBtnEl) return;

        this.pasteBtnEl.setCssStyles({ display: visible ? "" : "none" });
    }

    public buildActionPanel(handlers: {
        onCopy: () => void;
        onCut: () => void;
        onDelete: () => void;
        onPaste: () => void;
    }): void {
        const panel = this.bottomRightStackEl.createDiv({ cls: "pdfcompose-action-panel" });
        this.actionPanelEl = panel;

        this.copyBtn = panel.createEl("button", { cls: "pdfcompose-tool-btn", text: "Copy" });
        this.copyBtn.addEventListener("click", handlers.onCopy);
        this.copyBtn.setCssStyles({ display: "none" });

        this.cutBtn = panel.createEl("button", { cls: "pdfcompose-tool-btn", text: "Cut" });
        this.cutBtn.addEventListener("click", handlers.onCut);
        this.cutBtn.setCssStyles({ display: "none" });

        this.deleteBtn = panel.createEl("button", { cls: "pdfcompose-tool-btn", text: "Delete" });
        this.deleteBtn.addEventListener("click", handlers.onDelete);
        this.deleteBtn.setCssStyles({ display: "none" });

        this.pasteBtn = panel.createEl("button", { cls: "pdfcompose-tool-btn", text: "Paste" });
        this.pasteBtn.addEventListener("click", handlers.onPaste);
        this.pasteBtn.setCssStyles({ display: "none" });
    }

    public buildMoreOptionsMenu(): HTMLElement {
        const wrapper = this.bottomRightStackEl.createDiv({ cls: "pdfcompose-more-options-wrapper" });
        wrapper.setCssStyles({ position: "relative", display: "flex", justifyContent: "flex-end", alignSelf: "flex-end" });

        this.moreOptionsBtn = wrapper.createEl("button", { cls: "pdfcompose-tool-btn pdfcompose-more-options-btn", text: "⋮" });
        this.moreOptionsBtn.setAttribute("title", "More options (save, color mode, scroll direction, …)");
        this.moreOptionsBtn.setAttribute("aria-label", "More options");
        const btnHeight = Platform.isMobile ? 48 : 40;
        this.moreOptionsBtn.setCssStyles({
            minWidth: `${Math.round(btnHeight * 1.5)}px`,
            height: `${btnHeight}px`,
            padding: "0 16px",
            fontSize: "22px",
            lineHeight: "1",
        });
        this.moreOptionsBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.toggleMoreOptions();
        });

        this.moreOptionsPanel = wrapper.createDiv({ cls: "pdfcompose-more-options-panel" });
        this.moreOptionsPanel.setCssStyles({ display: "none", flexDirection: "column", gap: "6px", position: "absolute", bottom: "100%", right: "0", marginBottom: "6px", padding: "8px", background: "var(--background-primary)", border: "1px solid var(--background-modifier-border)", borderRadius: "6px", boxShadow: "var(--shadow-s)", whiteSpace: "nowrap", zIndex: "50" });
        // Klicks INNERHALB des Panels dürfen es nicht sofort wieder schließen.
        this.moreOptionsPanel.addEventListener("click", (e) => e.stopPropagation());

        document.addEventListener("click", () => {
            if (this.moreOptionsOpen) this.closeMoreOptions();
        });

        return this.moreOptionsPanel;
    }

    public toggleMoreOptions(forceOpen?: boolean): void {
        this.moreOptionsOpen = forceOpen ?? !this.moreOptionsOpen;
        this.moreOptionsPanel.setCssStyles({ display: this.moreOptionsOpen ? "flex" : "none" });
    }

    public closeMoreOptions(): void {
        if (!this.moreOptionsOpen) return;
        this.moreOptionsOpen = false;
        this.moreOptionsPanel.setCssStyles({ display: "none" });
    }

    public buildSaveButton(container: HTMLElement, onSave: () => void): void {
        const row = container.createDiv({ cls: "pdfcompose-colormode-control" });
        const btn = row.createEl("button", { cls: "pdfcompose-tool-btn" });
        setIcon(btn, "save");
        btn.createSpan({ text: "Save" });
        btn.setAttribute("title", "Write pending changes immediately (e.g. a just-adjusted style change that would otherwise be saved with a slight delay).");
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            onSave();
        });
    }

    public buildInvertButton(container: HTMLElement, onInvert: () => void): void {
        const row = container.createDiv({ cls: "pdfcompose-colormode-control" });
        const btn = row.createEl("button", { cls: "pdfcompose-tool-btn" });
        setIcon(btn, "contrast");
        btn.createSpan({ text: "Invert brightness" });
        btn.setAttribute(
            "title",
            "Inverts the brightness of the selected objects, or of the currently visible page if nothing is selected."
        );
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.closeMoreOptions();
            onInvert();
        });
        this.invertBtn = btn;
    }

    public buildColorModeControl(
        container: HTMLElement,
        handler: (mode: ColorMode) => void,
        onSavePdfTextChange?: (value: boolean) => void,
    ): void {
        const row = container.createDiv({ cls: "pdfcompose-colormode-control" });
        row.createEl("label", { text: "Color mode:" });
        const select = row.createEl("select");
        for (const [value, label] of [
            ["original", "Original"], ["light", "Light"], ["dark", "Dark"],
        ] as const) {
            select.createEl("option", { text: label, value });
        }
        select.addEventListener("change", () => {
            handler(select.value as ColorMode);
        });
        this.colorModeSelectEl = select;

        if (onSavePdfTextChange) {
            const saveRow = container.createDiv({ cls: "pdfcompose-colormode-control" });
            const label = saveRow.createEl("label", { text: "Save PDF text:" });
            label.setAttribute(
                "title",
                "Saves the text extracted from the PDF under the respective " +
                "page heading as a collapsed callout – for searchability " +
                "within the Markdown body.",
            );
            const cb = saveRow.createEl("input", { type: "checkbox" }) as HTMLInputElement;
            cb.addEventListener("change", () => onSavePdfTextChange(cb.checked));
            this.savePdfTextCheckbox = cb;
        }
    }

    public setSavePdfTextValue(value: boolean): void {
        if (this.savePdfTextCheckbox) this.savePdfTextCheckbox.checked = value;
    }

    private stylusOnlyCheckbox: HTMLInputElement | null = null;

    /**
     * Schnellzugriff-Checkbox direkt in der View (statt nur in den
     * Plugin-Einstellungen), um festzulegen, ob Finger-Berührungen auf der
     * Zeichenfläche als Werkzeug (Zeichnen/Radieren/Auswählen) oder als
     * Scrollen/Zoomen interpretiert werden. Spiegelt/ändert dieselbe
     * Einstellung wie "Nur Stift zeichnet" in den Plugin-Einstellungen.
     */
    public buildStylusOnlyToggle(container: HTMLElement, initialValue: boolean, onChange: (value: boolean) => void): void {
        const row = container.createDiv({ cls: "pdfcompose-colormode-control" });
        const label = row.createEl("label", { cls: "pdfcompose-stylus-toggle-label" });
        setIcon(label, "pen-tool");
        label.createSpan({ text: "Stylus only" });
        label.setAttribute(
            "title",
            "When enabled, finger touches on the drawing surface only scroll/" +
            "zoom - drawing, erasing, or selecting then only happens with a " +
            "stylus or mouse. Corresponds to the \"Only stylus draws\" setting."
        );
        const checkbox = row.createEl("input", { type: "checkbox" }) as HTMLInputElement;
        checkbox.checked = initialValue;
        checkbox.addEventListener("change", () => onChange(checkbox.checked));
        this.stylusOnlyCheckbox = checkbox;
    }

    public setStylusOnlyValue(value: boolean): void {
        if (this.stylusOnlyCheckbox) this.stylusOnlyCheckbox.checked = value;
    }

    public setColorModeValue(mode: ColorMode): void {
        if (this.colorModeSelectEl) this.colorModeSelectEl.value = mode;
    }

    public updateActionButtons(hasSelection: boolean, canPaste: boolean): void {
        if (this.copyBtn) this.copyBtn.setCssStyles({ display: hasSelection ? "" : "none" });
        if (this.cutBtn) this.cutBtn.setCssStyles({ display: hasSelection ? "" : "none" });
        if (this.deleteBtn) this.deleteBtn.setCssStyles({ display: hasSelection ? "" : "none" });
        if (this.pasteBtn) this.pasteBtn.setCssStyles({ display: canPaste ? "" : "none" });
    }

    // ========== EIGENSCHAFTEN-PANEL ==========
    /**
 * Erstellt ein Label mit Icon + Text für das Eigenschaften-Panel. Der
 * Text bleibt (als Tooltip/für Screenreader) erhalten, wird auf Mobile
 * aber per CSS ausgeblendet, damit das schmale Panel auf Tablets nicht
 * durch lange Beschriftungen überläuft.
 */
    private createIconLabel(container: HTMLElement, text: string, icon: string): HTMLElement {
        const label = container.createEl("label", { cls: "pdfcompose-panel-label" });
        setIcon(label, icon);
        label.createSpan({ text, cls: "pdfcompose-panel-label-text" });
        label.setAttribute("title", text);
        return label;
    }

    /** Wie createIconLabel(), aber als reiner Beschriftungs-Span neben einer Checkbox. */
    private createIconCaption(container: HTMLElement, text: string, icon: string): HTMLElement {
        const span = container.createSpan({ cls: "pdfcompose-panel-caption" });
        setIcon(span, icon);
        span.createSpan({ text, cls: "pdfcompose-panel-label-text" });
        span.setAttribute("title", text);
        return span;
    }

    public renderAnnotationPanel(
        currentTool: AnnotationTool,
        style: {
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
        },
        hasSelection: boolean,
        selectedTypes: Set<VectorObject["type"]>,
        selectionPageId: string | null,
        hasFreehandSelection: boolean,
        handlers: {
            onStyleChange: (patch: any) => void;
            onSelectionModeChange: (mode: SelectionMode) => void;
            onEraserTargetsChange: (patch: Partial<FilterTargets>) => void;
            onSelectionTargetsChange: (patch: Partial<FilterTargets>) => void;
        }
    ): void {
        const panel = this.annotationPanelEl;

        const isPen = isPenTool(currentTool);
        const isSelectTool = currentTool === "select-rect" || currentTool === "select-lasso";
        const isEraser = currentTool === "eraser";
        const showShapeCreationTool = ["line", "arrow", "polygon", "rectangle", "diamond", "triangle-equilateral", "triangle-right", "ellipse"].includes(currentTool);
        const hasVectorSelection = hasSelection && selectedTypes.size > 0;
        const showPanel = isEraser || isPen || showShapeCreationTool || hasVectorSelection || isSelectTool;
        const showStyleControls = isPen || showShapeCreationTool || hasVectorSelection;

        // Auf Methoden-Ebene deklariert (nicht nur innerhalb des
        // showStyleControls-Blocks), damit sie auch für den weiter unten
        // stehenden "Textmarker-Form"-Block verfügbar sind.
        const selectionHasLineLike = selectedTypes.has("line") || selectedTypes.has("arrow") || selectedTypes.has("polygon");
        const selectionHasFillable = selectedTypes.has("polygon") || selectedTypes.has("rectangle") || selectedTypes.has("triangle") || selectedTypes.has("ellipse") || selectedTypes.has("diamond");
        const selectionHasArrow = selectedTypes.has("arrow");

        // Struktur-Key – entscheidet, ob Panel neu aufgebaut werden muss
        const typeKey = Array.from(selectedTypes).sort().join(",");
        const structureKey = `${currentTool}|${hasSelection}|${typeKey}|${hasFreehandSelection}|${showPanel}|${showStyleControls}`;

        if (structureKey === this.currentStructureKey && panel.children.length > 0) {
            this.updatePanelValues(style);
            return;
        }

        panel.empty();
        this.panelControls = {};
        panel.dataset.structureKey = structureKey;
        this.currentStructureKey = structureKey;

        if (!showPanel) {
            return;
        }

        // ---- Radiergummi: eigenes Panel ----
        if (isEraser) {
            const row = panel.createDiv({ cls: "pdfcompose-panel-row" });
            this.createIconLabel(row, "Erases:", "eraser");

            this.createIconCaption(row, "Strokes", "pencil");
            const strokesToggle = row.createEl("input", { type: "checkbox" });
            strokesToggle.checked = style.eraserTargets.strokes;
            strokesToggle.addEventListener("change", () =>
                handlers.onEraserTargetsChange({ strokes: strokesToggle.checked })
            );
            this.panelControls.eraserStrokesToggle = strokesToggle;

            this.createIconCaption(row, "Highlighter", "highlighter");
            const highlightersToggle = row.createEl("input", { type: "checkbox" });
            highlightersToggle.checked = style.eraserTargets.highlighters;
            highlightersToggle.setAttribute("title", "Delete highlighter strokes.");
            highlightersToggle.addEventListener("change", () =>
                handlers.onEraserTargetsChange({ highlighters: highlightersToggle.checked })
            );
            this.panelControls.eraserHighlightersToggle = highlightersToggle;

            this.createIconCaption(row, "Shapes", "shapes");
            const shapesToggle = row.createEl("input", { type: "checkbox" });
            shapesToggle.checked = style.eraserTargets.shapes;
            shapesToggle.addEventListener("change", () =>
                handlers.onEraserTargetsChange({ shapes: shapesToggle.checked })
            );
            this.panelControls.eraserShapesToggle = shapesToggle;

            this.createIconCaption(row, "Annotations", "message-square");
            const annotationsToggle = row.createEl("input", { type: "checkbox" });
            annotationsToggle.checked = style.eraserTargets.annotations;
            annotationsToggle.setAttribute("title", "Delete the entire annotation (highlight + textbox) on hit.");
            annotationsToggle.addEventListener("change", () =>
                handlers.onEraserTargetsChange({ annotations: annotationsToggle.checked })
            );
            this.panelControls.eraserAnnotationsToggle = annotationsToggle;

            this.createIconCaption(row, "Textblocks", "text");
            const textBlocksToggle = row.createEl("input", { type: "checkbox" });
            textBlocksToggle.checked = style.eraserTargets.textBlocks;
            textBlocksToggle.setAttribute("title", "Delete text blocks on hover.");
            textBlocksToggle.addEventListener("change", () =>
                handlers.onEraserTargetsChange({ textBlocks: textBlocksToggle.checked })
            );
            this.panelControls.eraserTextBlocksToggle = textBlocksToggle;

            return;
        }

        // ---- Stil-Controls (Farbe, Füllung, Kurven, Pfeilspitze, Druck, Textmarker) ----
        if (showStyleControls) {
            const strokeRow = panel.createDiv({ cls: "pdfcompose-panel-row" });
            this.createIconLabel(strokeRow, "Color", "palette");
            const strokeSplit = splitHexAlpha(style.strokeColor);
            const strokeColorInput = strokeRow.createEl("input", { type: "color" });
            strokeColorInput.value = strokeSplit.rgb;
            this.panelControls.strokeColorInput = strokeColorInput;

            const strokeAlphaInput = strokeRow.createEl("input", { type: "range", cls: "pdfcompose-alpha-slider", attr: { min: "0", max: "1", step: "0.05" } });
            strokeAlphaInput.value = strokeSplit.alpha.toString();
            strokeAlphaInput.setAttribute("title", "Opacity of the stroke color");
            this.panelControls.strokeAlphaInput = strokeAlphaInput;

            const applyStrokeColor = () => {
                const combined = combineHexAlpha(strokeColorInput.value, parseFloat(strokeAlphaInput.value));
                handlers.onStyleChange({ strokeColor: combined });
            };
            strokeColorInput.addEventListener("input", applyStrokeColor);
            strokeAlphaInput.addEventListener("input", applyStrokeColor);

            this.createIconLabel(strokeRow, "Width", "ruler");
            const widthInput = strokeRow.createEl("input", { type: "range", attr: { min: "0.5", max: "20", step: "0.5" } });
            widthInput.value = style.strokeWidth.toString();
            this.panelControls.strokeWidthInput = widthInput;

            const widthReadout = strokeRow.createEl("span", { text: style.strokeWidth.toString(), cls: "pdfcompose-width-readout" });
            this.panelControls.widthReadout = widthReadout;

            widthInput.addEventListener("input", () => {
                const val = parseFloat(widthInput.value) || style.strokeWidth;
                widthReadout.setText(val.toString());
                handlers.onStyleChange({ strokeWidth: val });
            });

            // ---- Füllung ----
            const showFill = (showShapeCreationTool && currentTool !== "line" && currentTool !== "arrow") || selectionHasFillable;
            if (showFill) {
                const fillRow = panel.createDiv({ cls: "pdfcompose-panel-row" });
                this.createIconLabel(fillRow, "Fill", "paint-bucket");
                const fillToggle = fillRow.createEl("input", { type: "checkbox" });
                fillToggle.checked = style.fillEnabled;
                this.panelControls.fillToggle = fillToggle;

                const fillSplit = splitHexAlpha(style.fillColor);
                const fillColorInput = fillRow.createEl("input", { type: "color" });
                fillColorInput.value = fillSplit.rgb;
                this.panelControls.fillColorInput = fillColorInput;

                const fillAlphaInput = fillRow.createEl("input", { type: "range", cls: "pdfcompose-alpha-slider", attr: { min: "0", max: "1", step: "0.05" } });
                fillAlphaInput.value = fillSplit.alpha.toString();
                fillAlphaInput.setAttribute("title", "Opacity of the fill");
                this.panelControls.fillAlphaInput = fillAlphaInput;

                const applyFillColor = () => {
                    if (!fillToggle.checked) return;
                    const combined = combineHexAlpha(fillColorInput.value, parseFloat(fillAlphaInput.value));
                    handlers.onStyleChange({ fillColor: combined });
                };

                fillToggle.addEventListener("change", () => {
                    const enabled = fillToggle.checked;
                    const value = enabled ? combineHexAlpha(fillColorInput.value, parseFloat(fillAlphaInput.value)) : undefined;
                    handlers.onStyleChange({ fillColor: value });
                });
                fillColorInput.addEventListener("input", applyFillColor);
                fillAlphaInput.addEventListener("input", applyFillColor);
            }

            // ---- Kurven/Stufen ----
            const showSegmentKind = ["line", "arrow", "polygon"].includes(currentTool) || selectionHasLineLike;
            if (showSegmentKind) {
                const segRow = panel.createDiv({ cls: "pdfcompose-panel-row" });
                this.createIconLabel(segRow, "Connection", "spline");
                const segSelect = segRow.createEl("select");
                for (const [value, label] of [["straight", "Direct"], ["curve", "Curve"], ["step", "Step"]] as const) {
                    const opt = segSelect.createEl("option", { text: label, value });
                    if (value === style.segmentKind) opt.selected = true;
                }
                this.panelControls.segmentSelect = segSelect;
                segSelect.addEventListener("change", () => {
                    handlers.onStyleChange({ segmentKind: segSelect.value as LineSegmentKind });
                });
            }

            // ---- Pfeilspitzen ----
            if (currentTool === "arrow" || selectionHasArrow) {
                const arrowRow = panel.createDiv({ cls: "pdfcompose-panel-row" });
                this.createIconLabel(arrowRow, "Arrowhead:", "arrow-up-right");
                const arrowSelect = arrowRow.createEl("select");
                for (const [value, label] of [["end", "End"], ["start", "Start"], ["both", "Both"]] as const) {
                    const opt = arrowSelect.createEl("option", { text: label, value });
                    if (value === style.arrowSide) opt.selected = true;
                }
                this.panelControls.arrowSelect = arrowSelect;
                arrowSelect.addEventListener("change", () => {
                    const side = arrowSelect.value as ArrowSide;
                    handlers.onStyleChange({
                        arrowStart: side === "start" || side === "both",
                        arrowEnd: side === "end" || side === "both",
                    });
                });

                // NEU: Größe
                const sizeRow = panel.createDiv({ cls: "pdfcompose-panel-row" });
                this.createIconLabel(sizeRow, "Size:", "scaling");
                const sizeInput = sizeRow.createEl("input", { type: "range", attr: { min: "3", max: "40", step: "1" } });
                sizeInput.value = String(style.arrowSize ?? 0);
                const sizeReadout = sizeRow.createEl("span", {
                    cls: "pdfcompose-width-readout",
                    text: style.arrowSize != null ? style.arrowSize.toFixed(0) : "auto",
                });
                this.panelControls.arrowSizeInput = sizeInput;
                sizeInput.addEventListener("input", () => {
                    const v = parseInt(sizeInput.value, 10);
                    sizeReadout.setText(String(v));
                    handlers.onStyleChange({ arrowSize: v });
                });
            }

            // ---- Stift: Drucksensitivität & Textmarker ----
            const showPressureControls = (isPen && !hasFreehandSelection) || hasFreehandSelection;
            if (showPressureControls) {
                const pressureRow = panel.createDiv({ cls: "pdfcompose-panel-row" });
                this.createIconLabel(pressureRow, "Pressure Sensitivity", "gauge");
                const pressureToggle = pressureRow.createEl("input", { type: "checkbox" });
                pressureToggle.checked = style.pressure.enabled;
                this.panelControls.pressureToggle = pressureToggle;

                const detailsRow = panel.createDiv({ cls: "pdfcompose-panel-row" });
                detailsRow.setCssStyles({ display: style.pressure.enabled ? "" : "none" });
                this.panelControls.pressureDetailsRow = detailsRow;

                this.createIconLabel(detailsRow, "Min. Factor:", "percent");
                const minFactorInput = detailsRow.createEl("input", {
                    type: "range",
                    attr: { min: "0", max: "1", step: "0.01" }
                });
                minFactorInput.value = style.pressure.minFactor.toString();
                this.panelControls.pressureMinFactorInput = minFactorInput;

                this.createIconLabel(detailsRow, "Curve:", "spline");
                const curveSelect = detailsRow.createEl("select");
                for (const [value, label] of [
                    ["linear", "Linear"], ["quadratic", "Quadratic"], ["sqrt", "Sqrt"], ["ease", "Ease"],
                ] as const) {
                    const opt = curveSelect.createEl("option", { text: label, value });
                    if (value === style.pressure.curve) opt.selected = true;
                }
                this.panelControls.pressureCurveSelect = curveSelect;

                pressureToggle.addEventListener("change", () => {
                    handlers.onStyleChange({ pressureEnabled: pressureToggle.checked });
                });
                minFactorInput.addEventListener("input", () => {
                    handlers.onStyleChange({ pressureMinFactor: parseFloat(minFactorInput.value) });
                });
                curveSelect.addEventListener("change", () => {
                    handlers.onStyleChange({ pressureCurve: curveSelect.value as PressureCurve });
                });
            }

            // Highlighter-Toggle – anzeigen bei Stift ODER Freihand-Auswahl
            const showHighlighterToggle = isPen || hasFreehandSelection;
            if (showHighlighterToggle) {
                const highlighterRow = panel.createDiv({ cls: "pdfcompose-panel-row" });
                this.createIconLabel(highlighterRow, "Highlighter", "highlighter");
                const highlighterToggle = highlighterRow.createEl("input", { type: "checkbox" });
                highlighterToggle.checked = style.highlighter;
                this.panelControls.highlighterToggle = highlighterToggle;
                highlighterToggle.addEventListener("change", () => {
                    handlers.onStyleChange({ highlighter: highlighterToggle.checked });
                });
            }
        }

        // ---- Formen: "Textmarker"-Eigenschaft ----
        const selectionIsShapeLike = selectionHasLineLike || selectionHasFillable;
        if (showShapeCreationTool || selectionIsShapeLike) {
            const shapeHighlighterRow = panel.createDiv({ cls: "pdfcompose-panel-row" });
            this.createIconLabel(shapeHighlighterRow, "Highlighter Shape", "highlighter");
            const shapeHighlighterToggle = shapeHighlighterRow.createEl("input", { type: "checkbox" });
            shapeHighlighterToggle.checked = style.isHighlighterShape;
            this.panelControls.shapeHighlighterToggle = shapeHighlighterToggle;
            shapeHighlighterToggle.addEventListener("change", () => {
                handlers.onStyleChange({ isHighlighter: shapeHighlighterToggle.checked });
            });
        }

        // ---- Auswahlmodus (immer bei aktivem Auswahlwerkzeug, unabhängig von einer bestehenden Auswahl) ----
        if (isSelectTool) {
            const modeRow = panel.createDiv({ cls: "pdfcompose-panel-row" });
            this.createIconLabel(modeRow, "Selection:", "mouse-pointer-click");
            const modeSelect = modeRow.createEl("select");
            for (const [value, label] of [["touch", "Touched"], ["contain", "Completely Included"]] as const) {
                const opt = modeSelect.createEl("option", { text: label, value });
                if (value === style.selectionMode) opt.selected = true;
            }
            this.panelControls.modeSelect = modeSelect;
            modeSelect.addEventListener("change", () => {
                handlers.onSelectionModeChange(modeSelect.value as SelectionMode);
            });

            const filterRow = panel.createDiv({ cls: "pdfcompose-panel-row" });
            this.createIconLabel(filterRow, "Select:", "filter");

            const targets = style.selectionTargets || { strokes: true, highlighters: true, shapes: true, annotations: true, textBlocks: true };

            const addFilterCheckbox = (label: string, key: keyof FilterTargets, icon: string, title?: string) => {
                this.createIconCaption(filterRow, label, icon);
                const cb = filterRow.createEl("input", { type: "checkbox" });
                cb.checked = targets[key] ?? true;
                if (title) cb.setAttribute("title", title);
                cb.addEventListener("change", () => {
                    handlers.onSelectionTargetsChange({ [key]: cb.checked });
                });
            };

            addFilterCheckbox("Strokes", "strokes", "pencil");
            addFilterCheckbox("Highlighters", "highlighters", "highlighter", "Highlighter Strokes");
            addFilterCheckbox("Shapes", "shapes", "shapes");
            addFilterCheckbox("Annotations", "annotations", "message-square", "PDF Annotations (Highlights + Textboxes)");
            addFilterCheckbox("Text Blocks", "textBlocks", "text", "Text Blocks");

            // Nach diesen Controls ist das Panel für Auswahlwerkzeuge vollständig.
            return;
        }
    }

    private updatePanelValues(style: any): void {
        const c = this.panelControls;
        if (c.strokeColorInput && c.strokeAlphaInput) {
            const split = splitHexAlpha(style.strokeColor);
            c.strokeColorInput.value = split.rgb;
            c.strokeAlphaInput.value = split.alpha.toString();
        }
        if (c.strokeWidthInput && c.widthReadout) {
            c.strokeWidthInput.value = style.strokeWidth.toString();
            c.widthReadout.textContent = style.strokeWidth.toString();
        }
        if (c.fillToggle !== undefined) {
            c.fillToggle.checked = style.fillEnabled;
        }
        if (c.fillColorInput && c.fillAlphaInput) {
            const split = splitHexAlpha(style.fillColor);
            c.fillColorInput.value = split.rgb;
            c.fillAlphaInput.value = split.alpha.toString();
        }
        if (c.segmentSelect) {
            c.segmentSelect.value = style.segmentKind;
        }
        if (c.arrowSelect) {
            c.arrowSelect.value = style.arrowSide;
        }
        // NEU: Pfeilspitzengröße an den aktuell selektierten Pfeil anpassen.
        if (c.arrowSizeInput) {
            const v = typeof style.arrowSize === "number" ? style.arrowSize : 0;
            c.arrowSizeInput.value = String(v);
            // Readout daneben ebenfalls aktualisieren, falls vorhanden.
            const readout = c.arrowSizeInput.nextElementSibling as HTMLElement | null;
            if (readout && readout.classList.contains("pdfcompose-width-readout")) {
                readout.setText(v > 0 ? String(v) : "auto");
            }
        }
        if (c.modeSelect) {
            c.modeSelect.value = style.selectionMode;
        }
        if (c.pressureToggle) {
            c.pressureToggle.checked = style.pressure.enabled;
        }
        if (c.pressureDetailsRow) {
            c.pressureDetailsRow.setCssStyles({ display: style.pressure.enabled ? "" : "none" });
        }
        if (c.pressureMinFactorInput) {
            c.pressureMinFactorInput.value = style.pressure.minFactor.toString();
        }
        if (c.pressureCurveSelect) {
            c.pressureCurveSelect.value = style.pressure.curve;
        }
        if (c.highlighterToggle) {
            c.highlighterToggle.checked = style.highlighter;
        }
        if (c.eraserStrokesToggle) {
            c.eraserStrokesToggle.checked = style.eraserTargets.strokes;
        }
        if (c.eraserShapesToggle) {
            c.eraserShapesToggle.checked = style.eraserTargets.shapes;
        }
        if (c.eraserAnnotationsToggle) {
            c.eraserAnnotationsToggle.checked = style.eraserTargets.annotations;
        }
        if (c.eraserTextBlocksToggle) {
            c.eraserTextBlocksToggle.checked = style.eraserTargets.textBlocks;
        }
        if (c.eraserHighlightersToggle) {
            c.eraserHighlightersToggle.checked = style.eraserTargets.highlighters;
        }
        if (c.shapeHighlighterToggle) {
            c.shapeHighlighterToggle.checked = style.isHighlighterShape;
        }
    }

    // ========== AUSWAHL-HANDLES ==========
    public renderSelectionHandles(
        pageId: string | null,
        selectedIds: Set<string>,
        objects: VectorObject[],
        onHandleDrag: (
            evt: PointerEvent,
            mode: "rotate" | "scale-corner",
            svg: SVGSVGElement,
            cornerIndex?: number,
        ) => void
    ): void {
        for (const svg of this.annotationLayers.values()) {
            svg.querySelector(".pdfcompose-selection-handles")?.remove();
        }
        this.selectionHandlesGroup = null;

        if (!pageId || selectedIds.size === 0) return;
        const svg = this.annotationLayers.get(pageId);
        if (!svg) return;

        const selected = objects.filter(obj => selectedIds.has(obj.id));
        if (selected.length === 0) {
            selectedIds.clear();
            return;
        }

        const frame = this.view.getSelectionFrame(selected) as
            { corners: { x: number; y: number }[]; rotation: number } | null;
        if (!frame) return;

        const NS = "http://www.w3.org/2000/svg";
        const group = document.createElementNS(NS, "g");
        group.classList.add("pdfcompose-selection-handles");
        group.setCssStyles({ pointerEvents: "none" });
        svg.appendChild(group);
        this.selectionHandlesGroup = group;

        const box = document.createElementNS(NS, "polygon");
        box.setAttribute("points", frame.corners.map(c => `${c.x},${c.y}`).join(" "));
        box.setAttribute("fill", "none");
        box.classList.add("pdfcompose-selection-box");
        box.setCssStyles({ pointerEvents: "none" });
        group.appendChild(box);

        // Skaliergriffe (NW, NE, SE, SW – Index 0..3), mit der Form mitgedreht
        frame.corners.forEach((corner, cornerIdx) => {
            const size = 8;
            const handle = document.createElementNS(NS, "rect");
            handle.setAttribute("x", (corner.x - size / 2).toString());
            handle.setAttribute("y", (corner.y - size / 2).toString());
            handle.setAttribute("width", size.toString());
            handle.setAttribute("height", size.toString());
            if (frame.rotation) handle.setAttribute("transform", `rotate(${frame.rotation} ${corner.x} ${corner.y})`);
            handle.classList.add("pdfcompose-scale-handle");
            handle.setCssStyles({ pointerEvents: "all" });
            handle.addEventListener("pointerdown", (e) => onHandleDrag(e, "scale-corner", svg, cornerIdx));
            group.appendChild(handle);
        });

        // Rotate-Handle: mittig über der (gedrehten) Oberkante
        const [nw, ne] = frame.corners;
        const tx = ne.x - nw.x, ty = ne.y - nw.y;
        const len = Math.hypot(tx, ty) || 1;
        const upX = ty / len, upY = -tx / len;
        const rotateDistance = 28;
        const rotateHandle = document.createElementNS(NS, "circle");
        rotateHandle.setAttribute("cx", ((nw.x + ne.x) / 2 + upX * rotateDistance).toString());
        rotateHandle.setAttribute("cy", ((nw.y + ne.y) / 2 + upY * rotateDistance).toString());
        rotateHandle.setAttribute("r", "6");
        rotateHandle.classList.add("pdfcompose-rotate-handle");
        rotateHandle.setCssStyles({ pointerEvents: "all" });
        rotateHandle.addEventListener("pointerdown", (e) => onHandleDrag(e, "rotate", svg));
        group.appendChild(rotateHandle);
    }

    /** Rendert je einen ziehbaren Kreis-Handle pro definierendem Punkt eines Linien-/Pfeil-/Polygon-Objekts. */
    public renderPointHandles(
        pageId: string,
        obj: VectorObject,
        onPointDrag: (evt: PointerEvent, index: number, svg: SVGSVGElement) => void,
        boundIndices: Set<number> = new Set()
    ): void {
        if (obj.type !== "line" && obj.type !== "arrow" && obj.type !== "polygon") return;
        const svg = this.annotationLayers.get(pageId);
        const group = this.selectionHandlesGroup;
        if (!svg || !group) return;

        obj.points.forEach((p, index) => {
            const handle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            handle.setAttribute("cx", p.x.toString());
            handle.setAttribute("cy", p.y.toString());
            handle.setAttribute("r", "5");
            const isBound = boundIndices.has(index);
            // Inline-Styles (nicht setAttribute) → gewinnen gegen CSS-Klassen.
            handle.setCssStyles({ fill: isBound ? "#40c057" : "#ffffff", stroke: isBound ? "#2f9e44" : "#7c3aed", strokeWidth: "2", pointerEvents: "all", visibility: "visible", opacity: "1" });
            handle.classList.add("pdfcompose-point-handle");
            if (isBound) {
                handle.classList.add("pdfcompose-point-handle-bound");
                handle.setAttribute("title", "An Form gebunden – ziehen zum Lösen");
            }
            handle.setAttribute("data-point-index", index.toString());
            handle.addEventListener("pointerdown", (e) => onPointDrag(e, index, svg));
            group.appendChild(handle);
        });
    }

    /** Aktualisiert die Positionen bestehender Punkt-Handles (z. B. während des Ziehens), ohne alles neu aufzubauen. */
    public updatePointHandlePositions(obj: VectorObject): void {
        if (obj.type !== "line" && obj.type !== "arrow" && obj.type !== "polygon") return;
        if (!this.selectionHandlesGroup) return;
        const handles = this.selectionHandlesGroup.querySelectorAll<SVGCircleElement>(".pdfcompose-point-handle");
        obj.points.forEach((p, i) => {
            const handle = handles[i];
            if (handle) {
                handle.setAttribute("cx", p.x.toString());
                handle.setAttribute("cy", p.y.toString());
            }
        });
    }

    public updateSelectionHighlight(
        pageId: string,
        selectedVectors: Set<string>,
        selectedTextBlocks: Set<string>,
        selectedAnnotations: Set<string>
    ): void {
        // Vektorobjekte
        for (const layer of this.getObjectLayers(pageId)) {
            layer.querySelectorAll<SVGGraphicsElement>("[data-object-id]").forEach(el => {
                const id = el.getAttribute("data-object-id");
                if (id && selectedVectors.has(id)) el.classList.add("pdfcompose-object-selected");
                else el.classList.remove("pdfcompose-object-selected");
            });
        }
        // Textblöcke
        const textLayer = this.textBlockLayers.get(pageId);
        if (textLayer) {
            textLayer.querySelectorAll<HTMLElement>('.pdfcompose-textblock').forEach(el => {
                const id = el.getAttribute('data-textblock-id');
                if (id && selectedTextBlocks.has(id)) el.classList.add('pdfcompose-object-selected');
                else el.classList.remove('pdfcompose-object-selected');
            });
        }
        // PDF-Annotationen (Markierungs-Rechtecke)
        const highlightLayer = this.highlightLayers.get(pageId);
        if (highlightLayer) {
            highlightLayer.querySelectorAll<SVGElement>('[data-pdf-annotation-id]').forEach(el => {
                const id = el.getAttribute('data-pdf-annotation-id');
                if (id && selectedAnnotations.has(id)) el.classList.add('pdfcompose-object-selected');
                else el.classList.remove('pdfcompose-object-selected');
            });
        }
    }

    public previewTransformSelection(pageId: string, pivot: { x: number; y: number }, rotateDeg: number, scaleFactor: number, selectedIds: Set<string>): void {
        const transform = `translate(${pivot.x} ${pivot.y}) rotate(${rotateDeg}) scale(${scaleFactor}) translate(${-pivot.x} ${-pivot.y})`;
        for (const id of selectedIds) {
            const el = this.findObjectElementById(pageId, id);
            el?.setAttribute("transform", transform);
        }
        this.selectionHandlesGroup?.setAttribute("transform", transform);
    }

    // ========== HILFSFUNKTIONEN ==========
    private getSelectionBoundsBox(objects: VectorObject[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const obj of objects) {
            const pts = this.getObjectPoints(obj);
            for (const p of pts) {
                minX = Math.min(minX, p.x);
                maxX = Math.max(maxX, p.x);
                minY = Math.min(minY, p.y);
                maxY = Math.max(maxY, p.y);
            }
        }
        if (!Number.isFinite(minX)) return null;
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
            case "diamond":
                return [
                    { x: obj.x, y: obj.y },
                    { x: obj.x + obj.width, y: obj.y + obj.height },
                ];
            case "triangle": {
                const width = obj.width ?? obj.size ?? 0;
                const height = obj.height ?? obj.size ?? 0;
                return [
                    { x: obj.x, y: obj.y },
                    { x: obj.x + width, y: obj.y + height },
                ];
            }
            case "ellipse":
                return [
                    { x: obj.cx - obj.rx, y: obj.cy - obj.ry },
                    { x: obj.cx + obj.rx, y: obj.cy + obj.ry },
                ];
        }
    }

    // ========== SCROLLEN ZU SEITE ==========
    public scrollToPage(pageId: string, behavior: ScrollBehavior = "smooth"): void {
        const container = this.pagesContainerEl;
        if (!container) return;
        const target = container.querySelector<HTMLElement>(`[data-page-id="${pageId}"]`);
        if (!target) return;

        // Programmatisches Smooth-Scrollen: Seitenleiste nicht bei jeder passierten Seite mitscrollen lassen
        if (behavior === "smooth") this.lockCurrentPageHighlight(pageId);

        const horizontal = this.plugin.settings.horizontalLayout;
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();

        if (horizontal) {
            const desiredCenterX = containerRect.left + container.clientWidth / 2;
            const deltaX = (targetRect.left + targetRect.width / 2) - desiredCenterX;
            container.scrollTo({ left: container.scrollLeft + deltaX, behavior });
        } else {
            const desiredCenterY = containerRect.top + container.clientHeight / 2;
            const deltaY = (targetRect.top + targetRect.height / 2) - desiredCenterY;
            container.scrollTo({ top: container.scrollTop + deltaY, behavior });
        }
    }

    // ========== SEITEN-ELEMENTE ERSTELLEN (für Hauptbereich, Seiten-Virtualisierung) ==========

    /**
     * Erstellt einen Platzhalter für eine Seite mit fester, endgültiger
     * Größe. Der eigentliche Inhalt (Canvas, Annotationen, Textblöcke, …)
     * wird erst bei Sichtbarkeit per hydratePagePlaceholder() eingehängt
     * (siehe PdfComposeView.mountPage/unmountPage). Die feste Größe sorgt
     * dafür, dass Scrollposition und Gesamthöhe des Dokuments sich NICHT
     * ändern, wenn Inhalt später ein- oder ausgehängt wird.
     */
    public createPagePlaceholder(
        pageId: string,
        index: number,
        width: number,
        height: number,
        annotationColumnWidth: number,
    ): HTMLElement {
        const pageWrapperEl = this.pagesContentEl.createDiv({ cls: "pdfcompose-page" });
        pageWrapperEl.setAttribute("data-page-id", pageId);
        const labelEl = pageWrapperEl.createDiv({ cls: "pdfcompose-page-label" });
        labelEl.setText(`Page ${index + 1}`);

        const placeholder = pageWrapperEl.createDiv({
            cls: "pdfcompose-page-body pdfcompose-page-body-placeholder",
        });
        placeholder.setCssStyles({ pointerEvents: "none" });

        const skeleton = placeholder.createDiv({ cls: "pdfcompose-page-skeleton" });
        skeleton.setCssStyles({ width: `${width}px`, height: `${height}px` });
        skeleton.setText("…");

        // Reserviert GENAU denselben Platz wie die Anmerkungsspalte im
        // montierten Zustand. Ohne das würde das Mounten einer Seite die
        // Gesamtbreite um bis zu ~380px vergrößern und alle nachfolgenden
        // Seiten verschieben - der sichtbare "Sprung" beim horizontalen Scrollen.
        if (annotationColumnWidth > 0) {
            const annotStub = placeholder.createDiv({
                cls: "pdfcompose-annotation-column pdfcompose-annotation-column-placeholder",
            });
            annotStub.setCssStyles({ width: `${annotationColumnWidth}px` });
        }

        return pageWrapperEl;
    }

    public hydratePagePlaceholder(pageWrapperEl: HTMLElement): HTMLElement {
        // Wir entfernen den GESAMTEN Placeholder-Body (Skelett + Annotations-Stub),
        // damit der echte Seiteninhalt exakt dessen Layout übernimmt.
        pageWrapperEl.querySelector(".pdfcompose-page-body-placeholder")?.remove();
        return this.createPageBody(pageWrapperEl);
    }

    public dehydratePage(
        pageWrapperEl: HTMLElement,
        width: number,
        height: number,
        annotationColumnWidth: number,
    ): void {
        pageWrapperEl.querySelectorAll(".pdfcompose-page-body").forEach(el => el.remove());
        if (!pageWrapperEl.querySelector(".pdfcompose-page-body-placeholder")) {
            const placeholder = pageWrapperEl.createDiv({
                cls: "pdfcompose-page-body pdfcompose-page-body-placeholder",
            });
            placeholder.setCssStyles({ pointerEvents: "none" });

            const skeleton = placeholder.createDiv({ cls: "pdfcompose-page-skeleton" });
            skeleton.setCssStyles({ width: `${width}px`, height: `${height}px` });
            skeleton.setText("…");

            if (annotationColumnWidth > 0) {
                const annotStub = placeholder.createDiv({
                    cls: "pdfcompose-annotation-column pdfcompose-annotation-column-placeholder",
                });
                annotStub.setCssStyles({ width: `${annotationColumnWidth}px` });
            }
        }
    }

    public createCanvasWrapper(pageWrapper: HTMLElement): HTMLElement {
        return pageWrapper.createDiv({ cls: "pdfcompose-canvas-wrapper" });
    }

    public renderBlankPage(page: BlankPageDefinition, container: HTMLElement): void {
        const size = typeof page.size === "object" ? page.size : PAGE_SIZES[page.size ?? "A4"];
        const blankEl = container.createDiv({ cls: "pdfcompose-blank-page" });
        blankEl.setCssStyles({ width: `${size.width}px`, height: `${size.height}px` });
    }

    public renderPdfPageContainer(pageId: string, container: HTMLElement): {
        wrapper: HTMLElement;
        canvas: HTMLCanvasElement;
    } {
        const wrapper = container.createDiv({ cls: "pdfcompose-page-wrapper" });
        wrapper.setCssStyles({ position: "relative", display: "inline-block" });
        const canvas = wrapper.createEl("canvas", { cls: "pdfcompose-page-canvas" });
        return { wrapper, canvas };
    }

    public createOverlay(
        wrapper: HTMLElement,
        pageId: string,
        viewport: { width: number; height: number },
        effectiveScale: number
    ): void {
        const overlay = wrapper.createDiv({ cls: "pdfcompose-overlay" });
        overlay.setCssStyles({ position: "absolute", top: "0", left: "0", pointerEvents: "none", width: "100%", height: "100%" });
        this.pageOverlays.set(pageId, overlay);
        overlay.dataset.viewportWidth = viewport.width.toString();
        overlay.dataset.viewportHeight = viewport.height.toString();
        overlay.dataset.scale = effectiveScale.toString();
    }

    public renderTextLayer(items: TextItemWithPosition[], container: HTMLElement, scale: number): void {
        const textLayer = container.createDiv({ cls: "pdfcompose-text-layer" });
        const pendingSingle: { span: HTMLElement; targetWidth: number }[] = [];
        const pendingGroups: { spans: HTMLElement[]; baseLeft: number; targetTotalWidth: number }[] = [];

        for (const item of items) {
            if (!item.str) continue;
            const fontSize = item.height * scale;
            const top = ((item.y - item.height) * scale);
            const baseLeft = item.x * scale;

            // In Wort-/Leerzeichen-Tokens zerlegen: ein einzelnes PDF-
            // Textelement (item.str) fasst häufig mehrere Wörter zusammen.
            // Als EIN <span> müsste der Browser bei Drag-Selektion
            // (caretRangeFromPoint) die Zeichenposition anhand der
            // UNVERZERRTEN internen Layout-Metriken bestimmen, während
            // visuell per CSS-Transform (scaleX, siehe unten) gestreckt
            // oder gestaucht wird - bei langen, mehrere Wörter umfassenden
            // Spans potenziert sich dieser Fehler, und die native Auswahl
            // "springt" beim Ziehen scheinbar beliebig weit. Mit einem
            // eigenen <span> pro Wort ist der maximale Fehler auf die
            // Breite eines einzelnen Wortes begrenzt, und der Browser kann
            // Selektionsgrenzen nicht mehr versehentlich in ein
            // Nachbarwort hinein "verschieben", da jedes Wort ein
            // eigenständiges DOM-Element mit eigener Position ist.
            const tokens = item.str.split(/(\s+)/).filter(t => t.length > 0);

            if (tokens.length <= 1) {
                const span = textLayer.createEl("span");
                span.textContent = item.str;
                span.setCssStyles({ left: baseLeft + "px", top: top + "px", fontSize: fontSize + "px", lineHeight: "1", whiteSpace: "pre", transformOrigin: "0 0" });
                pendingSingle.push({ span, targetWidth: item.width * scale });
                continue;
            }

            const spans: HTMLElement[] = [];
            for (const token of tokens) {
                const span = textLayer.createEl("span");
                span.textContent = token;
                span.setCssStyles({ top: top + "px", fontSize: fontSize + "px", lineHeight: "1", whiteSpace: "pre", transformOrigin: "0 0" });
                spans.push(span);
            }
            pendingGroups.push({ spans, baseLeft, targetTotalWidth: item.width * scale });
        }

        if (pendingSingle.length === 0 && pendingGroups.length === 0) return;

        // Batched Read/Write statt einem eigenen requestAnimationFrame pro
        // Textelement: erst ALLE Layouts schreiben (oben), dann in einem
        // einzigen Frame ALLE Breiten lesen, dann ALLE Positionen/Transforms
        // schreiben. Verhindert erzwungene Reflows (Layout-Thrashing), die
        // bei textreichen Seiten auf schwächeren Mobile-Geräten spürbar sind.
        requestAnimationFrame(() => {
            const singleWidths = pendingSingle.map(p => p.span.getBoundingClientRect().width);
            const groupWidths = pendingGroups.map(g => g.spans.map(s => s.getBoundingClientRect().width));

            for (let i = 0; i < pendingSingle.length; i++) {
                const { span, targetWidth } = pendingSingle[i];
                const actualWidth = singleWidths[i];
                if (actualWidth > 0 && targetWidth > 0) {
                    span.setCssStyles({ transform: `scaleX(${targetWidth / actualWidth})` });
                }
            }

            for (let i = 0; i < pendingGroups.length; i++) {
                const { spans, baseLeft, targetTotalWidth } = pendingGroups[i];
                const widths = groupWidths[i];
                const naturalTotal = widths.reduce((sum, w) => sum + w, 0);
                if (naturalTotal <= 0) continue;

                // Die ursprüngliche PDF-Zielbreite anteilig nach den
                // (im selben Ersatz-Font) gemessenen natürlichen Breiten
                // auf die einzelnen Wörter verteilen, statt einen groben
                // globalen scaleX-Faktor über die ganze Zeile zu legen.
                let cursor = baseLeft;
                for (let j = 0; j < spans.length; j++) {
                    const span = spans[j];
                    const naturalWidth = widths[j];
                    const tokenTargetWidth = (naturalWidth / naturalTotal) * targetTotalWidth;
                    span.setCssStyles({ left: cursor + "px" });
                    if (naturalWidth > 0 && tokenTargetWidth > 0) {
                        span.setCssStyles({ transform: `scaleX(${tokenTargetWidth / naturalWidth})` });
                    }
                    cursor += tokenTargetWidth;
                }
            }
        });
    }

    /**
 * Rendert klickbare Overlay-Links für die Link-Annotationen einer
 * PDF-Seite. Wird nach der Textebene, aber vor der Annotations-Ebene
 * ins DOM gehängt: bei aktivem Zeichenwerkzeug blockiert die Annotations-
 * Ebene (pointer-events: auto) die Klicks wie gewohnt, im Zeiger-Modus
 * (currentTool "none") ist sie transparent für Pointer-Events und die
 * Links bleiben klickbar.
 */
    public renderLinkLayer(
        links: PdfLinkAnnotation[],
        container: HTMLElement,
        scale: number,
        onInternalLinkClick: (pageNumber: number) => void
    ): void {
        if (links.length === 0) return;
        const layer = container.createDiv({ cls: "pdfcompose-link-layer" });
        for (const link of links) {
            if (link.width <= 0 || link.height <= 0) continue;
            const a = layer.createEl("a", { cls: "pdfcompose-pdf-link" });
            a.setCssStyles({ left: (link.x * scale) + "px", top: (link.y * scale) + "px", width: (link.width * scale) + "px", height: (link.height * scale) + "px" });

            if (link.url) {
                a.href = link.url;
                a.target = "_blank";
                a.rel = "noopener noreferrer";
                a.title = link.url;
            } else if (link.internalPage) {
                a.href = "#";
                a.title = `Springe zu Seite ${link.internalPage}`;
                a.addEventListener("click", (e) => {
                    e.preventDefault();
                    onInternalLinkClick(link.internalPage!);
                });
            }
        }
    }

    /**
 * Erzeugt die Textmarker-Ebene einer Seite. Liegt im DOM VOR der Textebene
 * und der normalen Annotations-Ebene, dadurch rendert sie unterhalb von
 * Schrift, Textblöcken, Formen und normalen Strichen – aber oberhalb des
 * Canvas-Hintergrunds.
 */
    public createHighlightLayer(pageId: string, wrapper: HTMLElement, rawWidth: number, rawHeight: number): SVGSVGElement {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
        svg.setAttribute("viewBox", `0 0 ${rawWidth} ${rawHeight}`);
        svg.classList.add("pdfcompose-highlight-layer");
        svg.setCssStyles({ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "1" });
        wrapper.appendChild(svg);
        this.highlightLayers.set(pageId, svg);
        return svg;
    }

    /**
 * Setzt den Blend-Mode der Textmarker-Ebene passend zum Farbmodus der
 * Seite. Im Normalmodus sorgt "multiply" dafür, dass der Textmarker wie
 * gewohnt hinter dunklem Text verschwindet. Im (invertierten) Dark Mode
 * wäre "multiply" gegen einen dunklen Hintergrund praktisch unsichtbar
 * und würde stattdessen die dort helle Schrift einfärben – "screen"
 * kehrt das Verhalten korrekt um: der Hintergrund wird hervorgehoben,
 * heller Text bleibt unangetastet.
 */
    public setHighlightLayerBlendMode(pageId: string, invert: boolean): void {
        const svg = this.highlightLayers.get(pageId);
        if (!svg) return;
        svg.setCssStyles({ mixBlendMode: invert ? "screen" : "multiply" });
    }

    /**
 * Wie setHighlightLayerBlendMode(), aber für die Verbindungslinien-Ebene:
 * Da der eigentliche PDF-Text fest in die Canvas-Pixel eingebrannt ist
 * (keine eigene DOM-Textebene), kann eine normal gezeichnete Linie nur
 * per Blend-Mode "hinter" den Text treten statt ihn undurchsichtig zu
 * überdecken - exakt derselbe Trick wie bei der Textmarker-Ebene.
 */
    public setConnectorLayerBlendMode(pageId: string, invert: boolean): void {
        const svg = this.connectorLayers.get(pageId);
        if (!svg) return;
        svg.setCssStyles({ mixBlendMode: invert ? "screen" : "multiply" });
    }

    public pruneConnectors(pageId: string, validIds: Set<string>): void {
        const svg = this.connectorLayers.get(pageId);
        if (!svg) return;
        svg.querySelectorAll<SVGElement>("[data-connector-id]").forEach((el) => {
            const id = el.getAttribute("data-connector-id");
            if (!id || !validIds.has(id)) el.remove();
        });
    }

    /** Liefert [Textmarker-Ebene, Annotations-Ebene] einer Seite (sofern vorhanden). */
    public getObjectLayers(pageId: string): SVGSVGElement[] {
        const layers: SVGSVGElement[] = [];
        const highlight = this.highlightLayers.get(pageId);
        if (highlight) layers.push(highlight);
        const annotation = this.annotationLayers.get(pageId);
        if (annotation) layers.push(annotation);
        return layers;
    }

    /** Alle Objekt-Elemente einer Seite über beide Ebenen hinweg (Annotations-Ebene zuletzt = "oberste" Treffer). */
    public queryAllObjectElements(pageId: string): SVGGraphicsElement[] {
        const result: SVGGraphicsElement[] = [];
        for (const layer of this.getObjectLayers(pageId)) {
            layer.querySelectorAll<SVGGraphicsElement>("[data-object-id]").forEach(el => result.push(el));
        }
        return result;
    }

    /** Sucht ein Objekt-Element per ID über beide Ebenen hinweg. */
    public findObjectElementById(pageId: string, id: string): SVGGraphicsElement | null {
        for (const layer of this.getObjectLayers(pageId)) {
            const el = layer.querySelector<SVGGraphicsElement>(`[data-object-id="${id}"]`);
            if (el) return el;
        }
        return null;
    }

    // ========== PDF-ANMERKUNGEN (Spalte rechts, Verbindungslinien) ==========

    public createPageBody(pageWrapper: HTMLElement): HTMLElement {
        return pageWrapper.createDiv({ cls: "pdfcompose-page-body" });
    }

    public createCanvasSlot(body: HTMLElement): HTMLElement {
        return body.createDiv({ cls: "pdfcompose-canvas-wrapper" });
    }

    public createAnnotationColumn(pageId: string, body: HTMLElement): HTMLElement {
        const column = body.createDiv({ cls: "pdfcompose-annotation-column" });
        this.annotationColumns.set(pageId, column);
        return column;
    }

    public createConnectorLayer(pageId: string, wrapper: HTMLElement): SVGSVGElement {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
        svg.classList.add("pdfcompose-connector-layer");
        svg.setCssStyles({ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "2" });
        wrapper.appendChild(svg);
        this.connectorLayers.set(pageId, svg);
        return svg;
    }

    /**
     * Zeichnet die Textmarkierungs-Rechtecke einer Anmerkung in die Textmarker-
     * Ebene (liegt bereits hinter Text, vor Hintergrund – siehe createHighlightLayer).
     */
    public drawPdfAnnotationHighlights(pageId: string, entries: PdfAnnotationEntry[]): void {
        const svg = this.highlightLayers.get(pageId);
        if (!svg) return;
        svg.querySelectorAll("[data-pdf-annotation-id]").forEach((el) => el.remove());
        for (const entry of entries) {
            for (const rect of entry.rects) {
                const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
                r.setAttribute("x", rect.x.toString());
                r.setAttribute("y", rect.y.toString());
                r.setAttribute("width", rect.width.toString());
                r.setAttribute("height", rect.height.toString());
                r.setAttribute("fill", entry.color);
                r.setAttribute("data-pdf-annotation-id", entry.id);
                svg.appendChild(r);
            }
        }
    }

    /** Rendert eine einzelne Anmerkungsbox: nur vertikal verschiebbar, Breite anpassbar. */
    public async renderPdfAnnotationBox(
        container: HTMLElement,
        entry: PdfAnnotationEntry,
        scale: number,
        component: Component,
        sourcePath: string,
        displayColor: string,
        invert: boolean,
        handlers: {
            onEdit: (entry: PdfAnnotationEntry) => void;
            onVerticalDrag: (evt: PointerEvent, entry: PdfAnnotationEntry) => void;
            onWidthDrag: (evt: PointerEvent, entry: PdfAnnotationEntry) => void;
        }
    ): Promise<void> {
        const box = container.createDiv({ cls: "pdfcompose-pdfannot" });
        box.setAttribute("data-pdfannot-id", entry.id);
        box.setCssStyles({ top: (entry.y * scale) + "px", width: (entry.width * scale) + "px" });
        box.style.setProperty("--pdfannot-color", displayColor);

        const editBar = box.createDiv({ cls: "pdfcompose-pdfannot-editbar" });
        const swatch = editBar.createSpan({ cls: "pdfcompose-pdfannot-swatch" });
        swatch.setCssStyles({ backgroundColor: displayColor });
        const editBtn = editBar.createEl("button", { text: "✎", cls: "pdfcompose-textblock-editbtn" });
        editBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            handlers.onEdit(entry);
        });

        const vHandle = box.createDiv({ cls: "pdfcompose-pdfannot-handle-v" });
        vHandle.setAttribute("title", "Vertikal verschieben");
        vHandle.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            handlers.onVerticalDrag(e, entry);
        });

        const widthHandle = box.createDiv({ cls: "pdfcompose-textblock-handle pdfcompose-textblock-handle-width" });
        widthHandle.setAttribute("title", "Breite ändern");
        widthHandle.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            handlers.onWidthDrag(e, entry);
        });

        const zoomFactor = (entry.fontScale || 100) / 100;
        const inner = box.createDiv({ cls: "pdfcompose-textblock-inner" });
        inner.setCssStyles({ width: ((entry.width * scale) / zoomFactor) + "px", zoom: zoomFactor.toString() } as any);
        inner.toggleClass("pdfcompose-inverted-text", invert);

        const markdown = entry.markdown.trim() ? entry.markdown : "*(leer – auf ✎ klicken zum Bearbeiten)*";
        await MarkdownRenderer.render(this.plugin.app, markdown, inner, sourcePath, component);
    }

    /**
     * Berechnet und zeichnet die Verbindungslinie zwischen Textmarkierung und
     * Anmerkungsbox anhand tatsächlicher Bildschirmpositionen (die beiden liegen
     * in unterschiedlichen Koordinatensystemen: Canvas-Zoom vs. Spalten-Layout).
     */
    public updateConnector(pageId: string, entry: PdfAnnotationEntry): void {
        const svg = this.connectorLayers.get(pageId);
        const wrapper = svg?.parentElement;
        const column = this.annotationColumns.get(pageId);
        if (!svg || !wrapper || !column) return;

        svg.querySelectorAll(`[data-connector-id="${entry.id}"]`).forEach((el) => el.remove());
        if (entry.connector === "none") return;

        const highlightRects = Array.from(
            this.highlightLayers.get(pageId)?.querySelectorAll<SVGGraphicsElement>(`[data-pdf-annotation-id="${entry.id}"]`) ?? []
        );
        const boxEl = column.querySelector(`[data-pdfannot-id="${entry.id}"]`) as HTMLElement | null;
        if (highlightRects.length === 0 || !boxEl) return;

        const refRect = wrapper.getBoundingClientRect();
        // getBoundingClientRect() liefert bereits durch CSS "zoom" (auf
        // pagesContentEl) skalierte Bildschirmpixel. Die Connector-SVG hat
        // aber KEIN viewBox – ihre Pfad-Koordinaten gelten also in den
        // UNSKALIERTEN Einheiten der Seite und werden beim Rendern selbst
        // noch einmal vom umgebenden "zoom" vergrößert. Ohne diese Division
        // würde der Zoom doppelt angewendet und Start-/Endpunkt liefen mit
        // wachsendem/fallendem Zoom von Markierung bzw. Anmerkungsbox weg.
        const zoom = this.view.getZoomLevel?.() ?? 1;

        let rightmost = highlightRects[0].getBoundingClientRect();
        for (const el of highlightRects) {
            const r = el.getBoundingClientRect();
            if (r.right > rightmost.right) rightmost = r;
        }

        const bRect = boxEl.getBoundingClientRect();

        const start = {
            x: (rightmost.right - refRect.left) / zoom,
            y: (rightmost.top + rightmost.height / 2 - refRect.top) / zoom,
        };
        const end = {
            x: (bRect.left - refRect.left) / zoom,
            y: (bRect.top + bRect.height / 2 - refRect.top) / zoom,
        };

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("data-connector-id", entry.id);
        path.setAttribute("stroke", this.view.getDisplayColor(pageId, entry.color));
        path.setAttribute("stroke-width", "1.5");
        path.setAttribute("fill", "none");

        let d: string;
        if (entry.connector === "straight") {
            d = `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
        } else if (entry.connector === "step") {
            const midX = (start.x + end.x) / 2;
            d = `M ${start.x} ${start.y} L ${midX} ${start.y} L ${midX} ${end.y} L ${end.x} ${end.y}`;
        } else {
            const cx = start.x + (end.x - start.x) / 2;
            d = `M ${start.x} ${start.y} C ${cx} ${start.y} ${cx} ${end.y} ${end.x} ${end.y}`;
        }
        path.setAttribute("d", d);
        svg.appendChild(path);
    }

    public renderAnnotationLayer(
        pageId: string,
        wrapper: HTMLElement,
        rawWidth: number,
        rawHeight: number,
        doc: PdfComposeDocument,
        currentTool: AnnotationTool,
        onPointerDown: (evt: PointerEvent, svg: SVGSVGElement, pageId: string) => void,
        onPointerMove: (evt: PointerEvent, svg: SVGSVGElement, pageId: string) => void,
        onPointerUp: (evt: PointerEvent, svg: SVGSVGElement, pageId: string) => void
    ): SVGSVGElement {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
        svg.setAttribute("viewBox", `0 0 ${rawWidth} ${rawHeight}`);
        svg.classList.add("pdfcompose-annotation-layer");
        svg.setCssStyles({ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", pointerEvents: currentTool !== "none" ? "auto" : "none", cursor: currentTool === "eraser" ? "cell" : (currentTool !== "none" ? "crosshair" : "default"), zIndex: "22", touchAction: "none" });

        wrapper.appendChild(svg);
        this.annotationLayers.set(pageId, svg);

        svg.addEventListener("pointerdown", (e) => onPointerDown(e, svg, pageId));
        svg.addEventListener("pointermove", (e) => onPointerMove(e, svg, pageId));
        svg.addEventListener("pointerup", (e) => onPointerUp(e, svg, pageId));
        svg.addEventListener("pointercancel", (e) => onPointerUp(e, svg, pageId));

        const stored = doc.annotations[pageId];
        try {
            // Immer aus dem View-Stand zeichnen, nie abhängig vom (evtl. veralteten) doc
            const objects = this.view.getPageAnnotations(pageId);
            for (const obj of objects) {
                try {
                    this.view.drawVectorObject(pageId, obj);
                } catch (e) {
                    // Ein defektes Objekt darf die restlichen nicht verhindern
                    console.warn(`Objekt ${obj.id} auf Seite ${pageId} konnte nicht gezeichnet werden`, e);
                }
            }
        } catch (e) {
            console.warn(`Annotationen für Seite ${pageId} konnten nicht geladen werden`, e);
        }
        return svg;
    }

    // ========== TEXTBLÖCKE ==========
    public createTextBlockLayer(parent: HTMLElement, pageId: string): HTMLElement {
        const layer = parent.createDiv({ cls: "pdfcompose-textblock-layer" });

        layer.setCssStyles({ position: "absolute", top: "0", left: "0", width: "100%", height: "100%" });

        // Die Ebene liegt immer über PDF-Text, Such-Highlights und Annotationen
        // (auch über der Annotations-SVG, die z-index 22 hat - siehe
        // renderAnnotationLayer). Nur so bleiben "Bearbeiten"-Button sowie
        // Positions-/Breiten-Handle der Textblöcke klickbar, während ein
        // Zeichen-/Auswahl-/Text-Werkzeug aktiv ist (dann hat die SVG
        // pointer-events:auto und würde sonst alle Klicks abfangen).
        // Die Ebene selbst bleibt aber transparent für Pointer-Events.
        layer.setCssStyles({ pointerEvents: "none", zIndex: "23" });

        this.textBlockLayers.set(pageId, layer);
        return layer;
    }

    public async renderTextBlock(
        container: HTMLElement,
        entry: TextBlockEntry,
        scale: number,
        component: Component,
        sourcePath: string,
        darkBackground: boolean,
        handlers: {
            onEdit: (entry: TextBlockEntry) => void;
            onPositionDrag: (evt: PointerEvent, entry: TextBlockEntry) => void;
            onWidthDrag: (evt: PointerEvent, entry: TextBlockEntry) => void;
        }
    ): Promise<void> {
        const block = container.createDiv({ cls: "pdfcompose-textblock" });
        block.setAttribute("data-textblock-id", entry.id);

        block.setCssStyles({ position: "absolute", left: (entry.x * scale) + "px", top: (entry.y * scale) + "px", width: (entry.width * scale) + "px" });

        block.setCssStyles({ pointerEvents: "auto", zIndex: "21" });

        const editBar = block.createDiv({
            cls: "pdfcompose-textblock-editbar"
        });

        editBar.setCssStyles({ pointerEvents: "auto", position: "relative", zIndex: "100" });

        const editBtn = editBar.createEl("button", {
            text: "✎ Bearbeiten",
            cls: "pdfcompose-textblock-editbtn"
        });

        editBtn.setCssStyles({ pointerEvents: "auto", position: "relative", zIndex: "101" });

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
        inner.setCssStyles({ width: ((entry.width * scale) / zoomFactor) + "px", zoom: zoomFactor.toString() } as any);

        inner.toggleClass("pdfcompose-textblock-dark-bg", darkBackground);
        inner.toggleClass("pdfcompose-textblock-light-bg", !darkBackground);

        const markdown = entry.markdown.trim() ? entry.markdown : "*(leer – auf ✎ klicken zum Bearbeiten)*";
        await MarkdownRenderer.render(this.plugin.app, markdown, inner, sourcePath, component);
    }

    // ========== FEHLER- & LEERZUSTAND ==========
    public renderError(message: string): void {
        const errorEl = this.pagesContentEl.createDiv({ cls: "pdfcompose-error" });
        errorEl.createEl("strong", { text: "Could not load document: " });
        errorEl.createSpan({ text: message });
    }

    public renderEmptyState(): void {
        this.pagesContentEl.createDiv({
            cls: "pdfcompose-empty-state",
            text: "This document does not yet contain any pages.",
        });
        this.sidebarListEl.createDiv({
            text: "No pages",
            cls: "pdfcompose-empty-sidebar",
        });
    }

    public clearPages(): void {
        this.navLockPageId = null;
        this.sidebarThumbObserver?.disconnect();
        this.sidebarThumbObserver = null;
        this.sidebarThumbTasks.clear();
        this.thumbGeneration++;
        this.currentHighlightedPageId = null;

        this.pagesContentEl.empty();
        this.sidebarListEl.empty();
        this.annotationLayers.clear();
        this.highlightLayers.clear();
        this.pageOverlays.clear();
        this.textBlockLayers.clear();
        this.annotationColumns.clear();
        this.connectorLayers.clear();
        this.pageOrder = [];
    }

    // ========== SUCH-HIGHLIGHTS (im Hauptbereich) ==========
    public clearHighlights(): void {
        for (const overlay of this.pageOverlays.values()) {
            overlay.empty();
        }
        this.highlightEls = [];
    }

    public renderAllHighlights(
        allMatches: { pageId: string; rect: { x: number; y: number; width: number; height: number } }[]
    ): void {
        for (const overlay of this.pageOverlays.values()) {
            overlay.empty();
        }
        this.highlightEls = [];
        for (const match of allMatches) {
            const overlay = this.pageOverlays.get(match.pageId);
            if (!overlay) { this.highlightEls.push(null); continue; }
            const viewportWidth = parseFloat(overlay.dataset.viewportWidth || "0");
            const viewportHeight = parseFloat(overlay.dataset.viewportHeight || "0");
            if (viewportWidth === 0 || viewportHeight === 0) { this.highlightEls.push(null); continue; }
            const scale = parseFloat(overlay.dataset.scale || "1");
            const el = overlay.createDiv({ cls: "pdfcompose-highlight" });
            el.setCssStyles({ left: (match.rect.x * scale) + "px", top: (match.rect.y * scale) + "px", width: (match.rect.width * scale) + "px", height: (match.rect.height * scale) + "px" });
            this.highlightEls.push(el);
        }
    }

    public setActiveHighlight(index: number, scrollIntoView: boolean = true): void {
        this.highlightEls.forEach((el, i) => {
            if (!el) return;
            if (i === index) {
                el.addClass("pdfcompose-highlight-active");
                if (scrollIntoView) {
                    const horizontal = this.plugin.settings.horizontalLayout;
                    el.scrollIntoView({
                        behavior: "smooth",
                        block: horizontal ? "nearest" : "center",
                        inline: horizontal ? "center" : "nearest",
                    });
                }
            } else {
                el.removeClass("pdfcompose-highlight-active");
            }
        });
    }
}

// ========== MODALS (UI-Komponenten) ==========
export class AddSourceModal extends Modal {
    constructor(app: App, private onConfirm: (name: string, path: string) => void) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Add new PDF source" });

        const nameInput = contentEl.createEl("input", { type: "text", placeholder: "Name (e.g., 'attachment')" });

        const pathInput = contentEl.createEl("input");
        pathInput.type = "text";
        pathInput.placeholder = "Path to PDF file";
        pathInput.setAttribute("list", "pdf-files");

        const datalist = contentEl.createEl("datalist");
        datalist.id = "pdf-files";

        const pdfFiles = this.app.vault.getFiles().filter(f => f.extension === "pdf");
        for (const file of pdfFiles) {
            const option = contentEl.createEl("option");
            option.value = file.path;
            option.text = file.name;
            datalist.appendChild(option);
        }

        const saveBtn = contentEl.createEl("button", { text: "Add" });
        saveBtn.addEventListener("click", () => {
            const name = nameInput.value.trim();
            const path = pathInput.value.trim();
            if (name && path) {
                this.onConfirm(name, path);
                this.close();
            }
        });
    }
}

export class AddPageModal extends Modal {
    private static readonly BLANK_KIND = "__blank__";
    private static readonly TEMPLATES_KIND = "__templates__";

    private pageCount = 0;
    private selectedPages = new Set<number>();
    private sizeSelect!: HTMLSelectElement;
    private sizeRow!: HTMLElement;
    private positionSelect!: HTMLSelectElement;
    private positionTargetSelect!: HTMLSelectElement;
    private positionTargetRow!: HTMLElement;
    private thumbnailGrid!: HTMLElement;
    private sourceSelect!: HTMLSelectElement;
    private pageCountEl!: HTMLElement;
    private readonly editPage: PageDefinition | null;
    private readonly singleSelection: boolean;
    private readonly existingPages: PageDefinition[];
    private readonly initialPosition: InsertPosition;
    private templateEntries: { id: string; label: string; kind: "file"; filePath: string }[] = [];

    private rangeInput: HTMLInputElement | null = null;
    private thumbObserver: IntersectionObserver | null = null;
    private thumbTasks: Map<Element, () => Promise<void>> = new Map();
    private thumbPaintQueue: Promise<void> = Promise.resolve();

    constructor(
        app: App,
        private sources: Record<string, string>,
        private renderer: any,
        private templateFolder: string,
        private onConfirm: (result: AddPageResult) => void,
        editPage: PageDefinition | null = null,
        existingPages: PageDefinition[] = [],
        initialPosition: InsertPosition | null = null,
    ) {
        super(app);
        this.editPage = editPage;
        this.singleSelection = editPage !== null;
        this.existingPages = existingPages;
        this.initialPosition = initialPosition ?? { mode: "end" };
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("pdfcompose-add-page-modal");
        contentEl.createEl("h2", {
            text: this.editPage ? "Change source / page" : "Add new page(s)",
        });

        // Source
        const sourceRow = contentEl.createDiv({ cls: "pdfcompose-modal-row" });
        sourceRow.createEl("label", { text: "Source:" });
        this.sourceSelect = sourceRow.createEl("select", { cls: "pdfcompose-modal-select" });
        this.sourceSelect.createEl("option", { text: "Blank page", value: AddPageModal.BLANK_KIND });
        if (this.getTemplateFiles().length > 0) {
            this.sourceSelect.createEl("option", { text: "Templates", value: AddPageModal.TEMPLATES_KIND });
        }
        for (const [name] of Object.entries(this.sources)) {
            this.sourceSelect.createEl("option", { text: name, value: name });
        }
        this.sourceSelect.addEventListener("change", () => void this.onSelectionChange());

        // Format (nur Leerseite)
        this.sizeRow = contentEl.createDiv({ cls: "pdfcompose-modal-row" });
        this.sizeRow.createEl("label", { text: "Format:" });
        this.sizeSelect = this.sizeRow.createEl("select", { cls: "pdfcompose-modal-select" });
        this.sizeSelect.createEl("option", { text: "A4", value: "A4" });
        this.sizeSelect.createEl("option", { text: "Letter", value: "Letter" });
        this.sizeSelect.addEventListener("change", () => {
            if (this.sourceSelect.value === AddPageModal.BLANK_KIND) void this.loadBlankTemplateThumbnails();
        });

        // Position (nur Add-Mode mit bestehenden Seiten)
        if (!this.editPage && this.existingPages.length > 0) {
            const posRow = contentEl.createDiv({ cls: "pdfcompose-modal-row" });
            posRow.createEl("label", { text: "Insert:" });
            this.positionSelect = posRow.createEl("select", { cls: "pdfcompose-modal-select" });
            this.positionSelect.createEl("option", { text: "At the end", value: "end" });
            this.positionSelect.createEl("option", { text: "Before page …", value: "before" });
            this.positionSelect.createEl("option", { text: "After page …", value: "after" });
            this.positionSelect.value = this.initialPosition.mode;
            this.positionSelect.addEventListener("change", () => this.updatePositionTargetVisibility());

            this.positionTargetRow = contentEl.createDiv({ cls: "pdfcompose-modal-row" });
            this.positionTargetRow.createEl("label", { text: "Target:" });
            this.positionTargetSelect = this.positionTargetRow.createEl("select", { cls: "pdfcompose-modal-select" });
            this.existingPages.forEach((p, i) => {
                const label = isPdfPage(p) ? `#${i + 1}: ${p.src} · S. ${p.srcPage}` : `#${i + 1}: Blank page`;
                this.positionTargetSelect.createEl("option", { text: label, value: p.id });
            });
            if (this.initialPosition.targetPageId) this.positionTargetSelect.value = this.initialPosition.targetPageId;
            this.updatePositionTargetVisibility();
        }

        if (!this.singleSelection) {
            const selRow = contentEl.createDiv({ cls: "pdfcompose-modal-row" });
            selRow.createEl("label", { text: "Pages:" });
            this.rangeInput = selRow.createEl("input", {
                type: "text",
                attr: { placeholder: "e.g. 1-3, 5, 8-10" },
            });
            this.rangeInput.setCssStyles({ flex: "1" });
            this.rangeInput.addEventListener("input", () => this.applyRangeInput());
            selRow.createEl("button", { text: "Select all" })
                .addEventListener("click", () => this.selectAllPages());
            selRow.createEl("button", { text: "Select none" })
                .addEventListener("click", () => this.selectNoPages());
        }

        this.pageCountEl = contentEl.createDiv({ cls: "pdfcompose-add-page-count" });
        this.thumbnailGrid = contentEl.createDiv({ cls: "pdfcompose-add-page-thumbnails" });

        const btnRow = contentEl.createDiv({ cls: "pdfcompose-modal-buttons" });
        btnRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
        btnRow.createEl("button", {
            text: this.editPage ? "Apply" : "Add",
            cls: "mod-cta",
        }).addEventListener("click", () => void this.confirm());

        // Edit-Preselect
        if (this.editPage) {
            const ep = this.editPage;
            if (isPdfPage(ep) && this.sources[ep.src] !== undefined) {
                this.sourceSelect.value = ep.src;
            } else {
                this.sourceSelect.value = AddPageModal.BLANK_KIND;
                if (isBlankPage(ep)) {
                    const size = typeof ep.size === "object" ? "A4" : (ep.size ?? "A4");
                    this.sizeSelect.value = size;
                }
            }
        }

        await this.onSelectionChange();
    }

    private applyRangeInput(): void {
        if (!this.rangeInput) return;
        const parsed = new Set<number>();
        for (const token of this.rangeInput.value.split(/[,;\s]+/)) {
            if (!token) continue;
            const m = token.match(/^(\d+)(?:-(\d*))?$/);
            if (!m) continue;
            const a = parseInt(m[1], 10);
            const b = m[2] === undefined ? a : (m[2] === "" ? this.pageCount : parseInt(m[2], 10));
            const lo = Math.max(1, Math.min(a, b));
            const hi = Math.min(this.pageCount, Math.max(a, b));
            for (let i = lo; i <= hi; i++) parsed.add(i);
        }
        this.selectedPages = parsed;
        this.syncCheckboxes();
    }

    private selectAllPages(): void {
        this.selectedPages = new Set(Array.from({ length: this.pageCount }, (_, i) => i + 1));
        this.syncCheckboxes();
    }

    private selectNoPages(): void {
        this.selectedPages.clear();
        this.syncCheckboxes();
    }

    private formatRanges(set: Set<number>): string {
        const nums = Array.from(set).sort((a, b) => a - b);
        const parts: string[] = [];
        let i = 0;
        while (i < nums.length) {
            let j = i;
            while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
            parts.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`);
            i = j + 1;
        }
        return parts.join(", ");
    }

    /** Thumbnails erst zeichnen, wenn sichtbar (wichtig bei PDFs mit hunderten Seiten). */
    private observeLazy(el: HTMLElement, task: () => Promise<void>): void {
        if (!this.thumbObserver) {
            this.thumbObserver = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const t = this.thumbTasks.get(entry.target);
                    this.thumbObserver?.unobserve(entry.target);
                    this.thumbTasks.delete(entry.target);
                    if (t) this.thumbPaintQueue = this.thumbPaintQueue.then(t).catch(() => { /* ignore */ });
                }
            }, { rootMargin: "200px" });
        }
        this.thumbTasks.set(el, task);
        this.thumbObserver.observe(el);
    }

    private updatePositionTargetVisibility(): void {
        if (!this.positionSelect || !this.positionTargetRow) return;
        this.positionTargetRow.setCssStyles({ display: this.positionSelect.value !== "end" ? "" : "none" });
    }

    private getPosition(): InsertPosition {
        if (!this.positionSelect || this.positionSelect.value === "end") return { mode: "end" };
        return {
            mode: this.positionSelect.value as "before" | "after",
            targetPageId: this.positionTargetSelect?.value,
        };
    }

    private getTemplateFiles(): TFile[] {
        if (!this.templateFolder) return [];
        const normalized = this.templateFolder.replace(/\/+$/, "");
        return this.app.vault.getFiles()
            .filter(f => f.extension === "pdf" && (f.path === normalized || f.path.startsWith(normalized + "/")))
            .sort((a, b) => a.basename.localeCompare(b.basename, "de"));
    }

    private getBlankEntries(): { id: BuiltinTemplateId; label: string }[] {
        return BUILTIN_TEMPLATES.map(t => ({ id: t.id, label: t.label }));
    }

    private async onSelectionChange(): Promise<void> {
        this.thumbObserver?.disconnect();
        this.thumbObserver = null;
        this.thumbTasks.clear();

        const value = this.sourceSelect.value;
        this.selectedPages.clear();
        this.thumbnailGrid.empty();
        this.pageCount = 0;

        if (value === AddPageModal.BLANK_KIND) {
            this.sizeRow.setCssStyles({ display: "" });
            await this.loadBlankTemplateThumbnails();
        } else if (value === AddPageModal.TEMPLATES_KIND) {
            this.sizeRow.setCssStyles({ display: "none" });
            await this.loadTemplateFileThumbnails();
        } else {
            this.sizeRow.setCssStyles({ display: "none" });
            await this.loadSourcePageThumbnails(value);
        }

        this.updatePageCountDisplay();

        if (this.editPage) {
            const ep = this.editPage;
            if (value === AddPageModal.BLANK_KIND && isBlankPage(ep)) {
                const entries = this.getBlankEntries();
                const idx = entries.findIndex(e => e.id === (ep.template ?? "blank"));
                if (idx !== -1) { this.selectedPages.add(idx + 1); this.syncCheckboxes(); }
            } else if (isPdfPage(ep) && value === ep.src) {
                this.selectedPages.add(ep.srcPage);
                this.syncCheckboxes();
            }
        }
    }

    private async loadBlankTemplateThumbnails(): Promise<void> {
        const entries = this.getBlankEntries();
        this.pageCount = entries.length;
        const size = (this.sizeSelect?.value ?? "A4") as "A4" | "Letter";
        const dims = PAGE_SIZES[size];
        const scale = 0.14;
        entries.forEach((entry, i) => {
            this.renderThumbnailCard(i + 1, entry.label, (canvas) => {
                canvas.width = dims.width * scale;
                canvas.height = dims.height * scale;
                const ctx = canvas.getContext("2d");
                if (ctx) drawTemplatePattern(ctx, entry.id, dims.width, dims.height, scale);
            });
        });
    }

    private async loadTemplateFileThumbnails(): Promise<void> {
        this.templateEntries = this.getTemplateFiles().map(f => ({
            id: f.path, label: f.basename, kind: "file" as const, filePath: f.path,
        }));
        this.pageCount = this.templateEntries.length;
        const scale = 0.14;
        this.templateEntries.forEach((entry, i) => {
            this.renderThumbnailCard(i + 1, entry.label, async (canvas) => {
                await this.renderer.renderPageToCanvas(entry.filePath, 1, canvas, { scale, rotate: 0 });
            });
        });
    }

    private async loadSourcePageThumbnails(sourceName: string): Promise<void> {
        const path = this.sources[sourceName];
        if (!path) return;
        try {
            const pdfDocument = await this.renderer.getDocument(path);
            this.pageCount = pdfDocument.numPages;
            const scale = 0.14;
            for (let i = 1; i <= this.pageCount; i++) {
                this.renderThumbnailCard(i, `Seite ${i}`, async (canvas) => {
                    await this.renderer.renderPageToCanvas(path, i, canvas, { scale, rotate: 0 });
                });
            }
        } catch (e) {
            this.thumbnailGrid.createDiv({ cls: "pdfcompose-error", text: `PDF could not be loaded: ${String(e)}` });
        }
    }

    private renderThumbnailCard(index: number, label: string, paint: (canvas: HTMLCanvasElement) => void | Promise<void>): void {
        const card = this.thumbnailGrid.createDiv({ cls: "pdfcompose-add-page-thumbnail" });
        card.dataset.index = String(index);
        const checkbox = card.createEl("input", { type: "checkbox", cls: "pdfcompose-add-page-checkbox" });
        checkbox.setAttribute("aria-label", `Select ${label}`);
        const canvas = card.createEl("canvas", { cls: "pdfcompose-thumb-canvas" });
        canvas.width = 84;
        canvas.height = 119;
        card.createDiv({ cls: "pdfcompose-add-page-thumb-label", text: label });

        this.observeLazy(card, async () => {
            try {
                await paint(canvas);
            } catch {
                canvas.remove();
                card.createDiv({ text: "Error", cls: "pdfcompose-thumb-error" });
            }
        });

        const applySelection = (checked: boolean): void => {
            if (checked) {
                if (this.singleSelection) {
                    this.selectedPages.clear();
                    this.thumbnailGrid.querySelectorAll<HTMLInputElement>(".pdfcompose-add-page-checkbox").forEach((other) => {
                        if (other !== checkbox) {
                            other.checked = false;
                            other.closest(".pdfcompose-add-page-thumbnail")?.removeClass("pdfcompose-thumb-selected");
                        }
                    });
                }
                this.selectedPages.add(index);
                card.addClass("pdfcompose-thumb-selected");
            } else {
                this.selectedPages.delete(index);
                card.removeClass("pdfcompose-thumb-selected");
            }
            this.updatePageCountDisplay();
        };

        checkbox.addEventListener("change", (e) => { e.stopPropagation(); applySelection(checkbox.checked); });
        card.addEventListener("click", (e) => {
            if (e.target === checkbox) return;
            checkbox.checked = !checkbox.checked;
            applySelection(checkbox.checked);
        });
    }

    private syncCheckboxes(): void {
        this.thumbnailGrid.querySelectorAll<HTMLInputElement>(".pdfcompose-add-page-checkbox").forEach((cb) => {
            const card = cb.closest<HTMLElement>(".pdfcompose-add-page-thumbnail");
            const idx = card ? Number(card.dataset.index ?? "0") : 0;
            const shouldBeChecked = this.selectedPages.has(idx);
            cb.checked = shouldBeChecked;
            card?.toggleClass("pdfcompose-thumb-selected", shouldBeChecked);
        });
        this.updatePageCountDisplay();
    }

    private updatePageCountDisplay(): void {
        if (this.rangeInput && this.rangeInput.ownerDocument.activeElement !== this.rangeInput) {
            this.rangeInput.value = this.formatRanges(this.selectedPages);
        }
        if (!this.pageCountEl) return;
        if (this.pageCount === 0) { this.pageCountEl.setText(""); return; }
        const value = this.sourceSelect.value;
        const kindLabel = value === AddPageModal.BLANK_KIND ? "Templates"
            : value === AddPageModal.TEMPLATES_KIND ? "Files"
                : "Pages";
        let text = `${this.pageCount} ${kindLabel}`;
        if (this.selectedPages.size > 0) text += ` · ${this.selectedPages.size} selected`;
        this.pageCountEl.setText(text);
    }

    private buildUniqueSourceName(base: string): string {
        if (!(base in this.sources)) return base;
        let counter = 2;
        while (`${base} ${counter}` in this.sources) counter++;
        return `${base} ${counter}`;
    }

    private async confirm(): Promise<void> {
        const value = this.sourceSelect.value;
        const kind: "blank" | "templates" | "source" =
            value === AddPageModal.BLANK_KIND ? "blank"
                : value === AddPageModal.TEMPLATES_KIND ? "templates"
                    : "source";

        const sortedIdx = Array.from(this.selectedPages).sort((a, b) => a - b);

        if (this.editPage) {
            if (sortedIdx.length !== 1) {
                new Notice(kind === "source" ? "Please select exactly one page." : "Please select exactly one template.");
                return;
            }
            const idx = sortedIdx[0];

            if (kind === "blank") {
                const entry = this.getBlankEntries()[idx - 1];
                if (!entry) { new Notice("Invalid template selected."); return; }
                this.onConfirm({ kind: "blank", template: entry.id, size: this.sizeSelect.value as "A4" | "Letter" });
                this.close();
                return;
            }
            if (kind === "templates") {
                const entry = this.templateEntries[idx - 1];
                if (!entry) { new Notice("Invalid template selected."); return; }
                const sourceName = this.buildUniqueSourceName(entry.label);
                this.onConfirm({ kind: "pdf", sourceName, sourcePath: entry.filePath, isNewSource: true, pages: [1] });
                this.close();
                return;
            }
            const sourceName = value;
            const sourcePath = this.sources[sourceName];
            if (!sourcePath) { new Notice("The selected source does not exist."); return; }
            this.onConfirm({ kind: "pdf", sourceName, sourcePath, isNewSource: false, pages: [idx] });
            this.close();
            return;
        }

        // Add-Mode
        if (sortedIdx.length === 0) {
            new Notice(kind === "source" ? "Please select at least one page." : "Please select at least one template.");
            return;
        }
        const position = this.getPosition();

        if (kind === "blank") {
            const entries = this.getBlankEntries();
            if (sortedIdx.length === 1) {
                const entry = entries[sortedIdx[0] - 1];
                if (!entry) { new Notice("Invalid template selected."); return; }
                this.onConfirm({ kind: "blank", template: entry.id, size: this.sizeSelect.value as "A4" | "Letter", position });
            } else {
                const selections: TemplateSelection[] = sortedIdx.map(i => {
                    const entry = entries[i - 1];
                    return { kind: "builtin", templateId: entry.id, size: this.sizeSelect.value as "A4" | "Letter" };
                });
                this.onConfirm({ kind: "templates", entries: selections, position });
            }
            this.close();
            return;
        }
        if (kind === "templates") {
            const selections: TemplateSelection[] = sortedIdx.map(i => {
                const entry = this.templateEntries[i - 1];
                return { kind: "file", filePath: entry.filePath, sourceName: this.buildUniqueSourceName(entry.label), page: 1 };
            });
            this.onConfirm({ kind: "templates", entries: selections, position });
            this.close();
            return;
        }
        const sourceName = value;
        this.onConfirm({
            kind: "pdf", sourceName, sourcePath: this.sources[sourceName],
            isNewSource: false, pages: sortedIdx, position,
        });
        this.close();
    }

    onClose(): void {
        this.thumbObserver?.disconnect();
        this.thumbObserver = null;
        this.thumbTasks.clear();
        this.contentEl.empty();
    }
}

export class TextDisplayModal extends Modal {
    constructor(app: App, private text: string) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Page Text" });
        const pre = contentEl.createEl("pre");
        pre.setText(this.text);
        pre.setCssStyles({ whiteSpace: "pre-wrap", maxHeight: "400px", overflow: "auto" });
        const copyBtn = contentEl.createEl("button", { text: "Copy to Clipboard" });
        copyBtn.addEventListener("click", async () => {
            await navigator.clipboard.writeText(this.text);
        });
    }
}

export class TextBlockEditModal extends Modal {
    private markdown: string;
    private fontScale: number;
    private saved: boolean = false;

    constructor(
        app: App,
        private entry: TextBlockEntry,
        private handlers: {
            onSave: (entry: TextBlockEntry) => void | Promise<void>;
            onCopy: (entry: TextBlockEntry) => void | Promise<void>;
            onDelete: () => void | Promise<void>;
            onCancel?: () => void | Promise<void>;
        }
    ) {
        super(app);

        this.markdown = entry.markdown;
        this.fontScale = entry.fontScale;
    }

    onOpen(): void {
        const { contentEl } = this;

        contentEl.createEl("h2", {
            text: "Edit Textblock",
        });

        // ---------------------------------------------------------
        // Schriftgröße
        // ---------------------------------------------------------
        const fontRow = contentEl.createDiv({
            cls: "pdfcompose-panel-row pdfcompose-textblock-font-row",
        });

        fontRow.createEl("label", {
            text: "Font size:",
        });

        const scaleInput = fontRow.createEl("input", {
            type: "range",
            cls: "pdfcompose-textblock-font-slider",
            attr: {
                min: "10",
                max: "500",
                step: "5",
            },
        });

        scaleInput.value = String(this.fontScale);

        const scaleValue = fontRow.createEl("span", {
            cls: "pdfcompose-textblock-font-value",
            text: `${Math.round(this.fontScale)} %`,
        });

        scaleInput.addEventListener("input", () => {
            this.fontScale = Math.max(
                10,
                Math.min(500, Number(scaleInput.value) || 100)
            );

            scaleValue.setText(`${Math.round(this.fontScale)} %`);
        });

        // ---------------------------------------------------------
        // Markdown
        // ---------------------------------------------------------
        const textarea = contentEl.createEl("textarea", {
            cls: "pdfcompose-textblock-editor",
        });

        textarea.value = this.markdown;
        textarea.rows = 12;
        textarea.setCssStyles({ width: "100%" });

        textarea.addEventListener("input", () => {
            this.markdown = textarea.value;
        });

        // ---------------------------------------------------------
        // Buttons
        // ---------------------------------------------------------
        const btnRow = contentEl.createDiv({
            cls: "pdfcompose-panel-row pdfcompose-textblock-button-row",
        });

        const saveBtn = btnRow.createEl("button", {
            text: "Save",
            cls: "pdfcompose-tool-btn",
        });

        saveBtn.addEventListener("click", async () => {
            this.saved = true;

            await this.handlers.onSave({
                ...this.entry,
                fontScale: this.fontScale,
                markdown: this.markdown,
            });

            this.close();
        });

        const copyBtn = btnRow.createEl("button", {
            text: "Copy",
            cls: "pdfcompose-tool-btn",
        });

        copyBtn.addEventListener("click", async () => {
            await this.handlers.onCopy({
                ...this.entry,
                fontScale: this.fontScale,
                markdown: this.markdown,
            });

            new Notice("Textblock copied");
        });

        const deleteBtn = btnRow.createEl("button", {
            text: "Delete",
            cls: "pdfcompose-tool-btn",
        });

        deleteBtn.addEventListener("click", async () => {
            this.saved = true;

            await this.handlers.onDelete();

            this.close();
        });

        const cancelBtn = btnRow.createEl("button", {
            text: "Cancel",
            cls: "pdfcompose-tool-btn",
        });

        cancelBtn.addEventListener("click", () => {
            this.close();
        });
    }

    onClose(): void {
        this.contentEl.empty();

        if (!this.saved && this.handlers.onCancel) {
            void this.handlers.onCancel();
        }
    }
}

export class PdfAnnotationEditModal extends Modal {
    private color: string;
    private width: number;
    private fontScale: number;
    private connector: ConnectorStyle;
    private markdown: string;
    private saved: boolean = false;

    constructor(
        app: App,
        private entry: PdfAnnotationEntry,
        private handlers: {
            onSave: (entry: PdfAnnotationEntry) => void | Promise<void>;
            onDelete: () => void | Promise<void>;
            onCancel?: () => void | Promise<void>;
            onAdjustRange?: (entry: PdfAnnotationEntry) => void | Promise<void>;
        }
    ) {
        super(app);
        this.color = entry.color;
        this.width = entry.width;
        this.fontScale = entry.fontScale;
        this.connector = entry.connector;
        this.markdown = entry.markdown;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Edit Annotation" });

        const row1 = contentEl.createDiv({ cls: "pdfcompose-panel-row" });
        row1.createEl("label", { text: "Color:" });
        const colorInput = row1.createEl("input", { type: "color" });
        colorInput.value = this.color;
        colorInput.addEventListener("input", () => { this.color = colorInput.value; });

        row1.createEl("label", { text: "Connection:" });
        const connectorSelect = row1.createEl("select");
        for (const [value, label] of [
            ["none", "None"], ["straight", "Straight"], ["curve", "Curve"], ["step", "Step"],
        ] as const) {
            const opt = connectorSelect.createEl("option", { text: label, value });
            if (value === this.connector) opt.selected = true;
        }
        connectorSelect.addEventListener("change", () => {
            this.connector = connectorSelect.value as ConnectorStyle;
        });

        const row2 = contentEl.createDiv({ cls: "pdfcompose-panel-row" });
        row2.createEl("label", { text: "Width:" });
        const widthInput = row2.createEl("input", { type: "number" });
        widthInput.value = this.width.toFixed(1);
        widthInput.addEventListener("input", () => {
            this.width = Math.max(80, parseFloat(widthInput.value) || 80);
        });

        // Schriftgröße als Slider - identisch zum Textblock-Dialog
        const fontRow = contentEl.createDiv({
            cls: "pdfcompose-panel-row pdfcompose-textblock-font-row",
        });
        fontRow.createEl("label", { text: "Font size:" });
        const scaleInput = fontRow.createEl("input", {
            type: "range",
            cls: "pdfcompose-textblock-font-slider",
            attr: { min: "10", max: "500", step: "5" },
        });
        scaleInput.value = String(this.fontScale);
        const scaleValue = fontRow.createEl("span", {
            cls: "pdfcompose-textblock-font-value",
            text: `${Math.round(this.fontScale)} %`,
        });
        scaleInput.addEventListener("input", () => {
            this.fontScale = Math.max(10, Math.min(500, Number(scaleInput.value) || 100));
            scaleValue.setText(`${Math.round(this.fontScale)} %`);
        });

        const textarea = contentEl.createEl("textarea");
        textarea.value = this.markdown;
        textarea.rows = 10;
        textarea.setCssStyles({ width: "100%" });
        textarea.addEventListener("input", () => { this.markdown = textarea.value; });

        const btnRow = contentEl.createDiv({ cls: "pdfcompose-panel-row" });
        const saveBtn = btnRow.createEl("button", { text: "Save", cls: "pdfcompose-tool-btn" });
        saveBtn.addEventListener("click", async () => {
            this.saved = true;
            await this.handlers.onSave({
                ...this.entry,
                color: this.color, width: this.width, fontScale: this.fontScale,
                connector: this.connector, markdown: this.markdown,
            });
            this.close();
        });

        if (this.handlers.onAdjustRange) {
            const rangeBtn = btnRow.createEl("button", { text: "Adjust range", cls: "pdfcompose-tool-btn" });
            rangeBtn.addEventListener("click", async () => {
                this.saved = true;
                const updated: PdfAnnotationEntry = {
                    ...this.entry,
                    color: this.color, width: this.width, fontScale: this.fontScale,
                    connector: this.connector, markdown: this.markdown,
                };
                await this.handlers.onSave(updated);
                this.close();
                await this.handlers.onAdjustRange!(updated);
            });
        }

        const deleteBtn = btnRow.createEl("button", { text: "Delete", cls: "pdfcompose-tool-btn" });
        deleteBtn.addEventListener("click", async () => {
            this.saved = true;
            await this.handlers.onDelete();
            this.close();
        });

        const cancelBtn = btnRow.createEl("button", { text: "Cancel", cls: "pdfcompose-tool-btn" });
        cancelBtn.addEventListener("click", () => this.close());
    }

    onClose() {
        this.contentEl.empty();
        if (!this.saved && this.handlers.onCancel) {
            void this.handlers.onCancel();
        }
    }
}

export class ChangeSourcePathModal extends Modal {
    private selectedPath: string;
    private readonly suggestions: string[];

    constructor(
        app: App,
        private readonly sourceName: string,
        private readonly currentPath: string,
        suggestions: string[],
        private readonly onConfirm: (path: string) => void | Promise<void>,
    ) {
        super(app);

        this.selectedPath = currentPath;
        this.suggestions = suggestions;
    }

    onOpen(): void {
        const { contentEl } = this;

        contentEl.empty();

        contentEl.createEl("h2", {
            text: "Adjust Source File Path",
        });

        contentEl.createEl("p", {
            text: `Source: ${this.sourceName}`,
        });

        const currentFile =
            this.app.vault.getAbstractFileByPath(
                this.currentPath
            );

        if (!(currentFile instanceof TFile)) {
            const warning = contentEl.createDiv({
                cls: "pdfcompose-source-warning",
            });

            warning.createEl("strong", {
                text: "Current path not found",
            });

            warning.createEl("div", {
                text: this.currentPath,
            });

            if (this.suggestions.length > 0) {
                contentEl.createEl("p", {
                    text:
                        "Possible replacement files were found:",
                });
            } else {
                contentEl.createEl("p", {
                    text:
                        "No similar PDF files were found. " +
                        "You can enter the path manually.",
                });
            }
        }

        const pathInput = contentEl.createEl("input", {
            type: "text",
            cls: "pdfcompose-source-path-input",
            attr: {
                placeholder: "Path to PDF file",
            },
        });

        pathInput.value =
            this.suggestions[0] ??
            this.currentPath;

        this.selectedPath = pathInput.value;

        const datalist = contentEl.createEl("datalist");

        datalist.id =
            `pdfcompose-source-paths-${Date.now()}`;

        pathInput.setAttribute(
            "list",
            datalist.id
        );

        const allSuggestions = [
            ...this.suggestions,
            ...this.app.vault
                .getFiles()
                .filter(
                    file =>
                        file.extension.toLowerCase() ===
                        "pdf"
                )
                .map(file => file.path),
        ];

        const seen = new Set<string>();

        for (const path of allSuggestions) {
            if (seen.has(path)) continue;
            seen.add(path);

            const option =
                datalist.createEl("option");

            option.value = path;
        }

        if (this.suggestions.length > 0) {
            const suggestionBox =
                contentEl.createDiv({
                    cls: "pdfcompose-source-suggestions",
                });

            suggestionBox.createEl("div", {
                text: "Suggestions:",
                cls: "pdfcompose-source-suggestions-title",
            });

            for (const path of this.suggestions) {
                const button =
                    suggestionBox.createEl("button", {
                        cls: "pdfcompose-source-suggestion",
                    });

                button.createEl("strong", {
                    text: path
                        .split("/")
                        .pop() ?? path,
                });

                button.createEl("small", {
                    text: path,
                });

                button.addEventListener(
                    "click",
                    () => {
                        pathInput.value = path;
                        this.selectedPath = path;
                    }
                );
            }
        }

        const buttons =
            contentEl.createDiv({
                cls: "pdfcompose-modal-buttons",
            });

        const cancel =
            buttons.createEl("button", {
                text: "Cancel",
            });

        cancel.addEventListener(
            "click",
            () => this.close()
        );

        const save =
            buttons.createEl("button", {
                text: "Accept Path",
                cls: "mod-cta",
            });

        save.addEventListener(
            "click",
            () => {
                const path =
                    pathInput.value.trim();

                if (!path) {
                    new Notice(
                        "Please specify a PDF path."
                    );
                    return;
                }

                const file =
                    this.app.vault.getAbstractFileByPath(
                        path
                    );

                if (!(file instanceof TFile)) {
                    new Notice(
                        "The specified PDF file was not found in the vault."
                    );
                    return;
                }

                if (
                    file.extension.toLowerCase() !==
                    "pdf"
                ) {
                    new Notice(
                        "The source must be a PDF file."
                    );
                    return;
                }

                this.selectedPath = path;

                void Promise.resolve(
                    this.onConfirm(path)
                ).then(() => {
                    this.close();
                });
            }
        );
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

export type SourceDeleteMode =
    | "delete-pages"
    | "replace-pages";

export interface SourceDeleteResult {
    mode: SourceDeleteMode;
    template?: BuiltinTemplateId;
}

export class SourceDeleteModal extends Modal {
    private mode: SourceDeleteMode = "delete-pages";
    private template: BuiltinTemplateId = "blank";

    constructor(
        app: App,
        private readonly sourceName: string,
        private readonly affectedPageCount: number,
        private readonly onConfirm: (
            result: SourceDeleteResult
        ) => void | Promise<void>,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;

        contentEl.empty();

        contentEl.createEl("h2", {
            text: "Delete Source",
        });

        contentEl.createEl("p", {
            text:
                `The source "${this.sourceName}" is used on ` +
                `${this.affectedPageCount} ` +
                `page${this.affectedPageCount === 1 ? "" : "s"}.`,
        });

        contentEl.createEl("p", {
            text:
                "What should happen to these pages?",
        });

        const deleteOption =
            contentEl.createDiv({
                cls: "pdfcompose-source-delete-option",
            });

        const deleteRadio =
            deleteOption.createEl("input", {
                type: "radio",
                attr: {
                    name: "pdfcompose-source-delete-mode",
                },
            });

        deleteRadio.checked = true;

        deleteOption.createEl("label", {
            text: "Delete associated pages",
        });

        deleteOption.addEventListener(
            "click",
            () => {
                deleteRadio.checked = true;
                replaceRadio.checked = false;

                this.mode = "delete-pages";

                templateRow.setCssStyles({ display: "none" });
            }
        );

        const replaceOption =
            contentEl.createDiv({
                cls: "pdfcompose-source-delete-option",
            });

        const replaceRadio =
            replaceOption.createEl("input", {
                type: "radio",
                attr: {
                    name: "pdfcompose-source-delete-mode",
                },
            });

        replaceOption.createEl("label", {
            text:
                "Replace associated pages with a template",
        });

        replaceOption.addEventListener(
            "click",
            () => {
                replaceRadio.checked = true;
                deleteRadio.checked = false;

                this.mode = "replace-pages";

                templateRow.setCssStyles({ display: "" });
            }
        );

        const templateRow =
            contentEl.createDiv({
                cls: "pdfcompose-source-template-row",
            });

        templateRow.setCssStyles({ display: "none" });

        templateRow.createEl("label", {
            text: "Template:",
        });

        const templateSelect =
            templateRow.createEl("select");

        for (const template of BUILTIN_TEMPLATES) {
            const option =
                templateSelect.createEl("option");

            option.value = template.id;
            option.textContent = template.label;
        }

        templateSelect.value = this.template;

        templateSelect.addEventListener(
            "change",
            () => {
                this.template =
                    templateSelect.value as BuiltinTemplateId;
            }
        );

        const buttons =
            contentEl.createDiv({
                cls: "pdfcompose-modal-buttons",
            });

        const cancel =
            buttons.createEl("button", {
                text: "Cancel",
            });

        cancel.addEventListener(
            "click",
            () => this.close()
        );

        const confirm =
            buttons.createEl("button", {
                text: "Delete Source",
                cls: "mod-warning",
            });

        confirm.addEventListener(
            "click",
            () => {
                void Promise.resolve(
                    this.onConfirm({
                        mode: this.mode,
                        template:
                            this.mode === "replace-pages"
                                ? this.template
                                : undefined,
                    })
                ).then(() => {
                    this.close();
                });
            }
        );
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

export interface ExportPdfOptions {
    pageIds: string[];
    colorMode: ColorMode;
}

export class ExportPdfModal extends Modal {
    private selected: Set<string>;
    private colorMode: ColorMode = "original";

    constructor(
        app: App,
        private pages: { id: string; label: string }[],
        private onConfirm: (options: ExportPdfOptions) => void
    ) {
        super(app);
        this.selected = new Set(pages.map(p => p.id));
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Export as PDF" });

        const colorRow = contentEl.createDiv({ cls: "pdfcompose-panel-row" });
        colorRow.createEl("label", { text: "Color Mode:" });
        const colorSelect = colorRow.createEl("select");
        for (const [value, label] of [["original", "Original"], ["light", "Light"], ["dark", "Dark"]] as const) {
            colorSelect.createEl("option", { text: label, value });
        }
        colorSelect.addEventListener("change", () => { this.colorMode = colorSelect.value as ColorMode; });

        const selectRow = contentEl.createDiv({ cls: "pdfcompose-selection-row" });
        const selectAllBtn = selectRow.createEl("button", { text: "Select All", cls: "pdfcompose-sidebar-btn" });
        const selectNoneBtn = selectRow.createEl("button", { text: "Select None", cls: "pdfcompose-sidebar-btn" });

        const listEl = contentEl.createDiv({ cls: "pdfcompose-export-page-list" });
        listEl.setCssStyles({ maxHeight: "320px", overflowY: "auto", marginTop: "10px" });

        const checkboxes: HTMLInputElement[] = [];
        this.pages.forEach((p, idx) => {
            const row = listEl.createDiv({ cls: "pdfcompose-panel-row" });
            const cb = row.createEl("input", { type: "checkbox" });
            cb.checked = this.selected.has(p.id);
            cb.addEventListener("change", () => {
                if (cb.checked) this.selected.add(p.id);
                else this.selected.delete(p.id);
            });
            checkboxes.push(cb);
            row.createEl("span", { text: `${idx + 1}. ${p.label}` });
        });

        selectAllBtn.addEventListener("click", () => {
            this.selected = new Set(this.pages.map(p => p.id));
            checkboxes.forEach(cb => cb.checked = true);
        });
        selectNoneBtn.addEventListener("click", () => {
            this.selected.clear();
            checkboxes.forEach(cb => cb.checked = false);
        });

        const btnRow = contentEl.createDiv({ cls: "pdfcompose-modal-buttons" });
        const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
        cancelBtn.addEventListener("click", () => this.close());
        const exportBtn = btnRow.createEl("button", { text: "Export", cls: "mod-cta" });
        exportBtn.addEventListener("click", () => {
            const orderedIds = this.pages.map(p => p.id).filter(id => this.selected.has(id));
            if (orderedIds.length === 0) {
                new Notice("Please select at least one page.");
                return;
            }
            this.onConfirm({ pageIds: orderedIds, colorMode: this.colorMode });
            this.close();
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

export interface LabelEditResult {
    text: string;
    fontSize: number;
    color: string;
    mode?: "inline" | "box";
}

export class LabelEditModal extends Modal {
    private text: string;
    private fontSize: number;
    private color: string;
    private mode: "inline" | "box";

    constructor(
        app: App,
        private isLine: boolean,
        initial: { text: string; fontSize?: number; color?: string; mode?: "inline" | "box" },
        private onSave: (result: LabelEditResult) => void | Promise<void>,
        private onDelete: () => void | Promise<void>,
    ) {
        super(app);
        this.text = initial.text ?? "";
        this.fontSize = initial.fontSize ?? 14;
        this.color = initial.color ?? "#1a1a1a";
        this.mode = initial.mode ?? "inline";
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: this.isLine ? "Label for the Line" : "Text in Form" });

        const textarea = contentEl.createEl("textarea", { attr: { rows: "4" } });
        textarea.setCssStyles({ width: "100%" });
        textarea.value = this.text;
        textarea.addEventListener("input", () => { this.text = textarea.value; });

        const row1 = contentEl.createDiv({ cls: "pdfcompose-panel-row" });
        row1.createEl("label", { text: "Font Size:" });
        const sizeInput = row1.createEl("input", { type: "number", attr: { min: "6", max: "72", step: "1" } });
        sizeInput.value = String(this.fontSize);
        sizeInput.addEventListener("input", () => {
            this.fontSize = Math.max(6, parseFloat(sizeInput.value) || 14);
        });

        row1.createEl("label", { text: "Color:" });
        const colorInput = row1.createEl("input", { type: "color" });
        colorInput.value = this.color;
        colorInput.addEventListener("input", () => { this.color = colorInput.value; });

        if (this.isLine) {
            const row2 = contentEl.createDiv({ cls: "pdfcompose-panel-row" });
            row2.createEl("label", { text: "Appearance:" });
            const modeSelect = row2.createEl("select");
            for (const [value, label] of [["inline", "Inline"], ["box", "Box"]] as const) {
                const opt = modeSelect.createEl("option", { text: label, value });
                if (value === this.mode) opt.selected = true;
            }
            modeSelect.addEventListener("change", () => { this.mode = modeSelect.value as "inline" | "box"; });
        }

        const btnRow = contentEl.createDiv({ cls: "pdfcompose-modal-buttons" });
        const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
        cancelBtn.addEventListener("click", () => this.close());
        const deleteBtn = btnRow.createEl("button", { text: "Delete Text" });
        deleteBtn.addEventListener("click", async () => {
            await this.onDelete();
            this.close();
        });
        const saveBtn = btnRow.createEl("button", { text: "Save", cls: "mod-cta" });
        saveBtn.addEventListener("click", async () => {
            if (!this.text.trim()) { await this.onDelete(); this.close(); return; }
            await this.onSave({ text: this.text, fontSize: this.fontSize, color: this.color, mode: this.mode });
            this.close();
        });
    }

    onClose(): void { this.contentEl.empty(); }
}