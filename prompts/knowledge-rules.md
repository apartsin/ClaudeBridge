# Claude Bridge — Knowledge Update Rules

When you learn something new about how a web application works — a selector, an edit method, a quirk, a workaround — you may propose a knowledge update to the bridge's profile system. Follow these rules strictly.

---

## 1. Universality Test

Before proposing an update, determine whether the knowledge is **universal** (applies to all instances of the app) or **instance-specific** (applies only to this particular site/document).

**Universal knowledge** goes into the **App Profile**:
- A CSS selector that works on all Google Sites pages.
- An edit method that applies to the entire application.
- A quirk of the editor engine (e.g., "Google Sites strips `<style>` tags on save").

**Instance-specific knowledge** goes into the **Instance Profile**:
- A custom theme class used only on this particular site.
- A non-standard block type added by a plugin on this specific page.
- An override to a selector that does not match the default on this instance.

**Rule**: If in doubt, store it as instance-specific. It can be promoted to universal later.

---

## 2. Conflict Check

Before writing a knowledge update, check whether the field you are updating already has a value.

- If the existing value has confidence `confirmed`, do **not** overwrite it. Report the conflict to the user.
- If the existing value has confidence `inferred` or `tentative`, you may overwrite it with equal or higher confidence.
- If the existing value has confidence `unknown`, you may overwrite freely.

Confidence ranking (lowest to highest):
```
unknown < tentative < inferred < confirmed
```

---

## 3. Constructing a Patch

A knowledge update is a **patch object** — a partial profile that gets merged into the existing profile. Include only the fields you are updating.

Every patch must include:
- **confidence** — Your confidence level for this update.
- **source** — Who or what produced this knowledge: `"claude"`, `"human"`, or `"auto"`.

### Patch Example

```json
{
  "selectors": {
    "blocks": {
      "paragraph": {
        "value": "div.paragraph-block",
        "confidence": "inferred",
        "seenCount": 3
      }
    }
  }
}
```

### Confidence Assignment Guidelines

| Confidence   | When to use                                                    |
|-------------|----------------------------------------------------------------|
| `confirmed` | User explicitly verified the value, or it was validated in 5+ sessions |
| `inferred`  | Derived from DOM inspection and tested successfully at least once      |
| `tentative` | A reasonable guess based on patterns, not yet validated                |
| `unknown`   | Default for new entries with no supporting evidence                    |

---

## 4. Update Triggers

### When to Update the App Profile

- You discover a selector that works consistently across multiple pages of the same application.
- You identify an edit method or quirk that is inherent to the application, not the specific page.
- A `tentative` or `inferred` entry is verified across 3+ distinct instances.

### When to Update the Instance Profile

- A selector override is needed because this specific page diverges from the app default.
- A custom block type or layout element exists only on this instance.
- User-specific configuration affects the DOM structure for this page.

### When NOT to Update

- You are uncertain whether the knowledge applies beyond this session.
- The observation was from a single, potentially transient DOM state (e.g., a loading spinner, a modal overlay).
- The existing profile entry has higher confidence than your proposed update.

---

## 5. Announcing Updates

When you propose a knowledge update, inform the user:

1. **What** you learned (the specific selector, action, or quirk).
2. **Where** it will be stored (App Profile or Instance Profile).
3. **Confidence** level and why.
4. **Conflicts**, if any, with existing profile data.

Example announcement:

> I noticed that paragraph blocks on this Google Sites page use the selector `div.wysiwyg-paragraph`. This matches across 3 pages I have explored. I will update the App Profile for `sites.google.com` with confidence `inferred`.

The bridge will process the update and log it in the profile changelog. You do not need to manage the changelog directly.

---

## 6. Merging and Promotion

Over time, instance-specific knowledge may be promoted to universal:

- If the same delta appears in 3+ Instance Profiles for the same domain, consider proposing it as an App Profile update.
- When promoting, set confidence to at least `inferred`.
- Remove the corresponding delta from each Instance Profile after promotion to avoid duplication.

Promotion is a suggestion — the bridge or user may decline it.
