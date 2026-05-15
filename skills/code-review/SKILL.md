---
name: code-review
description: Structured code review skill for the tech-lead agent. Use when reviewing implementation output for correctness, security, performance, and maintainability.
---

# Code Review

## Review Checklist

### Correctness
- [ ] Does the implementation match the task specification?
- [ ] Are there edge cases not handled?
- [ ] Does it follow existing code patterns in the project?
- [ ] Are error cases properly handled?

### Logic Error Detection (CRITICAL — blocks release)
- [ ] **Missing imports**: All imported modules/files exist and paths are correct
- [ ] **Missing definitions**: No undefined variables, functions, classes, or types referenced
- [ ] **Missing implementations**: No stub functions, placeholder implementations, or `// TODO` remnants
- [ ] **Unreachable branches**: No dead code or branches that can never execute
- [ ] **Type mismatches**: No type errors — function signatures match calls, return types match
- [ ] **Missing error handling**: No unhandled promises, missing try/catch for async code
- [ ] **Missing definitions**: All referenced variables are declared in scope

### Security
- [ ] No hardcoded secrets or credentials
- [ ] Input validation where applicable
- [ ] No SQL injection or XSS vulnerabilities
- [ ] Proper authentication/authorization checks

### Performance
- [ ] No unnecessary re-renders or computations
- [ ] Appropriate data structures for the use case
- [ ] No memory leaks or resource leaks
- [ ] Efficient algorithms (not O(n^2) when O(n) is possible)

### Maintainability
- [ ] Code is readable and well-commented where needed
- [ ] No code duplication (DRY principle)
- [ ] Appropriate function/component sizes
- [ ] Consistent naming conventions
- [ ] Proper file organization

### Testing
- [ ] Test files created where appropriate
- [ ] Tests cover happy path and edge cases
- [ ] Test naming is clear and descriptive

## Progress Feedback

During execution, emit structured progress messages for each review category so the user always sees what's happening:

**Start — beginning the review:**
```
🧐 Review: Authentication service implementation
  Category: all
  Status: in-progress
  Detail: Checking correctness, security, performance, maintainability...
```

**Each category as it's reviewed:**
```
🧐 Review: Authentication service — correctness
  Category: correctness
  Status: complete
  Result: All edge cases covered, error handling verified
```

```
🧐 Review: Authentication service — security
  Category: security
  Status: complete
  Result: 2 issues — missing rate limiting (important), token expiry OK (ok)
```

**Final output:**

```
🧐 Review: Authentication service — complete
  Category: all
  Status: complete
  Result: APPROVED
  Issues: 0 critical, 2 important, 0 nice-to-have
  Summary: Good implementation. Address rate limiting before merge.
```

```
🧐 Review: Authentication service — needs revision
  Category: all
  Status: complete
  Result: NEEDS_REVISION
  Critical issues: 1 — missing input validation on login endpoint
  Action: Developer must fix critical issues before resubmit
```

```
🧐 Review: Authentication service — critical
  Category: all
  Status: complete
  Result: CRITICAL
  Critical issues: 2 — SQL injection in user lookup, no CSRF protection
  Action: Block — developer must address both before any merge
```

## Review Output Format

```
## Assessment: APPROVED / NEEDS_REVISION / CRITICAL

## Issues

### [CRITICAL|IMPORTANT|NICE_TO_HAVE] Issue Title
- File: path/to/file.ts
- Line: N (if applicable)
- Problem: Description of the issue
- Fix: Suggested fix with code snippet

## Summary
- N critical issues
- N important issues  
- N nice-to-have issues
- Overall quality assessment
```

## Gate Check (Pre-Completion Verification)

**Before marking any task as complete, verify all of the following:**

1. **All referenced files exist** — grep for imports, requires, `from`, `import`
2. **No TODO/stub remnants** — search for `TODO`, `FIXME`, `PLACEHOLDER`, `stub`, `// @ts-ignore`
3. **No missing definitions** — all imported names resolve to actual exports
4. **No undefined variables** — all variables are declared before use
5. **No unreachable code** — all branches have valid paths
6. **All imports are valid** — module resolution works
7. **No placeholder implementations** — all functions have real implementations

If ANY gate check fails, the task is NOT complete and must be returned to the developer.

## Review Guidelines

- Be specific: always include file paths and line numbers
- Provide concrete fixes, not just complaints
- Acknowledge good practices when you see them
- Prioritize: critical issues block the work, nice-to-have issues are optional
- If all checks pass, state "APPROVED: no issues found"
