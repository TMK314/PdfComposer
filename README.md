# PDF Compose

**PDF Compose** is an Obsidian plugin that lets you combine PDF pages and blank notebook pages into a single document, draw and annotate on them, search everything (including your handwriting), and export the result back to a standalone PDF — all stored as a normal Markdown note in your vault.

---

## Table of contents

- [Key features](#key-features)
- [Getting started](#getting-started)
- [Working with pages](#working-with-pages)
- [Annotation tools](#annotation-tools)
- [Text blocks](#text-blocks)
- [PDF annotations (highlight + comment)](#pdf-annotations-highlight--comment)
- [Handwriting recognition (OCR)](#handwriting-recognition-ocr)
- [Full-text search](#full-text-search)
- [Dark mode & color filters](#dark-mode--color-filters)
- [Zoom, layout & touch/stylus support](#zoom-layout--touchstylus-support)
- [Exporting to PDF](#exporting-to-pdf)
- [Undo / redo](#undo--redo)
- [Settings reference](#settings-reference)
- [Compatibility notes](#compatibility-notes)
- [Known limitations](#known-limitations)
- [License](#license)

---

## Key features

- 📄 **Compose documents from multiple PDFs and blank pages** — mix pages from any number of source PDFs plus built-in blank/grid/lined templates, in any order.
- ✍️ **Freehand drawing** with pressure-sensitive pens (fineliner, fountain pen, pencil, charcoal, brush, two highlighters).
- 🔷 **Shapes & connectors** — lines, arrows, polygons, rectangles, triangles, diamonds, ellipses, with fill, styling, and text labels; arrows can be attached to a shape so they follow it when moved.
- 📝 **Markdown text blocks** placed freely on top of a page.
- 🖍️ **PDF text highlighting + comment boxes**, connected with a line, similar to margin notes on paper.
- 🔍 **Offline handwriting recognition (OCR)** for your pen strokes — no cloud services involved.
- 🔎 **Fuzzy full-text search** across PDF text, handwriting (OCR), text blocks, and PDF annotations, with adjustable typo tolerance.
- 🌓 **Dark mode & color filters**, with per-page override and automatic protection of embedded images from inversion.
- 🗂️ **Full page management** — reorder, multi-select, copy/cut/paste, rotate, insert, and swap a page's source.
- 📤 **Export to a standalone PDF**, vector-based, including your strokes, shapes, text blocks, and comments.
- ↩️ **Undo/redo** for essentially every action.
- 🔎 **Smooth zooming & panning**, pinch-to-zoom, and an optional "stylus only draws" mode so fingers can scroll while a pen draws.

A PDF Compose document is a regular Markdown note (marked with `pdfcompose: true` in its frontmatter). This means it stays searchable, versionable with git, and can always be opened as plain Markdown (pane menu → *Open as Markdown*) if you ever need the raw content.

---

## Getting started

1. **Create a new document** — ribbon icon or command *"Create new PDF Compose file"*.
2. **Add a source PDF** — *Sources* tab in the sidebar → *Add PDF source* → pick a name and the PDF file.
3. **Add pages** — *Add page* in the *Pages* tab (or a page's context menu → *Insert page before/after*) to pick pages from a source PDF, a blank template, or a reusable template file.
4. **Draw / annotate** — pick a tool from the annotation toolbar and start marking up the page.
5. **Export** — use the pane menu or command palette's *Export as PDF* whenever you want a standalone file to share.

---

## Working with pages

- **Sidebar page list** — thumbnails, drag & drop reordering, multi-select (Shift/Ctrl-click), and a context menu (⋮) for delete, copy, rotate, insert, paste, change source, and show extracted page text.
- **Add page dialog** — choose a source PDF (with a page picker and thumbnails), a built-in blank template, or a file from your configured *template folder*; multiple pages can be selected and inserted at once, at a chosen position.
- **Template folder** — a vault folder (configured in settings) of PDF files offered as reusable "blank page" templates everywhere pages can be added.
- **Rotate / invert per page** — pages can be rotated in 90° steps and individually flagged to override the global color mode.
- **Change source / page** — swap which PDF page a Compose page points to without losing your annotations.
- **Cross-page move** — drag a selection of drawn objects or text blocks from one page onto another.

---

## Annotation tools

| Tool group | Contents |
|---|---|
| **Pointer** | Selection/inspection mode; also enables native PDF text selection. |
| **Pen** | 8 presets: Fineliner, Fountain pen, Pencil, Red fineliner, Charcoal, Brush, Yellow highlighter, Blue highlighter — each with its own color, width, and pressure curve, fully customizable. |
| **Shapes** | Line, Arrow, Polygon, Rectangle, Diamond, Equilateral triangle, Right triangle, Ellipse — with fill, stroke, and optional highlighter blending. |
| **Selection** | Rectangle or lasso selection, with a "touched" vs. "fully contained" mode and per-type filters (strokes, highlighters, shapes, annotations, text blocks). |
| **Eraser** | Independently toggle which content types it erases. |
| **Text** | Drag out a Markdown text block anywhere on the page. |

Additional useful behaviors:

- **Pressure sensitivity** per pen, with a configurable minimum width and response curve.
- **Curved / stepped connectors** for lines, arrows, and polygons, editable per point via double-click (add point) or right-click / long-press (delete point).
- **Endpoint binding** — drag a line/arrow endpoint onto a shape to bind it; the connector then follows the shape if it's moved, resized, or rotated.
- **Labels** — double-click a shape, line, or arrow to add a text label.
- **Transform handles** — rotate and scale a selection; hold Shift for 15° rotation steps and uniform scaling.
- **Copy / cut / paste / delete** for the current selection, including across pages.

---

## Text blocks

Freely positioned Markdown content rendered directly on top of a page (notes, links, images), with adjustable width and font size, edited through a small pop-up editor. An empty block is discarded automatically if you cancel without typing anything.

---

## PDF annotations (highlight + comment)

Select text inside a PDF page (mouse drag, touch long-press, or pen drag) to get:

- an **"Annotate"** action that highlights the selected text, plus
- a **comment box** in a column to the right of the page, connected to the highlight by a line (style configurable: none / straight / curve / step).

Comment boxes support Markdown content, adjustable width and font size, and can be dragged vertically without moving the underlying highlight. A "Copy" action on the text-selection toolbar copies the selected PDF text to your clipboard.

---

## Handwriting recognition (OCR)

PDF Compose can recognize your handwritten pen strokes into searchable text, fully offline — no cloud calls.

### Setup

1. Open plugin settings → **OCR (handwriting recognition)** and enable it.
2. Download the model and character table via the built-in **Download** buttons (defaults point to a ready-to-use model), or supply your own compatible model and character table.
3. Fine-tune recognition with the **Line factor**, **Word factor**, **Fragment rescue factor**, **Interpolation spacing**, and **Minimum confidence** sliders — the defaults work well for typical handwriting; see the in-app tooltips for what each one does.
4. Choose whether OCR should run **in the background** (when idle) and/or **automatically before a search**.

You can also trigger OCR manually per page (page context menu → *Run OCR*), for the whole document (*OCR for all pages* / *Re-run OCR completely*), or via the command palette. Recognized words are searchable both through PDF Compose's own search and Obsidian's regular full-text search.

The *Search* tab has a **"Show bounding boxes"** toggle to visualize which strokes were recognized as which word — useful for tuning the line/word factors above.

### Training your own handwriting model

The command **"OCR: Collect training data (own handwriting)"** opens a modal that shows you a series of words to trace (several built-in word lists, or your own custom list) and exports the raw samples as JSON, for training a model on your own handwriting style.

For a step-by-step guide on training your own OCR model, see:
**https://github.com/TMK314/TrainOcrModel-Guide**

### Model license

The pre-filled default model is licensed **non-commercial (CC BY-NC-SA 4.0)**, with an additional "No Distribution" clause for its underlying training dataset. This applies only to the downloaded model file, not to the plugin itself — see **Settings → OCR → Model license** for the full summary and link. Commercial use requires training or supplying your own model.

---

## Full-text search

The *Search* tab searches across:

1. **PDF text**,
2. **Handwriting (OCR)** results,
3. **Text blocks**, and
4. **PDF annotations** (comment content).

Search is typo-tolerant, with independently configurable tolerance for regular text vs. handwriting (handwriting recognition is more error-prone, so a higher tolerance is recommended there). Results are grouped by category with a preview, and can be stepped through with **Previous / Next**.

---

## Dark mode & color filters

Configurable in settings, under **Dark mode**:

- Toggle whether color filters apply in light mode, dark mode, or both.
- **Shift hue** — rotate the display hue; 0° is a classic inversion.
- **Monochrome tint** — render dark mode in a single hue instead of full-color inversion.
- **Dim white / Lighten black** sliders for finer brightness control.
- Any page automatically gets readable dark-mode colors regardless of whether its source PDF is naturally light or dark, and embedded images are excluded from inversion so photos don't look like negatives.
- Any individual page's color handling can be manually overridden via the "Invert brightness" action.

---

## Zoom, layout & touch/stylus support

- **Zoom** via `Ctrl/Cmd + Scroll`, `Ctrl/Cmd + +/-/0`, the on-screen zoom control, or pinch-to-zoom.
- **Scroll direction** — switch between vertical (default) and horizontal page layout.
- **Stylus-only drawing** — when enabled (default), finger touches only scroll/pan/pinch-zoom; only a stylus or mouse draws, erases, or selects.
- Long documents stay responsive thanks to on-demand page rendering.

---

## Exporting to PDF

*Export as PDF* (pane menu, ribbon, or command palette) produces a standalone, vector-based PDF:

- Source PDF pages are copied unchanged, preserving text selectability and image quality.
- Your strokes, shapes, and labels are exported as vector graphics, not as a raster image.
- Text blocks keep basic Markdown formatting (bold, italic, inline code, headings, bullet lists).
- PDF annotations become real PDF comment annotations, plus the highlight.
- You choose which pages to include and which color mode (original / light / dark) to bake into the export.

---

## Undo / redo

Nearly every action (drawing, erasing, moving, transforming, page operations, style and color-mode changes, etc.) can be undone with `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` (or `Ctrl/Cmd+Y`), the toolbar buttons, or the command palette.

---

## Settings reference

| Setting | Description |
|---|---|
| **Pen simplification** | How closely freehand strokes follow your hand motion vs. being simplified into fewer, more economical points. |
| **Template folder** | Vault folder of PDF files offered as reusable "blank page" templates. |
| **New PDF Compose file → Filename syntax** | Placeholders `$date`, `$time`, `$datetime` for auto-generated filenames. |
| **New PDF Compose file → Save creation date** | Writes a creation date into new files' frontmatter. |
| **Mobile / Touch → Only stylus draws** | Restricts drawing/erasing/selecting to stylus or mouse; fingers only scroll/pinch-zoom. |
| **Dark mode → Enable filters in light/dark mode** | Whether the hue/brightness filters below apply in each mode. |
| **Dark mode → Shift hue / Monochrome tint / Dim white / Lighten black** | Control dark-mode color appearance. |
| **OCR → Enable OCR** | Master on/off switch for handwriting recognition. |
| **OCR → Update on search / Recognize in background** | When OCR runs automatically. |
| **OCR → Model file / Character table / WASM folder** | Resource paths for the recognition model. |
| **OCR → Model/Character table URL + Download** | Convenience download of a model into the configured paths. |
| **OCR → Minimum confidence** | Recognized words below this confidence are discarded. |
| **OCR → Line factor / Word factor / Fragment rescue factor / Interpolation spacing** | Fine-tune how strokes are grouped into words before recognition. |
| **Automatic page headings → Enable / Heading syntax** | Whether/how an auto-generated heading is inserted before each page's content, with placeholders for page number and source. |
| **Search → Tolerance: PDF text, text blocks & annotations** | Typo tolerance for these categories. |
| **Search → Tolerance: Handwriting (OCR)** | Typo tolerance for OCR results (recommended higher). |

Additional quick-access toggles (save PDF text as a searchable note, color mode, "stylus only", scroll direction, invert brightness) are available directly in the document view's "more options" (⋮) menu.

---

## Compatibility notes

- A PDF Compose file is a regular Markdown note — Obsidian's search, backlinks, and graph view all work on it normally, and you can always fall back to *Open as Markdown* to read or edit it directly.
- The plugin recognizes and keeps working with files created by older versions of itself.

---

## Known limitations

- Curved/stepped lines, arrows, and polygons are exported to PDF as straight segments.
- The bundled default OCR model is licensed **non-commercial**; commercial use requires your own model (see the training guide linked above).
- OCR accuracy depends on handwriting style and the model behind it.
- Very large or heavily annotated documents may run slower on low-end mobile devices.

---

## License

This README describes the **PDF Compose** Obsidian plugin. The plugin's own license is independent of the license of any downloaded OCR model — see **Settings → OCR → Model license** for details on the bundled handwriting model.
