# Settings Page & Model Selection UI Redesign

## Objective

Replace the current settings page and model browser modal UI with a clean, scannable layout that applies progressive disclosure. The current implementation dumps 7-9 lines of raw metadata as plain `<p>` elements, spreads four action buttons across four full-width rows, and adds verbose model-store prose paragraphs — all with zero custom CSS.

## Current State

Three files own the entire settings UI:

- `src/settings/settings-tab.ts` (344 lines) — `LocalSttSettingTab` renders the settings page
- `src/models/model-management-modals.ts` (442 lines) — `ModelExplorerModal`, `InstalledModelPickerModal`, `ExternalModelFileModal`, `ModelDetailsModal`
- No `styles.css` exists

Problems:
1. `renderCurrentModelCard()` creates 7-9 `createEl('p')` calls showing engine, source, status, detail, size, install path, resolved path — all with equal visual weight
2. `renderModelActions()` creates four separate `new Setting()` rows each containing one button
3. `renderModelStoreSection()` adds three more `<p>` elements for store path, default/override status, and override path
4. `ModelExplorerModal.renderRow()` uses `h3` + three `<p>` elements (summary, status text, tags text) + separate `Setting` rows per button
5. `ModelDetailsModal.onOpen()` is a flat list of `createEl('p')` calls
6. Sidecar settings occupy screen space that most users never need

The service layer (`model-management-service.ts`, `model-management-types.ts`) and settings schema (`plugin-settings.ts`) already provide all needed data — this is purely a rendering change.

## Constraints

- Use only Obsidian's `Setting`, `Modal`, `createEl`/`createDiv` APIs — no external UI frameworks
- All colors via Obsidian CSS variables (theme-safe for light, dark, and community themes)
- No service layer or type changes — the `ModelManagementSnapshot` shape is already correct
- No new settings fields
- Progressive enhancement: if CSS fails to load, the UI degrades to standard Obsidian Setting rows

## Approach

### 1. Create `styles.css` at project root

Obsidian auto-loads `styles.css` from the plugin directory. All selectors prefixed with `.local-stt-` to avoid collisions.

**CSS sections:**

| Section | Classes | Purpose |
|---------|---------|---------|
| Current model | `.local-stt-current-model` | Slightly larger name for the primary model display |
| Status badges | `.local-stt-badge`, `--ready`, `--missing`, `--external`, `--none` | Inline pill indicators using `--background-modifier-success`, `--background-modifier-error`, `--background-modifier-border` |
| Tag pills | `.local-stt-tags`, `.local-stt-tag`, `.local-stt-tag--recommended` | Flex-wrap row of small rounded chips |
| Model rows | `.local-stt-model-row`, `.local-stt-row-header`, `.local-stt-row-summary` | Card-like divs with bottom borders, flexbox header (name left, size right) |
| Details grid | `.local-stt-details-grid` | Two-column CSS grid for `<dl>` in details modal |
| Advanced | `.local-stt-advanced` | Styled `<details>/<summary>` for collapsible sidecar section |
| Explorer modal | `.local-stt-explorer` | Width constraint (~600px / 90vw) |

Use fallback values for CSS variables that may be absent in community themes (e.g., `var(--background-modifier-success, rgba(0, 200, 0, 0.15))`).

### 2. Redesign settings tab (`settings-tab.ts`)

**2a. Restructure `display()` layout:**

Replace raw `h2`/`h3`/`p` section markers with `Setting.setHeading()` calls:

1. Keep `h2` "Local STT" + intro paragraph
2. `new Setting().setName('Model').setHeading()` → async model section div
3. `new Setting().setName('Transcription').setHeading()` → listening mode, pause toggle, transcript placement (these three Settings are already clean — untouched)
4. Wrap sidecar settings in `<details class="local-stt-advanced"><summary>Advanced: Sidecar</summary>` instead of `h3` + `p`. Render path override, startup timeout, request timeout inside the `<details>` element
5. Keep hotkey hint paragraph at bottom

**2b. Rewrite `renderCurrentModelCard()`:**

Replace 7-9 `createEl('p')` calls with one `Setting` row:

- **Name:** `snapshot.currentModel.displayName`
- **Description:** `DocumentFragment` with engine label + ` · ` + badge `<span>` (CSS class mapped from `installedLabel`)
- **Info button:** `addExtraButton` with `info` icon → opens a details modal showing source, detail message, size, install path, resolved path, store path. Only rendered when `currentSelection !== null`.
- **Active install:** If `snapshot.activeInstall !== null`, render a second `Setting` row with model ID and state/progress.

Badge class mapping:

| `installedLabel` | CSS modifier |
|---|---|
| `Installed`, `Validated external file` | `--ready` |
| `Not installed`, `Unavailable` | `--missing` |
| `External file` | `--external` |
| `Not selected` | `--none` |

**2c. Consolidate `renderModelActions()`:**

Collapse four `Setting` rows into one:

1. `addButton("Browse models").setCta()` — primary
2. `addButton("Choose installed")` — secondary
3. `addExtraButton` icon `file-input`, tooltip "Use external file" — tertiary
4. `addExtraButton` icon `x-circle`, tooltip "Clear selection" — danger

**2d. Delete `renderModelStoreSection()`:**

The verbose store-path prose is removed. The "Model store folder override" text input `Setting` (already at line 189) is self-explanatory and stays. Store path info is accessible via the info button.

**2e. Add `CurrentModelInfoModal`:**

A small `Modal` subclass (private to `settings-tab.ts` or co-located in modals) that renders a grid layout showing the full technical details removed from the card: source label, detail message, formatted size, install path, resolved path, model store path. Uses the `.local-stt-details-grid` CSS class.

### 3. Redesign model browser modal (`model-management-modals.ts`)

**3a. `ModelExplorerModal.onOpen()`:**

Add `this.modalEl.addClass('local-stt-explorer')` for width constraint.

**3b. Rewrite `ModelExplorerModal.renderRow()`:**

Replace `h3` + three `<p>` + multiple `Setting` rows with a structured card:

1. **Header** (`.local-stt-row-header`): `<strong>` name (left) + `<span>` formatted size from `getPrimaryArtifact()` (right, muted)
2. **Summary** (`.local-stt-row-summary`): `<p>` with `row.model.summary`
3. **Tags** (`.local-stt-tags`): `<span>` pills per `uxTags` entry. `"recommended"` tag gets `.local-stt-tag--recommended`
4. **Actions** — single `Setting` row:
   - Installing → "Cancel" (CTA)
   - Installed + selected → "Selected" (disabled) + "Remove" (warning)
   - Installed + not selected → "Use" (CTA) + "Remove" (warning)
   - Not installed → "Install" (CTA)
   - All states → `addExtraButton` `info` icon for details modal

**3c. Rewrite `ModelDetailsModal.onOpen()`:**

Replace flat `createEl('p')` list with a `<dl class="local-stt-details-grid">`:

- Engine, Source URL, License (label + URL), Artifact (filename + size), SHA-256 (monospace), Download URL (monospace), Install path (conditional), Notes (conditional)

Each field is a `<dt>`/`<dd>` pair. SHA-256 and URLs get monospace font via `.local-stt-mono`.

**3d. Slim down `InstalledModelPickerModal`:**

Remove install path `<p>`. Each row: `<strong>` name → `<p>` summary → single "Use" CTA button in one `Setting`.

**3e. Delete `describeRowStatus()`:**

The plain-text status function ("Status: installed and currently selected.") is replaced by the badge approach. Delete the function.

**3f. `ExternalModelFileModal` — no changes.**

## Execution Steps

- [ ] Create `styles.css` at project root with all CSS sections
- [ ] Rewrite `settings-tab.ts`: restructure `display()`, rewrite `renderCurrentModelCard()`, consolidate `renderModelActions()`, delete `renderModelStoreSection()`, add `CurrentModelInfoModal`
- [ ] Rewrite `model-management-modals.ts`: restructure `ModelExplorerModal.renderRow()`, rewrite `ModelDetailsModal.onOpen()`, slim `InstalledModelPickerModal`, delete `describeRowStatus()`
- [ ] Build and type-check: `npm run build`
- [ ] Run tests: `npm run test`
- [ ] Manual verification in Obsidian (both dark and light themes)

## Verification

1. `npm run build` — TypeScript compiles, bundle succeeds
2. `npm run test` — no test regressions
3. Manual in Obsidian:
   - Settings tab: no model selected → "No model selected" with muted badge, no info button
   - Settings tab: installed model → name, engine, green badge, info button reveals details grid
   - Settings tab: not-installed model → red badge
   - Settings tab: external file → neutral badge
   - Settings tab: all four actions work from the consolidated button row
   - Settings tab: sidecar section collapsed by default
   - Browse modal: cards show name, size, summary, tag pills
   - Browse modal: install/use/remove/cancel work
   - Browse modal: details modal renders as grid
   - Browse modal: search filtering works
   - Light and dark theme badge/tag readability

## Risks and Open Questions

1. **`DocumentFragment` in `setDesc()`** — Obsidian's `Setting.setDesc()` accepts `string | DocumentFragment`. Building fragments with inline badge spans should work but needs runtime verification.
2. **Button density in one row** — Two buttons + two extra buttons on a single `Setting` row may overflow on narrow settings panes. If it does, the `addExtraButton` icons take minimal space so this is unlikely.
3. **Community theme CSS variables** — Variables like `--background-modifier-success` may not exist in all community themes. CSS fallback values handle this.
4. **`<details>` element in settings** — Standard HTML, works in Electron/Chromium. Verify that `Setting` components render correctly inside a `<details>` element.
