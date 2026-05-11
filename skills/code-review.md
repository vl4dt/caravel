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

## Review Guidelines

- Be specific: always include file paths and line numbers
- Provide concrete fixes, not just complaints
- Acknowledge good practices when you see them
- Prioritize: critical issues block the work, nice-to-have issues are optional
- If all checks pass, state "APPROVED: no issues found"
