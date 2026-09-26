import { App, Notice, Platform, PluginSettingTab, Setting } from 'obsidian';
import PdfCompose from './main';
import { OcrAssetManager } from './ocr/OcrAssetManager';
import { VIEW_TYPE_PDFCOMPOSE } from './view/constants';

/** Default download source for a model compatible with the plugin (see README/training pipeline). */
const DEFAULT_MODEL_URL = 'https://raw.githubusercontent.com/TMK314/ink-OCR/main/digitalink.tflite';
const DEFAULT_LABELS_URL = 'https://raw.githubusercontent.com/TMK314/ink-OCR/refs/heads/main/labels.txt';
const MODEL_LICENSE_URL = 'https://raw.githubusercontent.com/TMK314/ink-OCR/refs/heads/main/LICENSE.md';

export interface PdfComposeSettings {
	mySetting: string;
	/** Vault-relative folder containing PDF files that are selectable everywhere as "blank page" templates. */
	templateFolder: string;
	/** Tolerance (in PDF points) for Douglas-Peucker simplification of freehand strokes. */
	strokeSimplifyTolerance: number;

	// --- OCR basic settings (used by code) ---
	ocrEnabled: boolean;
	ocrBackgroundEnabled: boolean;
	ocrRunOnSearch: boolean;
	ocrIdleCheckIntervalMs: number;
	ocrIdleQuietMs: number;

	// --- Paths for the OCR model (from OcrSettingsSlice) ---
	ocrModelPath: string;
	ocrLabelsPath: string;
	ocrWasmPath: string;
	ocrMaxSequenceLength: number;
	ocrMinConfidence: number;
	ocrLineGapFactor: number;
	ocrWordGapFactor: number;
	ocrFragmentRescueFactor: number;
	ocrResampleSpacing: number;

	// --- Download convenience (not part of OcrSettingsSlice, only for the settings UI) ---
	ocrModelUrl: string;
	ocrLabelsUrl: string;

	// --- Reserved for later, currently not evaluated by any module ---
	ocrLanguage?: string;
	ocrMaxAlternatives?: number;

	/** Maximum Levenshtein distance for PDF text, text block and annotation search. */
	textSearchMaxDistance: number;
	/** Maximum Levenshtein distance for handwriting (OCR) search. */
	ocrSearchMaxDistance: number;

	/** Whether the color filters (hue, contrast, brightness) should be active in light mode. */
	applyFiltersInLightMode: boolean;
	/** Whether the color filters should be active in dark mode. */
	applyFiltersInDarkMode: boolean;

	/** Degree value (0–360) for the hue-rotate component of the dark-mode filter. 180 = classic inversion; other values shift the hue and can be roughly used as color temperature (warm/cool). */
	darkModeHueRotate: number;
	/** Optional hex color for a monochrome dark-mode tint. Empty = normal, multi-color inversion. */
	darkModeMonochromeColor: string;

	darkModeWhiteDim: number;
	darkModeBlackLighten: number;

	/** Mobile: when enabled, finger touches no longer trigger drawing/erasing/shape tools - only stylus (pen) and mouse draw. Fingers can then only scroll/pinch-zoom. */
	restrictDrawingToStylus: boolean;

	/** When enabled, an automatically generated heading is inserted before each page block with content in the Markdown body. */
	pageHeadingsEnabled: boolean;
	/** Syntax template for the automatically generated page headings. Placeholders: $1 = page number in the document, $2 = source name, $3 = page number in the source. */
	pageHeadingsSyntax: string;

	/** Syntax for the filename of newly created PDF Compose documents. Placeholders: $date, $time, $datetime. */
	newFileSyntax: string;
	/** When enabled, a "created" field (ISO 8601) is written to the frontmatter when creating new files. */
	saveCreatedDate: boolean;

	horizontalLayout: boolean;
}

export const DEFAULT_SETTINGS: PdfComposeSettings = {
	mySetting: 'default',
	templateFolder: '',
	strokeSimplifyTolerance: 0.6,

	ocrEnabled: false,
	ocrBackgroundEnabled: !Platform.isMobile,
	ocrRunOnSearch: true,
	ocrIdleCheckIntervalMs: Platform.isMobile ? 8000 : 4000,
	ocrIdleQuietMs: Platform.isMobile ? 4000 : 2500,

	ocrModelPath: '',
	ocrLabelsPath: '',
	ocrWasmPath: '',
	ocrMaxSequenceLength: 256,
	ocrMinConfidence: 0.4,
	ocrLineGapFactor: 0.9,
	ocrWordGapFactor: 0.6,
	ocrFragmentRescueFactor: 1.6,
	ocrResampleSpacing: 0.02,

	ocrModelUrl: DEFAULT_MODEL_URL,
	ocrLabelsUrl: DEFAULT_LABELS_URL,

	ocrLanguage: 'de',
	ocrMaxAlternatives: 1,

	textSearchMaxDistance: 1,
	ocrSearchMaxDistance: 2,

	applyFiltersInLightMode: false,
	applyFiltersInDarkMode: true,

	darkModeHueRotate: 0,
	darkModeMonochromeColor: '',

	darkModeWhiteDim: 0,
	darkModeBlackLighten: 0,

	restrictDrawingToStylus: true,

	pageHeadingsEnabled: true,
	pageHeadingsSyntax: '## \\#$1 - $3 $2',

	newFileSyntax: 'Untitled $datetime',
	saveCreatedDate: true,

	horizontalLayout: false,
};

export class PdfComposeSettingTab extends PluginSettingTab {
	plugin: PdfCompose;

	constructor(app: App, plugin: PdfCompose) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Pen simplification')
			.setDesc('How strongly freehand strokes are simplified while drawing (Douglas–Peucker tolerance in PDF points). Higher values produce fewer support points (more angular but more economical), lower values follow the hand motion more accurately.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 3, 0.1)
					.setValue(this.plugin.settings.strokeSimplifyTolerance)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.strokeSimplifyTolerance = value;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName('Template folder')
			.setDesc('Folder containing PDF files that are selectable under "Blank page" in all "Add page" dialogs (including subfolders).')
			.addText((text) =>
				text
					.setPlaceholder('e.g. Templates/PDF')
					.setValue(this.plugin.settings.templateFolder)
					.onChange(async (value) => {
						this.plugin.settings.templateFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		this.displayNewFileSection(containerEl);

		this.displayMobileSection(containerEl);

		this.displayDarkModeSection(containerEl);

		void this.displayOcrSection(containerEl);

		this.displayPageHeadingsSection(containerEl);

		this.displaySearchSection(containerEl);
	}

	private displayDarkModeSection(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Dark mode' });
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'Controls the color filter used to render PDF pages in dark mode ' +
				'(frontmatter "colorMode: dark" or automatically detected dark pages).',
		});

		new Setting(containerEl)
			.setName('Enable filters in light mode')
			.setDesc('Also applies the color filters configured below (hue, dimming/lightening) in light mode. Disabled: original colors are preserved.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.applyFiltersInLightMode)
					.onChange(async (value) => {
						this.plugin.settings.applyFiltersInLightMode = value;
						await this.plugin.saveSettings();
						this.notifyDarkModeFilterChange();
					})
			);

		new Setting(containerEl)
			.setName('Enable filters in dark mode')
			.setDesc('Also applies the color filters in dark mode. Disabled: pure inversion with no additional adjustments.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.applyFiltersInDarkMode)
					.onChange(async (value) => {
						this.plugin.settings.applyFiltersInDarkMode = value;
						await this.plugin.saveSettings();
						this.notifyDarkModeFilterChange();
					})
			);

		new Setting(containerEl)
			.setName('Shift hue')
			.setDesc(
				'Shifts the display hue (0–360°). ' +
				'In dark mode this is applied in addition to the automatic color inversion; ' +
				'0° corresponds to classic inversion.'
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 360, 5)
					.setValue(this.plugin.settings.darkModeHueRotate)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.darkModeHueRotate = value;
						await this.plugin.saveSettings();
						this.notifyDarkModeFilterChange();
					}),
			);

		new Setting(containerEl)
			.setName('Monochrome tint')
			.setDesc(
				'Optional: Tints dark mode entirely in a single hue (e.g. a warm amber ' +
				'or a cool blue) instead of inverting the original colors.'
			)
			.addColorPicker((picker) =>
				picker.setValue(this.plugin.settings.darkModeMonochromeColor || '#000000').onChange(async (value) => {
					this.plugin.settings.darkModeMonochromeColor = value;
					await this.plugin.saveSettings();
					this.notifyDarkModeFilterChange();
				}),
			)
			.addExtraButton((btn) =>
				btn
					.setIcon('x')
					.setTooltip('Disable monochrome tint')
					.onClick(async () => {
						this.plugin.settings.darkModeMonochromeColor = '';
						await this.plugin.saveSettings();
						this.notifyDarkModeFilterChange();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName('Dim white')
			.setDesc('Reduces the brightness of white areas in dark mode (0 = no effect, 100 = maximally dimmed).')
			.addSlider((slider) =>
				slider
					.setLimits(0, 100, 1)
					.setValue(this.plugin.settings.darkModeWhiteDim)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.darkModeWhiteDim = value;
						await this.plugin.saveSettings();
						this.notifyDarkModeFilterChange();
					})
			);

		new Setting(containerEl)
			.setName('Lighten black')
			.setDesc('Increases the brightness of black areas in dark mode (0 = no effect, 100 = maximally lightened).')
			.addSlider((slider) =>
				slider
					.setLimits(0, 100, 1)
					.setValue(this.plugin.settings.darkModeBlackLighten)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.darkModeBlackLighten = value;
						await this.plugin.saveSettings();
						this.notifyDarkModeFilterChange();
					})
			);
	}

	private displayMobileSection(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Mobile / Touch' });

		new Setting(containerEl)
			.setName('Only stylus draws')
			.setDesc('When enabled, finger touches no longer trigger drawing, erasing, or shape tools. Fingers can then only scroll and pinch-zoom; drawing is only possible with a stylus (or the mouse).')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.restrictDrawingToStylus).onChange(async (value) => {
					this.plugin.settings.restrictDrawingToStylus = value;
					await this.plugin.saveSettings();
					this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PDFCOMPOSE).forEach((leaf) => {
						const view = leaf.view as any;
						if (typeof view.refreshDarkModeFilters === 'function') {
							view.refreshDarkModeFilters();
						}
						if (view.ui && typeof view.ui.setStylusOnlyValue === 'function') {
							view.ui.setStylusOnlyValue(value);
						}
					});
				})
			);
	}

	private displayNewFileSection(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'New PDF Compose file' });
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'Determines the file name and metadata of newly created PDF Compose documents. ' +
				'Unknown $… placeholders remain unchanged; free text around the placeholders ' +
				'is kept as-is.',
		});

		new Setting(containerEl)
			.setName('Filename syntax')
			.setDesc(
				'Placeholders: $date → 2026-09-12 · $time → 14-30-52 · $datetime → both combined. ' +
				'Examples: "Untitled $date", "Note $datetime", "PDF $date". ' +
				'If the resulting name already exists, a number is appended automatically.',
			)
			.addText((text) =>
				text
					.setPlaceholder('Untitled $datetime')
					.setValue(this.plugin.settings.newFileSyntax)
					.onChange(async (value) => {
						this.plugin.settings.newFileSyntax = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Save creation date in frontmatter')
			.setDesc(
				'Also writes a "created" field (ISO 8601) into the frontmatter when creating new files. ' +
				'Existing values are preserved unchanged on edits.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.saveCreatedDate !== false)
					.onChange(async (value) => {
						this.plugin.settings.saveCreatedDate = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	/** Triggers a redraw on all open PDF Compose views so changed dark-mode filters become visible immediately. */
	private notifyDarkModeFilterChange(): void {
		this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PDFCOMPOSE).forEach((leaf) => {
			const view = leaf.view as any;
			if (typeof view.refreshDarkModeFilters === 'function') {
				view.refreshDarkModeFilters();
			}
		});
	}

	private displayPageHeadingsSection(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Automatic page headings' });
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'Inserts a heading in the Markdown body before each page’s content (text blocks, PDF annotations, or ' +
				'OCR results) so page boundaries are clearly visible. The heading is regenerated on every ' +
				'body reordering and is wrapped in marker comments; manual edits within these markers are ' +
				'overwritten.',
		});

		new Setting(containerEl)
			.setName('Enable page headings')
			.setDesc('Inserts an automatically generated heading before every page with content.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.pageHeadingsEnabled).onChange(async (value) => {
					this.plugin.settings.pageHeadingsEnabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Heading syntax')
			.setDesc(
				'Placeholders: $1 = page number in the document, $2 = source name, $3 = page number within ' +
				'the same source. Markdown formatting such as "## " for a level-2 heading is allowed. ' +
				'Unknown placeholders remain unchanged.',
			)
			.addText((text) =>
				text
					.setPlaceholder('## \\#$1 - $3 $2')
					.setValue(this.plugin.settings.pageHeadingsSyntax)
					.onChange(async (value) => {
						this.plugin.settings.pageHeadingsSyntax = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	private displaySearchSection(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Search' });
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'Controls how tolerant the full-text search is toward deviations from the search term (Levenshtein distance). \n' +
				'The selected tolerance is applied per word (5 letters) - longer words can therefore contain more deviations.',
		});

		new Setting(containerEl)
			.setName('Tolerance: PDF text, text blocks & annotations')
			.setDesc('Maximum Levenshtein distance for matches in PDF text as well as in text blocks and annotations.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 4, 1)
					.setValue(this.plugin.settings.textSearchMaxDistance)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.textSearchMaxDistance = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Tolerance: Handwriting (OCR)')
			.setDesc('Maximum Levenshtein distance for matches in handwriting recognized by OCR. Since recognition is more error-prone, this value should be higher than for PDF text.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 6, 1)
					.setValue(this.plugin.settings.ocrSearchMaxDistance)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.ocrSearchMaxDistance = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	/** Vault-relative default folder for this plugin's OCR resources. */
	private ocrDefaultDir(): string {
		return `${this.plugin.manifest.dir ?? '.obsidian/plugins/pdfcompose'}/ocr`;
	}

	/**
	 * Fills ocrModelPath/ocrLabelsPath/ocrWasmPath with sensible default paths
	 * relative to the plugin folder if they are still empty (fresh installation).
	 */
	private async ensureDefaultPaths(): Promise<void> {
		const s = this.plugin.settings;
		let changed = false;

		if (!s.ocrModelPath) {
			s.ocrModelPath = `${this.ocrDefaultDir()}/digitalink.tflite`;
			changed = true;
		}
		if (!s.ocrLabelsPath) {
			s.ocrLabelsPath = `${this.ocrDefaultDir()}/labels.txt`;
			changed = true;
		}
		if (!s.ocrWasmPath) {
			s.ocrWasmPath = `${this.plugin.manifest.dir ?? '.obsidian/plugins/pdfcompose'}/wasm`;
			changed = true;
		}

		if (changed) {
			await this.plugin.saveSettings();
		}
	}

	private async displayOcrSection(containerEl: HTMLElement): Promise<void> {
		await this.ensureDefaultPaths();

		containerEl.createEl('h2', { text: 'OCR (handwriting recognition)' });
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'Automatically recognizes words handwritten ' +
				'and stores them searchably in the document. Requires a local ' +
				'TFLite model (input: point sequences [x, y, t]) as well as the matching ' +
				'character table and the tfjs-tflite WASM runtime files.',
		});
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'Note: @tensorflow/tfjs-tflite is only the runtime for .tflite files – it does not ' +
				'ship a model itself. Without a matching model under "Model file", OCR has no effect.',
		});

		new Setting(containerEl)
			.setName('Enable OCR')
			.setDesc('Turns handwriting recognition on/off as a whole.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.ocrEnabled).onChange(async (value) => {
					this.plugin.settings.ocrEnabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Update on search')
			.setDesc('Automatically runs OCR for changed pages as soon as a search is started.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.ocrRunOnSearch).onChange(async (value) => {
					this.plugin.settings.ocrRunOnSearch = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Recognize in background')
			.setDesc('Continuously checks (when the main thread is free and no drawing has occurred for a moment) for new/changed strokes and runs OCR automatically.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.ocrBackgroundEnabled).onChange(async (value) => {
					this.plugin.settings.ocrBackgroundEnabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Background OCR check interval (ms)')
			.setDesc('How often it is checked whether there is an opportunity for background OCR.')
			.addText((text) =>
				text.setValue(String(this.plugin.settings.ocrIdleCheckIntervalMs)).onChange(async (value) => {
					const n = parseInt(value, 10);
					if (!Number.isNaN(n) && n > 0) {
						this.plugin.settings.ocrIdleCheckIntervalMs = n;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(containerEl)
			.setName('Quiet period before background OCR (ms)')
			.setDesc('How long to wait after the last interaction (drawing/scrolling) before background recognition starts.')
			.addText((text) =>
				text.setValue(String(this.plugin.settings.ocrIdleQuietMs)).onChange(async (value) => {
					const n = parseInt(value, 10);
					if (!Number.isNaN(n) && n >= 0) {
						this.plugin.settings.ocrIdleQuietMs = n;
						await this.plugin.saveSettings();
					}
				}),
			);

		containerEl.createEl('h3', { text: 'Model & resources' });

		new Setting(containerEl)
			.setName('Model file (.tflite)')
			.setDesc('Vault-relative path to the handwriting TFLite file.')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.ocrModelPath)
					.onChange(async (value) => {
						this.plugin.settings.ocrModelPath = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Character table')
			.setDesc('Vault-relative path to the labels file (one character/token per line, line number = model class index).')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.ocrLabelsPath)
					.onChange(async (value) => {
						this.plugin.settings.ocrLabelsPath = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('WASM folder (tfjs-tflite)')
			.setDesc('Vault-relative folder containing the tfjs-tflite WASM runtime files. Automatically copied by the build (esbuild.config.mjs) into the plugin’s "wasm" subfolder – usually nothing to do here.')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.ocrWasmPath)
					.onChange(async (value) => {
						this.plugin.settings.ocrWasmPath = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl('h3', { text: 'Model download' });
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'Downloads the model and character table from the specified URLs and saves them to the vault-relative paths above.' +
				' The model is trained on the Deepwriting dataset of ETH Zurich and is therefore subject to the same conditions: ' +
				'non-commercial use, CC BY-NC-SA 4.0, additionally with a "No Distribution" clause for the underlying dataset. ' +
				'See the full license here: ',
		}).createEl('a', {
			text: 'LICENSE.md', href: MODEL_LICENSE_URL
		});

		new Setting(containerEl)
			.setName('Model URL')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_MODEL_URL)
					.setValue(this.plugin.settings.ocrModelUrl)
					.onChange(async (value) => {
						this.plugin.settings.ocrModelUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			)
			.addButton((button) =>
				button.setButtonText('Download').onClick(async () => {
					await this.downloadOcrAsset('model');
				}),
			);

		new Setting(containerEl)
			.setName('Character table URL')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_LABELS_URL)
					.setValue(this.plugin.settings.ocrLabelsUrl)
					.onChange(async (value) => {
						this.plugin.settings.ocrLabelsUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			)
			.addButton((button) =>
				button.setButtonText('Download').onClick(async () => {
					await this.downloadOcrAsset('labels');
				}),
			);

		this.displayLicenseSection(containerEl);

		containerEl.createEl('h3', { text: 'Fine-tuning' });

		new Setting(containerEl)
			.setName('Minimum confidence')
			.setDesc('Recognized words below this confidence (0–1) are discarded.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.05)
					.setValue(this.plugin.settings.ocrMinConfidence)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.ocrMinConfidence = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Line factor')
			.setDesc('Relative to the MEDIAN stroke height: when two strokes count as different lines (comparison of vertical stroke centers). If in doubt, choose rather lower – splitting a word too finely does less harm than a bounding box incorrectly merged across two lines.')
			.addSlider((slider) =>
				slider
					.setLimits(0.3, 4, 0.1)
					.setValue(this.plugin.settings.ocrLineGapFactor)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.ocrLineGapFactor = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Word factor')
			.setDesc('Relative to the MEDIAN stroke width (not height): when a new word begins within a line. If in doubt, choose rather lower.')
			.addSlider((slider) =>
				slider
					.setLimits(0.2, 4, 0.1)
					.setValue(this.plugin.settings.ocrWordGapFactor)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.ocrWordGapFactor = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Fragment rescue factor')
			.setDesc('Multiplier on line/word factor for a second pass: small, isolated strokes (max. 2, e.g. an i-dot or a singly applied letter stroke) are assigned to the nearest bounding box, provided the distance is within this more generous multiple. 1.0 = disabled.')
			.addSlider((slider) =>
				slider
					.setLimits(1.0, 3.0, 0.1)
					.setValue(this.plugin.settings.ocrFragmentRescueFactor)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.ocrFragmentRescueFactor = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Interpolation spacing')
			.setDesc('Target spacing between points (relative to word size) when filling in simplified strokes before recognition. Smaller values = more interpolated points.')
			.addSlider((slider) =>
				slider
					.setLimits(0.005, 0.08, 0.005)
					.setValue(this.plugin.settings.ocrResampleSpacing)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.ocrResampleSpacing = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	/**
	 * Shows a summary of the model license (non-commercial, CC BY-NC-SA 4.0 + "No Distribution" for the
	 * underlying dataset) along with a link to the full license file. Applies ONLY to the
	 * downloaded model weights, not to this plugin itself.
	 */
	private displayLicenseSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Model license' });

		const p1 = containerEl.createEl('p', { cls: 'setting-item-description' });
		p1.appendText(
			'The pre-filled model is trained on the Deepwriting dataset of ETH Zurich and is therefore subject ' +
			'to the same conditions: '
		);
		p1.createEl('strong', { text: 'non-commercial use, CC BY-NC-SA 4.0' });
		p1.appendText(
			', additionally with a "No Distribution" clause for the underlying dataset. Full ' +
			'text: '
		);
		p1.createEl('a', { text: 'LICENSE.md', href: MODEL_LICENSE_URL, attr: { target: '_blank', rel: 'noopener' } });
		p1.appendText('.');

		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'Briefly summarized, when using/redistributing the model file you must: (1) attribute the source ' +
				'(Attribution), (2) NOT use it commercially, (3) distribute your own modifications under the same license ' +
				'(ShareAlike), and (4) NOT copy, redistribute, or resell the original Deepwriting dataset itself.',
		});

		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'This applies exclusively to the downloaded model file – this plugin only loads it into your ' +
				'vault from the URL given above on your click, but does not bundle or distribute it itself. ' +
				'This plugin’s license is independent of that. If you incorporate the model into your own publication ' +
				'(instead of merely referencing the download link), the conditions above apply to you.',
		});
	}

	private async downloadOcrAsset(kind: 'model' | 'labels'): Promise<void> {
		const manager = new OcrAssetManager(this.app);
		try {
			if (kind === 'model') {
				if (!this.plugin.settings.ocrModelUrl || !this.plugin.settings.ocrModelPath) {
					new Notice('Please specify model URL and model file path first.');
					return;
				}
				await manager.downloadBinary(this.plugin.settings.ocrModelUrl, this.plugin.settings.ocrModelPath);
				new Notice('OCR model downloaded.');
			} else {
				if (!this.plugin.settings.ocrLabelsUrl || !this.plugin.settings.ocrLabelsPath) {
					new Notice('Please specify character table URL and path first.');
					return;
				}
				await manager.downloadText(this.plugin.settings.ocrLabelsUrl, this.plugin.settings.ocrLabelsPath);
				new Notice('Character table downloaded.');
			}
		} catch (error) {
			new Notice(`Download failed: ${String(error)}`);
		}
	}
}