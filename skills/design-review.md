---
name: design-review
description: Visual design review skill for the designer agent. Use when reviewing UI implementations, screenshots, or visual output for quality, consistency, and accessibility.
---

# Design Review

## Review Checklist

### Layout & Structure
- [ ] Elements are properly aligned (grid-based layout)
- [ ] Consistent spacing and padding throughout
- [ ] Content hierarchy is clear (primary vs secondary elements)
- [ ] Responsive design considerations where applicable

### Visual Consistency
- [ ] Color scheme is consistent with design system
- [ ] Typography is consistent (font sizes, weights, families)
- [ ] Component styles match existing patterns
- [ ] Border radius, shadows, and other visual treatments are consistent

### Accessibility
- [ ] Sufficient color contrast (WCAG AA minimum)
- [ ] Interactive elements have clear hover/active/focus states
- [ ] Text is readable at expected sizes
- [ ] Touch targets are adequate size (min 44x44px for mobile)

### User Experience
- [ ] Navigation is intuitive and discoverable
- [ ] User feedback is provided for actions (loading, success, error states)
- [ ] No unexpected or jarring transitions
- [ ] Content is scannable and digestible

### Polish
- [ ] No visual glitches or rendering artifacts
- [ ] Icons and images are appropriate and properly sized
- [ ] Animations/transitions are smooth (where applicable)
- [ ] Edge cases handled (empty states, loading states, error states)

## Progress Feedback

During execution, emit structured progress messages for each review category so the user always sees what's happening:

**Start — beginning the review:**
```
🧐 Review: Login page implementation
  Category: all
  Status: in-progress
  Detail: Checking layout, visual consistency, accessibility, UX, polish...
```

**Each category as it's reviewed:**
```
🧐 Review: Login page — layout & structure
  Category: layout & structure
  Status: complete
  Result: Grid-aligned, consistent spacing, clear hierarchy
```

```
🧐 Review: Login page — accessibility
  Category: accessibility
  Status: complete
  Result: 1 issue — color contrast on secondary text fails WCAG AA
```

**Final output:**

```
🧐 Review: Login page — complete
  Category: all
  Status: complete
  Result: APPROVED
  Issues: 0 critical, 1 important, 3 polish
  Summary: Solid design. Fix contrast on secondary text for WCAG compliance.
```

```
🧐 Review: Login page — needs revision
  Category: all
  Status: complete
  Result: NEEDS_REVISION
  Critical issues: 1 — touch targets on icon buttons below 44px minimum
  Action: Developer must increase touch target sizes before merge
```

```
🧐 Review: Login page — critical
  Category: all
  Status: complete
  Result: CRITICAL
  Critical issues: 2 — zero contrast ratio on primary CTA, no focus states on interactive elements
  Action: Block — both accessibility violations must be fixed before any merge
```

## Review Output Format

```
## Assessment: APPROVED / NEEDS_REVISION / CRITICAL

## Issues

### [CRITICAL|IMPORTANT|NICE_TO_HAVE] Issue Title
- Element: description of the element/component
- File: path/to/file (if identifiable)
- Problem: What's visually wrong or inconsistent
- Fix: Suggested improvement with specifics

## Visual Notes
- Overall aesthetic assessment
- Strengths and what works well

## Summary
- N critical issues
- N important issues
- N polish items
- Overall quality assessment
```

## Review Guidelines

- Be visual and specific: describe what you see, not what you expect
- Compare to existing patterns in the project when possible
- Consider different screen sizes and contexts
- Distinguish between "must fix" and "could be better"
- If everything looks good, state "APPROVED: no visual issues found"
