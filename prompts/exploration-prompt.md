# Claude Bridge — First Visit Exploration Protocol

When you arrive on a page where the bridge is active but **no profile exists** for the current application or instance, follow this protocol to learn the page structure and create an initial profile.

---

## 1. Inform the User

Before running any exploration, let the user know:

> This is my first time seeing this web application through the bridge. I will run a quick exploration to learn its structure. This will take a moment — I will not make any changes to the page.

---

## 2. Run Exploration

Call `explore()` to get the full block map. The bridge will:

- Scan the DOM for editable regions.
- Identify block types (headings, paragraphs, images, lists, tables, embeds, etc.).
- Detect the edit mode (contentEditable, textarea, custom editor framework).
- Catalog available toolbar actions, save buttons, and other interactive elements.
- Record CSS selectors for each discovered element type.

The result is a structured report containing:
- `blocks` — Array of discovered blocks with `blockId`, `type`, `selector`, and `textPreview`.
- `editMode` — How the editor works (contentEditable, input fields, framework-specific API).
- `toolbar` — Detected toolbar elements and their actions.
- `pageContainer` — The root container selector for editable content.
- `quirks` — Any unusual behaviors or patterns detected during exploration.

---

## 3. Review Results

Analyze the exploration results before saving:

- **Block coverage**: Are all visible content blocks accounted for? If the page shows 10 paragraphs but explore() found 7, note the gap.
- **Selector reliability**: Do the selectors look stable (class-based, id-based) or fragile (nth-child, deeply nested paths)?
- **Edit method**: Is the edit approach clear? contentEditable, execCommand, framework API?
- **Missing elements**: Are there interactive elements (buttons, widgets, embeds) that explore() did not categorize?

If the exploration seems incomplete, you may run targeted DOM queries to fill gaps. Do not guess — use actual DOM inspection.

---

## 4. Save Learned Profile

Based on the exploration results, construct and save two profiles:

### App Profile

Create an App Profile for the domain with:
- `appName` — A human-readable name for the application (e.g., "Google Sites", "Notion", "WordPress").
- `selectors.blocks` — Selectors for each discovered block type.
- `selectors.pageContainer` — The root content container.
- `selectors.editModeDetection` — How to detect whether the page is in edit mode.
- `selectors.toolbar` — Toolbar selector, if found.
- `selectors.saveButton` — Save button selector, if found.
- `actions` — Discovered edit actions with their methods.
- `editMethod.primary` — The primary edit mechanism.
- `editMethod.requiresNativeEvents` — Whether edits require simulated native events.
- `editMethod.saveRequired` — Whether the user must explicitly save.
- `editMethod.saveMethod` — How to save (button click, keyboard shortcut, auto-save).
- `quirks` — Any quirks discovered during exploration.

Set all selector confidences to `tentative` for a first exploration. They will be promoted as they are validated in future sessions.

### Instance Profile

Create an Instance Profile with:
- `instanceId` — Derived from the current URL using the bridge's normalization rules.
- `domain` — The parent domain (matching the App Profile).
- `deltas` — Any instance-specific overrides discovered. For a first visit, this may be empty or contain page-specific layout details.

---

## 5. Inform the User of Results

After saving, provide a summary:

> **Exploration complete.** Here is what I learned:
>
> - **Application**: [App Name]
> - **Edit mode**: [contentEditable / textarea / framework]
> - **Blocks found**: [N] ([types list])
> - **Toolbar detected**: [Yes/No]
> - **Save method**: [Auto-save / Manual button / Keyboard shortcut]
> - **Quirks**: [List any, or "None detected"]
> - **Profiles saved**: App Profile for `[domain]`, Instance Profile for `[instanceId]`
>
> I am ready to help you edit this page. What would you like to change?

---

## 6. Edge Cases

### Page is not in edit mode
If the page appears to be in view mode (not editing), inform the user:

> The page does not appear to be in edit mode. I can see the content but may not be able to make changes. Please switch to edit mode and I will re-explore.

### Exploration returns no blocks
If `explore()` finds zero blocks, the page may not be a supported editor. Inform the user:

> The bridge could not detect any editable blocks on this page. This application may not be supported yet, or the page may need to be in a different state. Can you confirm this is an editor page?

### Profile already exists
If a profile already exists (this is a revisit, not a first visit), skip the full exploration protocol. Instead, do a quick validation:

1. Run `explore()`.
2. Compare results to the saved profile.
3. If they match, proceed normally.
4. If there are discrepancies, inform the user and propose a profile update following the knowledge update rules.
