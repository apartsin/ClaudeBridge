# Claude Bridge — First Visit Exploration Protocol

Claude Bridge works with **any web editor**. When you arrive on a page where the bridge is active, it automatically explores and learns the editor structure. This protocol describes how that learning works and how you should interact with it.

---

## 1. Automatic First-Visit Learning

When no profile exists for the current application, the bridge **automatically**:

1. Scans the DOM for editable regions (contenteditable, textareas, inputs, rich-text editors)
2. Detects editor frameworks (Quill, ProseMirror, CKEditor, TinyMCE, or raw contenteditable)
3. Identifies block types (headings, paragraphs, lists, images, tables, etc.)
4. Detects save mechanisms (publish buttons, save buttons, auto-save)
5. Records quirks (Shadow DOM, React/Vue reactivity, iframe editing, etc.)
6. Saves an **App Profile** for the domain (applies to all pages on this domain)
7. Saves an **Instance Profile** for this specific page (page-specific structure)

**You do not need to trigger this manually.** The bridge does it before you interact.

---

## 2. Inform the User

On first visit to an unknown app, tell the user:

> This is my first time working with [app name] through Claude Bridge. The bridge has already explored the editor structure. Let me check what it learned.

Then call `window.__claudeBridge.getProfile()` and review the results.

---

## 3. Review and Supplement

After the auto-exploration, verify the results are adequate:

- **Block coverage**: Does `getContent()` return all visible content blocks? If the page shows content that wasn't captured, run `explore()` again.
- **Edit method**: Try a small edit to verify the detected edit method works.
- **Quirks**: Note any unusual behaviors and save them with `flagQuirk()`.

If the auto-exploration missed things, supplement it:

```js
// Run a fresh exploration
result = await window.__claudeBridge.explore()

// Save additional app-level knowledge
await window.__claudeBridge.updateAppKnowledge(domain, {
  selectors: result.suggestedSelectors,
  editMethod: { primary: result.suggestedEditMethod },
  quirks: result.suggestedQuirks.map(q => ({
    description: q, confidence: "tentative", source: "claude"
  }))
})

// Save instance-level structure
await window.__claudeBridge.updateInstanceKnowledge(instanceId, {
  structure: {
    totalBlocks: result.detectedBlocks.reduce((sum, b) => sum + b.count, 0),
    blockTypes: Object.fromEntries(
      result.detectedBlocks.map(b => [b.type, b.count])
    ),
    lastScanned: Date.now()
  }
})
```

---

## 4. Report to User

After exploration (whether automatic or manual), summarize:

> **Exploration complete.** Here is what I learned:
>
> - **Application**: [App Name]
> - **Edit mode**: [contentEditable / textarea / framework name]
> - **Blocks found**: [N] ([types list])
> - **Save method**: [Auto-save / Manual button / Keyboard shortcut]
> - **Quirks**: [List any, or "None detected"]
> - **Profile saved**: This knowledge will load automatically on future visits.
>
> I am ready to help you edit this page. What would you like to change?

---

## 5. Continuous Learning

As you work with the editor, keep learning:

- **If an edit method fails**: Try alternatives, then update the profile with what works.
- **If you discover a new quirk**: Save it with `flagQuirk()`.
- **If selectors change**: Update the app profile with new selectors.
- **If the user tells you something**: Save it as `confirmed` knowledge.

Every update is logged in the changelog and persists across sessions.

---

## 6. Edge Cases

### Page is not in edit mode
> The page does not appear to be in edit mode. I can see the content but may not be able to make changes. Please switch to edit mode and I will re-explore.

### Exploration returns no blocks
> The bridge could not detect any editable blocks on this page. This could mean:
> - The page is in view mode (not editing)
> - The editor uses a non-standard approach not yet recognized
> - The page may need to load more before editing is available
>
> Can you confirm this is an editor page? I can try alternative detection methods.

### Profile already exists but seems wrong
If a profile exists but editing fails, run a fresh exploration and compare:
1. Run `explore()`.
2. Compare results to the saved profile.
3. If there are discrepancies, update the profile and inform the user.

### Unknown editor framework
If no known framework is detected, the bridge falls back to raw contenteditable/textarea editing. This works for most web editors. If it doesn't:
1. Check if the editor uses Shadow DOM (elements may not be accessible)
2. Check if the editor uses iframes (need to focus the iframe first)
3. Try keyboard simulation as a last resort
4. Report what you find so the profile can be updated
