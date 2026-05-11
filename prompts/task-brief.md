---
name: task-brief
description: Generate a structured task brief for a specific agent. Use when decomposing a task into clear instructions for a fleet agent.
---

# Task Brief Template

Use this template when writing task descriptions for fleet agents.

## Template

```
## Task
[Brief description of what needs to be done]

## Context
- Relevant file paths:
- Existing patterns to follow:
- Dependencies on other components:

## Requirements
- [ ] Requirement 1
- [ ] Requirement 2
- [ ] Requirement 3

## Constraints
- Technical constraints (framework, language version, etc.)
- Non-functional constraints (performance, accessibility, etc.)

## Output Format
- Files to create/modify:
- Expected behavior:
- Test cases if applicable:

## Reference
- Similar existing code: path/to/similar/file
- Design system/patterns: description or path
```

## Examples

### Good Task Brief (Developer)

```
## Task
Create the UserSettings component for the settings page.

## Context
- Existing pattern: src/components/Card.tsx (similar structure)
- State management: use Zustand store (src/stores/settings.ts)
- Dependencies: UserSettingsForm, UserSettingsSidebar

## Requirements
- [ ] UserSettingsForm handles form state and validation
- [ ] UserSettingsSidebar shows navigation tabs
- [ ] Follow existing Card component styling pattern
- [ ] Include loading and error states

## Constraints
- TypeScript strict mode enabled
- Must use existing theme tokens (src/styles/theme.ts)
- No external form libraries

## Output Format
- src/components/UserSettings/UserSettings.tsx
- src/components/UserSettings/UserSettingsForm.tsx
- src/components/UserSettings/UserSettingsSidebar.tsx

## Reference
- Similar component: src/components/ProfileCard.tsx
- Theme tokens: src/styles/theme.ts
```

### Good Task Brief (Designer)

```
## Task
Review the UserSettings page implementation for visual quality.

## Context
- Component location: src/components/UserSettings/
- Screenshot: (will be attached when available)
- Design spec: figma.com/design/xxx (reference if available)

## Review Areas
1. Layout and spacing consistency
2. Color usage and contrast
3. Typography hierarchy
4. Form field styling
5. Responsive behavior

## Requirements
- [ ] Spacing follows 8px grid system
- [ ] Form fields have consistent styling with other forms
- [ ] Error states are visually clear
- [ ] Tab navigation is clearly active/inactive states

## Constraints
- Must match existing design system tokens
- Mobile-first approach required
```
