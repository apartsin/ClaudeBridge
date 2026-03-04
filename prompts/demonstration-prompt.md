# Claude Bridge — Learn by Demonstration Protocol

When you encounter an editor that the bridge cannot edit properly through auto-exploration alone, you can ask the user to demonstrate the correct operation. This protocol describes when and how to use Learn by Demonstration.

---

## 1. When to Suggest Demonstration Mode

Suggest demonstration mode when:

- An edit command fails twice with the same error
- The auto-explored edit method produces incorrect results (e.g., formatting lost, wrong element edited)
- The editor uses a non-standard approach that the generic adapter cannot handle
- The user explicitly asks to teach or train the bridge
- You detect that the editor requires special interaction patterns (e.g., double-click to edit, custom keyboard shortcuts)

**Do NOT suggest demonstration mode when:**
- The edit worked correctly
- The issue is a targeting problem (wrong block selected), not an edit method problem
- The page is not in edit mode

---

## 2. Initiating a Demonstration

When demonstration is needed, instruct the user:

> I am having trouble editing this [editor name] directly. Would you like to show me how it is done? I can watch what you do and learn the correct method.
>
> To start, I will enable demonstration recording. Then:
> 1. Perform the operation once (e.g., select some text and type to replace it)
> 2. Tell me when you are done
>
> I will analyze what happened and save it for future use.

Then call:
```js
window.__claudeBridge.startDemonstration({ maxDuration: 30000 })
```

---

## 3. During Recording

While recording is active:
- Monitor the status with `window.__claudeBridge.getDemonstrationStatus()`
- If the user seems stuck, offer guidance: "Go ahead and make the edit. I am recording."
- If the recording auto-stops (max duration or max events), inform the user

---

## 4. After Recording

When the user indicates they are done, or the recording stops:

```js
// 1. Stop recording
const recording = window.__claudeBridge.stopDemonstration()

// 2. Analyze the recording
const analysis = window.__claudeBridge.analyzeDemonstration(recording)

// 3. Review the analysis
```

Report the findings to the user:

> **Demonstration analysis complete.** Here is what I learned:
>
> - **Action detected**: [text_edit / format_change / etc.]
> - **Edit method**: [execCommand / directDOM / keyboard / frameworkAPI]
> - **Quirks found**: [list any, or "None"]
> - **Confidence**: [tentative / inferred]
>
> Summary: [analysis.summary]
>
> Should I save this to the profile for future use?

---

## 5. Saving Learned Knowledge

If the user approves (or if you are confident the demonstration was clear):

```js
await window.__claudeBridge.saveDemonstration(domain, analysis)
```

Inform the user:

> I have saved this knowledge. On future visits to [app name], I will use this method for [action type] operations.

---

## 6. When to Update vs Replace

- If a learned method already exists for the same action and it has confidence `tentative`, the new demonstration **replaces** it
- If the existing method has confidence `inferred` or higher, **ask the user** before replacing
- If the demonstration covers a **different action type** than what exists, it is **added** alongside existing knowledge
- After 3 successful uses of a learned method, its confidence should be promoted from `tentative` to `inferred`

---

## 7. Interpreting Analysis Results

### Action Types
| Type | Meaning |
|------|---------|
| `text_edit` | User typed text into an element |
| `text_replace` | User selected all text and typed replacement |
| `format_change` | User applied formatting (bold, italic, etc.) |
| `block_insert` | User created a new block (pressed Enter) |
| `block_delete` | User removed a block (Backspace/Delete) |
| `save` | User triggered save (Ctrl+S or button) |
| `paste` | User pasted content |

### Edit Methods
| Method | When Used |
|--------|-----------|
| `execCommand` | Browser's built-in editing API worked |
| `directDOM` | Text was changed via direct DOM mutation |
| `keyboard` | Keyboard events were the primary mechanism |
| `frameworkAPI` | A rich-text framework (Quill, ProseMirror, etc.) handled the edit |

### Quirks to Watch For
- **Slow editor**: Mutations appear >500ms after input — may need delays between operations
- **IME required**: Composition events present — international text input detected
- **Mutation bursts**: Multiple mutations per single input — editor does complex transforms
- **Ignored events**: Some keyboard events did not produce mutations — editor may filter input
