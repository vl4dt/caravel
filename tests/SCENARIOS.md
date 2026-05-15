# Caravel Test Battery — Scenarios, Benchmarks & Tutorials

> A comprehensive battery of life-like test scenarios that serve as:
> - **Documentation** — how to use every Caravel feature
> - **Tutorials** — step-by-step guides for each capability
> - **Benchmarks** — compare different models side-by-side
> - **Validation** — verify all features work correctly

---

## Table of Contents

- [Tier 1: Foundational Tests](#tier-1-foundational)
- [Tier 2: Intermediate Tests](#tier-2-intermediate)
- [Tier 3: Advanced Tests](#tier-3-advanced)
- [Benchmark Suite](#benchmark-suite)
- [Agent Quick Reference](#agent-quick-reference)
- [Feature Coverage Matrix](#feature-coverage-matrix)
- [Expected Outputs](#expected-outputs)

---

## Overview Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        CARAVEL FLEET                        │
│                                                              │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐             │
│  │ Planner  │───▶│ Supervisor│───▶│ Developer│             │
│  │  (plan)  │    │  (route)  │    │ (execute)│             │
│  └──────────┘    └────┬─────┘    └──────────┘             │
│                       │                                      │
│              ┌────────▼────────┐                            │
│              │  Two-Stage      │                            │
│              │  Review Loop    │                            │
│              │                 │                            │
│              │ ┌────────────┐  │ ┌────────────┐           │
│              │ │ Code Review│──┼▶│Design Review│          │
│              │ │(Tech Lead) │  │ │(Designer)  │          │
│              │ └────────────┘  │ └────────────┘           │
│              └─────────────────┘                          │
│                       │                                    │
│              ┌────────▼────────┐                          │
│              │   Metrics +     │                          │
│              │   Integrations  │                          │
│              └─────────────────┘                          │
│                                                              │
│  Agents: developer │ tech-lead │ designer │ documenter     │
│              │      │ planner   │ auditor   │                │
└──────────────────────────────────────────────────────────────┘
```

---

<a id="tier-1-foundational"></a>
## Tier 1: Foundational Tests

### S1 — Basic Fleet Orchestration

**Purpose**: Verify the core fleet workflow — plan → execute → review → complete.

**Complexity**: ★☆☆☆☆ (Beginner)
**Models**: Any — this tests the pipeline, not the model quality.

```
Test Flow:
─────────
planner    → creates phases/tasks
tech-lead  → reviews architecture
developer  → implements code
designer   → reviews UI (if any)
tech-lead  → code review gate
designer   → design review gate
```

#### Project: CLI Task Manager

A simple command-line task manager with CRUD operations for to-do items.

```javascript
// Step 1: Plan the project
plan_project({
  name: "CLI Task Manager",
  phases: [
    {
      name: "Project Setup & Core Model",
      tasks: [
        {
          agent: "developer",
          task: "Create a Node.js project with package.json, TypeScript config, and a src directory structure (src/core/, src/cli/, src/utils/). Add basic linting and formatting config.",
          acceptance_criteria: "npm install runs without errors, TypeScript compiles cleanly, project structure has at least 3 directories",
          testability: "npm run build succeeds with exit code 0"
        },
        {
          agent: "tech-lead",
          task: "Design the Task model interface (id, title, description, completed, createdAt, updatedAt) and define the storage interface. Document the design decisions in src/ARCHITECTURE.md.",
          acceptance_criteria: "Task interface defined with all required fields, storage abstraction defined, architecture doc exists",
          testability: "ARCHITECTURE.md exists with interface definitions"
        }
      ]
    },
    {
      name: "Core Implementation",
      tasks: [
        {
          agent: "developer",
          task: "Implement the TaskService class with methods: createTask(title, description), updateTask(id, updates), deleteTask(id), getTask(id), listTasks(statusFilter), toggleComplete(id). Store tasks in a JSON file (data/tasks.json).",
          acceptance_criteria: "All 6 methods implemented, JSON file storage working, proper error handling for missing/invalid IDs",
          testability: "Create a test file that calls each method and verifies output: create task → verify in list → toggle → verify status → delete → verify removed from list"
        },
        {
          agent: "developer",
          task: "Implement the CLI layer using Commander.js or a simple readline loop. Commands: add, list, complete, delete, clear. Each command should call the appropriate TaskService method and display formatted output.",
          acceptance_criteria: "All 5 CLI commands work, output is formatted and readable, graceful error messages",
          testability: "Test each command: add 'Buy milk' → verify in list, list → shows the task, complete 1 → status changed, delete 1 → task gone"
        }
      ]
    },
    {
      name: "Review & Polish",
      tasks: [
        {
          agent: "tech-lead",
          task: "Perform code review on TaskService and CLI implementation. Check for: error handling completeness, type safety, code duplication, naming consistency. Fix any issues found.",
          acceptance_criteria: "No TODO comments, all methods have proper error handling, types are consistent, no duplicate code",
          testability: "npm lint passes, all types compile without errors"
        },
        {
          agent: "tech-lead",
          task: "Write unit tests for TaskService using Jest. Test: create/read/update/delete operations, invalid input handling, file not found recovery, duplicate ID prevention.",
          acceptance_criteria: "Tests for all 6 TaskService methods, error handling tests, at least 10 test cases total",
          testability: "npm test passes with 100% test suite success"
        }
      ]
    }
  ]
})

// Step 2: Execute the fleet
fleet_control(action = "go")
```

#### Verification Checklist

| Check | Expected |
|-------|----------|
| `package.json` exists | ✓ |
| `tsconfig.json` exists | ✓ |
| `src/TaskService.ts` exists with 6 methods | ✓ |
| `src/cli/` has working CLI code | ✓ |
| `npm test` passes | ✓ |
| `npm run build` succeeds | ✓ |
| All review cycles completed | ✓ |

#### Expected Output Format

```
▸ T1 [DONE] developer → Project Setup & Core Model (3m 12s) | 45k tokens ✓✓
▸ T2 [DONE] tech-lead → Design Task model & architecture (2m 45s) | 28k tokens ✓✓
▸ T3 [DONE] developer → TaskService with 6 CRUD methods (4m 33s) | 52k tokens ✓✓
▸ T4 [DONE] developer → CLI layer with Commander.js (3m 21s) | 34k tokens ✓✓
▸ T5 [DONE] tech-lead → Code review + fixes (2m 15s) | 22k tokens ✓✓
▸ T6 [DONE] tech-lead → Unit tests (3m 02s) | 38k tokens ✓✓

Fleet complete: 6/6 tasks | 21m 8s total | 219k tokens
```

---

<a id="tier-1-design"></a>
### S2 — Design Review Pipeline (UI-Focused)

**Purpose**: Verify the designer agent's visual review capabilities, design token consistency checking, and responsive behavior verification.

**Complexity**: ★★☆☆☆ (Early Intermediate)

```
Test Flow:
─────────
planner    → plans UI-heavy project
developer  → builds UI components
designer   → visual review (layout, colors, typography)
designer   → design token check (consistent values)
designer   → responsive check (mobile/tablet/desktop)
tech-lead  → code review (if needed)
```

#### Project: Kanban Board UI

A responsive Kanban board with drag-and-drop functionality, built with HTML/CSS/JS (no framework to test pure CSS).

```javascript
plan_project({
  name: "Responsive Kanban Board",
  phases: [
    {
      name: "Design System Foundation",
      tasks: [
        {
          agent: "designer",
          task: "Create a CSS design system: define CSS custom properties (design tokens) for colors (--color-primary, --color-bg, --color-text, --color-border, --shadow-sm, --shadow-md, --radius-sm, --radius-md), typography scale, spacing scale (--space-xs to --space-xl), and border-radius variables. Create a design-tokens.css file.",
          acceptance_criteria: "design-tokens.css with 15+ custom properties, consistent naming convention, light and dark color variants",
          testability: "Open the HTML page and verify all colors are consistent, spacing is uniform, borders match the design"
        }
      ]
    },
    {
      name: "Core Components",
      tasks: [
        {
          agent: "developer",
          task: "Build the Kanban board components: Board (container with header), Column (with title, task count, task list), Card (with title, description, tags). Use only CSS Grid/Flexbox — no frameworks. Make columns horizontally scrollable and cards draggable with HTML5 Drag and Drop API.",
          acceptance_criteria: "All components rendered correctly, drag-and-drop works (reorder cards within column), columns are horizontally scrollable when there are many",
          testability: "Test at 3 widths: 375px (mobile), 768px (tablet), 1440px (desktop). Verify layout adapts. Drag 3+ cards between columns to verify persistence"
        }
      ]
    },
    {
      name: "Enhanced Features",
      tasks: [
        {
          agent: "developer",
          task: "Add: card detail modal (click card → modal with full details), column context menu (add task, rename, delete), drag-and-drop between columns, localStorage persistence, smooth transitions and micro-interactions, keyboard navigation support.",
          acceptance_criteria: "Modal opens/closes properly, all columns have context menu, drag-between-columns works, data persists across refresh, accessible via keyboard (Tab + Enter)",
          testability: "Test all interactive elements: drag card to column → reload → verify position. Tab through all cards → Enter to open modal → Escape to close"
        },
        {
          agent: "designer",
          task: "Perform comprehensive design review: 1) Design token consistency — verify no hardcoded color values exist outside design-tokens.css, 2) Responsive behavior — verify layout at 375px, 768px, 1440px breakpoints, 3) Accessibility — verify color contrast (WCAG AA), keyboard navigation, focus states, 4) Polish — verify transitions are smooth, empty states are handled, hover states exist for all interactive elements.",
          acceptance_criteria: "No hardcoded colors in components, responsive layout verified at all breakpoints, color contrast passes AA, all interactive elements have focus states",
          testability: "Use browser DevTools: Lighthouse audit → accessibility ≥ 90, Performance ≥ 80, Responsive viewport test at 3 sizes"
        }
      ]
    },
    {
      name: "Code Review & Polish",
      tasks: [
        {
          agent: "tech-lead",
          task: "Code review: check for missing imports (not applicable for pure CSS/HTML/JS), undefined references, event listener leaks, memory management in drag-and-drop, code organization, naming consistency. Verify no stub/placeholder code remains.",
          acceptance_criteria: "No memory leaks in drag handlers, event listeners cleaned up, code organized into logical modules (board.js, column.js, card.js, drag.js, storage.js)",
          testability: "Run in browser DevTools: Memory → Heap snapshot comparison before/after 10 drag operations → verify no growing references"
        }
      ]
    }
  ]
})

fleet_control(action = "go")
```

#### Designer Review Output (Expected)

```
═══ DESIGN REVIEW ═══
─────────────────────────────
✓ Design tokens: All colors use CSS variables (0 hardcoded values)
✓ Responsive: 375px - OK | 768px - OK | 1440px - OK
✓ Accessibility: Color contrast 4.8:1 (AA pass) | Focus visible ✓
✓ Polish: Hover states ✓ | Transitions smooth ✓ | Empty states handled ✓
═════════════════════════════
Result: APPROVED
```

#### ASCII: Kanban Board Layout

```
┌─────────────────────────────────────────────────────────┐
│  📋 KANBAN BOARD                    [+ Add Column]      │
├──────────────┬──────────────┬───────────────────────┐
│  TO DO (3)   │  IN PROGRESS │     DONE (1)         │
│              │   (2)        │                      │
│ ┌──────────┐ │ ┌──────────┐ │ ┌──────────────────┐ │
│ │ User     │ │ │ Auth     │ │ │ Setup project    │ │
│ │ stories  │ │ │ middleware│ │ │                  │ │
│ └──────────┘ │ └──────────┘ │ └──────────────────┘ │
│              │              │                       │
│ ┌──────────┐ │ ┌──────────┐ │                       │
│ │ Fix bug  │ │ │ Write    │ │                       │
│ │ #142     │ │ │ tests    │ │                       │
│ └──────────┘ │ └──────────┘ │                       │
│              │              │                       │
└──────────────┴──────────────┴───────────────────────┘
```

---

<a id="tier-1-code"></a>
### S3 — Logic Error Detection (Backend Focus)

**Purpose**: Verify the tech-lead agent's enhanced logic error detection — catching missing imports, undefined references, stub code, type mismatches, and missing error handling.

**Complexity**: ★★☆☆☆ (Early Intermediate)

```
Test Flow:
─────────
planner    → plans API project
developer  → implements API endpoints
tech-lead  → code review with LOGIC ERROR DETECTION
tech-lead  → catches: missing imports, type mismatches,
             stub code, error handling gaps
developer  → fixes detected issues
tech-lead  → re-reviews
```

#### Project: REST API Task Service

A Node.js/Express REST API with proper error handling, validation, and documentation.

```javascript
plan_project({
  name: "REST API Task Service",
  phases: [
    {
      name: "API Foundation",
      tasks: [
        {
          agent: "developer",
          task: "Create Express.js REST API with: middleware for error handling (custom Error class, error middleware), request validation (Joi or Zod), response formatting utility. Set up folder structure: src/routes/, src/middleware/, src/models/, src/controllers/.",
          acceptance_criteria: "Error middleware catches all unhandled errors, returns consistent error format, validation middleware rejects invalid requests with 400 status",
          testability: "Send malformed request → verify 400 response with error details. Send request that triggers 500 → verify error middleware catches it"
        }
      ]
    },
    {
      name: "Task CRUD Endpoints",
      tasks: [
        {
          agent: "developer",
          task: "Implement Task CRUD API: POST /api/tasks (create), GET /api/tasks (list with ?status=, ?limit=, ?offset= query params), GET /api/tasks/:id (get single), PUT /api/tasks/:id (update), DELETE /api/tasks/:id (delete). Each endpoint validates input, handles errors properly, and returns appropriate HTTP status codes.",
          acceptance_criteria: "All 5 endpoints working, proper HTTP methods, 200/201/400/404/500 status codes used correctly, query params for filtering/pagination working",
          testability: "Test with curl: curl -X POST localhost:3000/api/tasks -d '{title:Test}' → 201. GET with ?limit=10 → verify pagination. GET /nonexistent → 404"
        },
        {
          agent: "tech-lead",
          task: "Perform code review with enhanced logic error detection. Check specifically for: (1) Missing imports — are all modules imported? (2) Undefined references — are all variables/functions defined before use? (3) Stub code — any placeholder implementations or console.log debugging code? (4) Type mismatches — do request params match expected types? (5) Error handling gaps — are all async operations wrapped? Missing DB operations? (6) Input validation — is all user input validated?",
          acceptance_criteria: "All imports verified, no undefined references, no console.log or TODO comments, types match, every async path has error handling",
          testability: "Run: node --check src/app.js to verify syntax. Then run each endpoint with invalid inputs to verify error handling"
        }
      ]
    },
    {
      name: "Validation & Security",
      tasks: [
        {
          agent: "developer",
          task: "Add comprehensive validation: task title required (min 1, max 100 chars), description optional (max 1000 chars). Add security middleware: rate limiting (express-rate-limit), CORS configuration, helmet security headers, input sanitization (escape HTML in task fields). Add response caching for GET endpoints.",
          acceptance_criteria: "Title validation enforced (too short/too long rejected), rate limiter configured (100 req/min), helmet headers present (X-Content-Type-Options, X-Frame-Options, etc.), HTML escaped in responses",
          testability: "Test validation: POST with empty title → 400. POST with 101-char title → 400. Verify headers: curl -I localhost:3000/api/tasks → check helmet headers present"
        }
      ]
    }
  ]
})

fleet_control(action = "go")
```

#### Logic Error Detection Examples (What Should Be Caught)

```
═══════ LOGIC ERROR DETECTION REPORT ═══

❌ CRITICAL: Missing import — 'express-rate-limit' used in src/app.js:12
   but not imported at top of file.

❌ WARNING: Possible undefined reference — 'sanitizeInput' used in 
   src/controllers/task.js:24 but not defined in any file.

⚠️  STUB CODE FOUND — src/controllers/task.js:31:
    console.log('TODO: implement pagination')
    return res.json({ tasks: [] })

❌ TYPE MISMATCH — req.params.id is string but taskById() expects number.
   Suggested fix: const id = parseInt(req.params.id, 10)

═══════ GATE CHECK ═══

❌ GATE FAILED — 3 issues found. Review REJECTED.
   - Fix all issues above, then re-submit for review.
   - Remove all console.log statements
   - Add import for express-rate-limit
   - Define sanitizeInput or import from utils
═════════════════════════════
```

---

<a id="tier-1-doc"></a>
### S4 — Documentation Generator (Documenter Agent)

**Purpose**: Verify the Documenter agent's ability to write, maintain, and cross-reference documentation. Test the "never leave stale docs" rule.

**Complexity**: ★☆☆☆☆ (Beginner)

#### Project: Markdown Documentation Generator

A tool that analyzes a codebase and generates documentation files.

```javascript
plan_project({
  name: "Codebase Documentation Generator",
  phases: [
    {
      name: "Analysis Engine",
      tasks: [
        {
          agent: "developer",
          task: "Build the analysis engine: readFiles(dir) to recursively find all source files, extractComments(file) to parse code comments, extractFunctions(file) to parse function signatures (name, params, return type), extractClasses(file) to parse class definitions with methods and properties.",
          acceptance_criteria: "Extracts functions with names/types/params, classes with methods, comments with JSDoc-style annotations. Handles .ts, .js, .tsx, .jsx files",
          testability: "Run on the caravel repo itself: analyze src/ → verify it finds all .ts files, extracts function names, and parses class structures"
        },
        {
          agent: "documenter",
          task: "Write the initial README.md for the documentation generator project. Include: project description, features list, installation instructions, usage examples (command-line interface), configuration options, architecture overview, and contribution guidelines. Reference all key source files with their paths.",
          acceptance_criteria: "README.md exists with all required sections, all file paths are accurate and match the actual repo structure, installation steps work, usage examples are complete",
          testability: "Run the documented installation commands. Verify README file paths by checking each referenced file exists"
        }
      ]
    },
    {
      name: "Documentation Output",
      tasks: [
        {
          agent: "documenter",
          task: "Generate comprehensive API documentation: create docs/API.md with all exported functions/classes documented including signatures, descriptions, params (types + descriptions), return types, and examples. Create docs/ARCHITECTURE.md explaining the design decisions, data flow, and module relationships.",
          acceptance_criteria: "All exported APIs documented with full signatures, all design decisions have rationale, architecture doc includes a module dependency diagram",
          testability: "Read docs/API.md and verify every exported function appears. Read docs/ARCHITECTURE.md and verify the dependency diagram matches actual imports"
        },
        {
          agent: "documenter",
          task: "Write developer guide: docs/DEVELOPER.md covering how to set up the dev environment, run tests, add new features, and common pitfalls. Include code examples for each section.",
          acceptance_criteria: "All setup steps are accurate, examples work when followed, common pitfalls documented with solutions",
          testability: "Follow the guide from scratch: clean install → run tests → verify all pass"
        }
      ]
    },
    {
      name: "Documentation Audit",
      tasks: [
        {
          agent: "auditor",
          task: "Perform documentation audit: verify all file paths in docs match reality, check for dead links, verify all code examples are current and accurate, ensure consistent terminology across all documents, verify README matches the actual project state.",
          acceptance_criteria: "Zero dead links, zero stale file paths, all code examples verified, consistent terminology (e.g., 'documentation generator' not 'doc generator' mixed)",
          testability: "For each file path in docs: check file exists. For each code example: run it and verify output"
        }
      ]
    }
  ]
})

fleet_control(action = "go")
```

#### Documenter Agent Workflow

```
┌─────────────────────────────────────┐
│       Documenter Agent              │
│                                     │
│  1. READ all source files           │
│     → understand code structure     │
│                                     │
│  2. WRITE docs (README, API, etc.)  │
│     → with accurate paths           │
│     → with working examples         │
│                                     │
│  3. CROSS-REFERENCE between docs    │
│     → API.md links to ARCHITECTURE  │
│     → README links to API.md        │
│                                     │
│  4. AUDIT for staleness             │
│     → paths exist?                  │
│     → examples work?                │
│     → terminology consistent?       │
│                                     │
│  ✓ All docs current and accurate    │
└─────────────────────────────────────┘
```

---

<a id="tier-2-intermediate"></a>
## Tier 2: Intermediate Tests

### S5 — Full-Stack Application (All Features)

**Purpose**: Test ALL Caravel features simultaneously — all agents, reviews, metrics, and integrations.

**Complexity**: ★★★★★ (Advanced)
**Models**: Test with 2+ models to compare quality and speed.

#### Project: Personal Finance Tracker

A full-stack web application: React frontend + Node.js API + SQLite database.

```javascript
plan_project({
  name: "Personal Finance Tracker",
  phases: [
    {
      name: "Project Architecture & Setup",
      tasks: [
        {
          agent: "tech-lead",
          task: "Design the full-stack architecture: frontend (React with Vite, React Router, CSS Modules), backend (Express + SQLite with better-sqlite3), database schema (users, transactions, categories, budgets). Document in PROJECT-DESIGN.md with a system architecture diagram showing data flow from UI → API → DB.",
          acceptance_criteria: "Architecture diagram in PROJECT-DESIGN.md, all tech choices justified, database schema with ER diagram, clear separation of concerns",
          testability: "Review diagram: can trace a transaction from UI click → API route → DB query → response back"
        },
        {
          agent: "developer",
          task: "Set up the project: monorepo structure with packages/frontend/ and packages/backend/. Configure Vite for frontend (React, Router), Express for backend. Set up SQLite with schema migration system. Configure ESLint + Prettier with shared config.",
          acceptance_criteria: "Both apps start independently (npm run dev in each), shared TypeScript config works, build succeeds for both apps",
          testability: "npm run dev in frontend → loads at localhost:5173. npm run dev in backend → loads at localhost:3000. Both compile with zero errors"
        }
      ]
    },
    {
      name: "Backend API",
      tasks: [
        {
          agent: "developer",
          task: "Implement backend API: auth routes (POST /api/auth/register, POST /api/auth/login with JWT), transaction routes (CRUD for /api/transactions), category routes (CRUD for /api/categories), budget routes (GET/POST /api/budgets). Include input validation, JWT middleware, and proper error handling for all endpoints.",
          acceptance_criteria: "All 12+ API endpoints working, JWT authentication enforced on protected routes, input validation on all mutable endpoints, proper HTTP status codes",
          testability: "Test auth flow: register → get JWT → use JWT for protected endpoint → verify works. Test with invalid JWT → verify 401. Test missing fields → verify 400"
        },
        {
          agent: "tech-lead",
          task: "Code review of backend API: verify all imports are present, no stub code, error handling complete on every async path, type safety with TypeScript (no any types), security checks (JWT verification, input validation, SQL injection prevention), performance (no N+1 queries).",
          acceptance_criteria: "No 'any' types in production code, all SQL queries use parameterized statements, JWT verified on every protected route, error middleware catches all errors",
          testability: "Run: node -e \"require('./packages/backend')\" to verify startup. Then test each endpoint with curl for error cases"
        },
        {
          agent: "developer",
          task: "Write backend API tests: test auth flow (register/login/logout), transaction CRUD with validation, category management, budget calculations. Use supertest for HTTP testing and in-memory SQLite for test database.",
          acceptance_criteria: "15+ test cases covering all API endpoints, auth flow tested end-to-end, error cases tested (invalid input, unauthorized, not found)",
          testability: "npm test in backend → all tests pass with 100% success"
        }
      ]
    },
    {
      name: "Frontend UI",
      tasks: [
        {
          agent: "developer",
          task: "Build the React frontend: Auth pages (login/register), Dashboard with spending summary (total income, total expenses, net balance), Transaction list with filtering (by date, category, type), Transaction form (add/edit with categories), Categories management page, Budget overview page. Use CSS Modules for styling.",
          acceptance_criteria: "All pages route correctly, forms validate client-side, dashboard shows real data from API, transaction list supports filtering, all interactive elements work",
          testability: "Visit each route, test each form, verify data displays from API. Check at 3 viewport sizes: 375px, 768px, 1440px"
        },
        {
          agent: "designer",
          task: "Perform comprehensive design review of the frontend: 1) Visual consistency — verify color scheme, typography, spacing consistent across all pages, 2) Design token usage — no hardcoded colors/values, 3) Responsive behavior — verify layout at 375px (mobile), 768px (tablet), 1440px (desktop), 4) Accessibility — color contrast, focus states, keyboard navigation, 5) UX polish — loading states, empty states, error states, micro-interactions.",
          acceptance_criteria: "All pages use consistent design tokens, responsive at all breakpoints, color contrast ≥ 4.5:1, keyboard accessible, all edge states handled",
          testability: "Run Lighthouse audit: Accessibility ≥ 90, Performance ≥ 80, Best Practices ≥ 90. Manually test keyboard navigation (Tab through every element)"
        },
        {
          agent: "developer",
          task: "Build the data visualization components: bar chart for monthly spending (CSS-only or lightweight chart library), pie chart for category breakdown, line chart for spending trend. Make charts responsive and accessible with proper ARIA labels.",
          acceptance_criteria: "3 chart types working with real API data, charts resize with viewport, accessible (keyboard accessible, screen reader labels)",
          testability: "Verify charts render with real data. Resize window → verify charts redraw. Tab to charts → verify keyboard navigation"
        }
      ]
    },
    {
      name: "Metrics & Monitoring Setup",
      tasks: [
        {
          agent: "developer",
          task: "Integrate metrics collection: set up the Caravel metrics system to collect and export metrics for the application. Configure logging middleware for API request tracking. Set up basic health check endpoint (/api/health).",
          acceptance_criteria: "Metrics collected for API requests (duration, status, method), health endpoint returns service status, logs formatted and structured",
          testability: "Make several API requests → verify metrics file is updated. Hit /api/health → verify 200 with service info"
        }
      ]
    }
  ]
})

fleet_control(action = "go")
```

#### Full-Stack Architecture Diagram

```
┌────────────────────────────────────────────────────────────┐
│                    Client Browser                          │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌────────┐  │
│  │  Login   │  │ Dashboard│  │ Transactions│ │ Budgets │  │
│  │ Register │  │ (charts) │  │ (filter)   │  │(charts)│  │
│  └──────────┘  └──────────┘  └───────────┘  └────────┘  │
└──────────────────────────┬─────────────────────────────────┘
                           │ HTTP/JSON
                           ▼
┌────────────────────────────────────────────────────────────┐
│                   Express API Server                       │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌─────────┐  │
│  │ Auth    │  │ Tasks    │  │ Categories│  │ Budgets │  │
│  │ Routes  │  │ Routes   │  │ Routes    │  │ Routes  │  │
│  └────┬────┘  └────┬─────┘  └─────┬─────┘  └────┬────┘  │
│       │             │              │              │        │
│       └───────── JWT MIDDLEWARE ───┘              │        │
│                           │                        │        │
│                    ┌──────▼──────┐                 │        │
│                    │  Validator  │                 │        │
│                    └──────┬──────┘                 │        │
│                           │                        │        │
│                    ┌──────▼──────┐                 │        │
│                    │ Metrics     │                 │        │
│                    │ Collector   │                 │        │
│                    └──────┬──────┘                 │        │
└───────────────────────────┼─────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────┐
│          SQLite Database           │
│  ┌──────────┐  ┌──────────┐       │
│  │  users   │  │  txns    │       │
│  │  (id,    │  │  (id,    │       │
│  │   email, │  │   user_id,│       │
│  │   hash)  │  │   amount, │       │
│  └──────────┘  │   cat_id) │       │
│                 └──────────┘       │
│  ┌──────────┐  ┌──────────┐       │
│  │categories│  │  budgets │       │
│  └──────────┘  └──────────┘       │
└────────────────────────────────────┘
```

---

### S6 — Metrics & Integrations

**Purpose**: Verify metrics collection accuracy and integration delivery mechanisms.

**Complexity**: ★★★☆☆ (Intermediate)

#### Project: Metrics-Enabled API Service

Build an API service with full metrics collection and Telegram notification integration.

```javascript
// This scenario focuses on verifying metrics and integrations
plan_project({
  name: "Metrics & Integration Test Service",
  phases: [
    {
      name: "Metrics System Setup",
      tasks: [
        {
          agent: "developer",
          task: "Set up the Caravel metrics collection system in this project. Create a metrics middleware for Express that records: request duration (ms), response status code, method, endpoint path, and user agent. Configure metrics export to both JSON (.caravel/metrics-YYYY-MM-DD.json) and CSV (.caravel/metrics-YYYY-MM-DD.csv) formats. Include metrics for all previously defined fleet metrics (task_duration, review_count, tokens, pass/fail rates).",
          acceptance_criteria: "Metrics middleware correctly records all fields, export functions work for both formats, metrics directory created, files generated after first request",
          testability: "Make 5 test API requests → verify metrics file exists → verify 5 entries → verify CSV has correct headers and data"
        }
      ]
    },
    {
      name: "Telegram Integration",
      tasks: [
        {
          agent: "developer",
          task: "Implement Telegram notification integration. Create a notification service that can send: task start notifications (with agent name, task ID, phase), task completion notifications (with duration, pass/fail status), review results (with pass/fail, issues found), and error alerts (with stack trace summary). Implement a monitor mode that sends periodic fleet status updates.",
          acceptance_criteria: "All 4 notification types work, configuration via environment variables or config file, error handling for failed sends (retry with backoff)",
          testability: "Configure with test bot → send a test notification → verify message appears in Telegram chat. Test error handling with invalid token"
        }
      ]
    },
    {
      name: "Review & Verification",
      tasks: [
        {
          agent: "tech-lead",
          task: "Code review with focus on: metrics accuracy (are all values correct?), error handling in notification service (what happens if Telegram is down?), security (are bot tokens and API keys handled securely?). Verify no hardcoded secrets.",
          acceptance_criteria: "No hardcoded secrets, all sensitive config via env vars, error handling for all external calls, metrics data validated before export",
          testability: "Check for hardcoded tokens: grep -r 'api_key\\|token' src/ → verify no hardcoded values"
        }
      ]
    }
  ]
})

fleet_control(action = "go")
```

---

<a id="tier-2-doc"></a>
### S7 — Documentation-Heavy Project (Documenter Focus)

**Purpose**: Test the Documenter agent's capabilities in a documentation-centric project where accuracy and cross-referencing are critical.

**Complexity**: ★★★☆☆ (Intermediate)

#### Project: API Documentation Site

Build a static documentation website from API spec files.

```javascript
plan_project({
  name: "API Documentation Generator",
  phases: [
    {
      name: "Schema Parser",
      tasks: [
        {
          agent: "developer",
          task: "Create a schema parser that reads OpenAPI 3.0 spec files (YAML/JSON) and extracts: paths (method, url, parameters), request body schemas, response schemas, authentication requirements, and example requests/responses.",
          acceptance_criteria: "Parses all OpenAPI 3.0 features used: params, body, headers, responses, security schemes",
          testability: "Parse the Express/Express-like API spec → verify all endpoints extracted correctly"
        },
        {
          agent: "documenter",
          task: "Create the initial documentation structure: docs/index.md (overview), docs/api/ with one file per endpoint group (auth.md, users.md, transactions.md). Each doc includes: endpoint URL, HTTP method, required headers, request parameters (with types), request body schema, response schema (success and error), and example curl commands.",
          acceptance_criteria: "All endpoints documented, all schemas complete, examples accurate, consistent formatting across all files",
          testability: "Read each API doc → verify curl examples would work → verify schema matches spec"
        }
      ]
    },
    {
      name: "Website Builder",
      tasks: [
        {
          agent: "developer",
          task: "Build a static site generator: read all docs/ files, generate HTML pages with navigation sidebar, search functionality (client-side), responsive layout, and proper typography. Include a table of contents for each page.",
          acceptance_criteria: "Navigation sidebar with all API groups, search works (filters pages by keyword), responsive layout, TOC on each page",
          testability: "Open the generated site → click each nav link → verify page loads. Type in search → verify filtering works. Resize window → verify responsive"
        }
      ]
    },
    {
      name: "Documentation Audit",
      tasks: [
        {
          agent: "auditor",
          task: "Audit all generated documentation for accuracy: verify every endpoint in the OpenAPI spec has a corresponding doc page, verify all code examples are syntactically valid, verify all parameter types match, verify no dead links in the generated HTML.",
          acceptance_criteria: "Zero missing endpoints, zero invalid code examples, zero dead links, all types match spec",
          testability: "Compare doc page count to API spec endpoint count → must match. Check all links → no 404s. Validate all curl examples → no syntax errors"
        }
      ]
    }
  ]
})

fleet_control(action = "go")
```

---

<a id="tier-3-advanced"></a>
## Tier 3: Advanced Tests

### S8 — State Persistence (Pause/Resume)

**Purpose**: Verify fleet state serialization, pause/resume functionality, and state recovery.

**Complexity**: ★★★★☆ (Advanced)

#### Project: Long-Running Multi-Phase Application

```javascript
// Step 1: Plan a multi-phase project
plan_project({
  name: "State Persistence Test",
  phases: [
    {
      name: "Setup & Foundation",
      tasks: [
        {
          agent: "developer",
          task: "Initialize a TypeScript project with 3 modules: config (settings management), logger (structured logging), and validator (input validation). Each module should have at least 3 functions.",
          acceptance_criteria: "3 modules created, each with 3+ exported functions, TypeScript compiles cleanly",
          testability: "import each module and call all exported functions"
        }
      ]
    },
    {
      name: "Core Features",
      tasks: [
        {
          agent: "developer",
          task: "Implement a settings management system: load settings from JSON/YAML config file, merge with defaults, validate against schema, watch for file changes and hot-reload, cache settings in memory with TTL.",
          acceptance_criteria: "Settings load from config, merge with defaults works, validation rejects invalid configs, file watching triggers reload, cache with TTL works",
          testability: "Create test config → load → verify merged. Modify config file → verify hot-reload. Provide invalid config → verify rejection"
        },
        {
          agent: "developer",
          task: "Implement a structured logger: log levels (debug, info, warn, error), log rotation (by size or date), JSON output format, console and file transports, context tracking (correlation IDs).",
          acceptance_criteria: "All log levels working, rotation works (test with small max size), JSON output valid, console + file output works, context tracking preserves correlation ID across async calls",
          testability: "Log at each level → verify output. Wait for rotation → verify new file created. Parse JSON output → verify valid"
        },
        {
          agent: "tech-lead",
          task: "Code review of both modules: verify error handling, edge cases, type safety, no stub code, no missing imports, consistent naming, proper export structure.",
          acceptance_criteria: "All error paths handled, types are precise, no any types, consistent naming, clean exports",
          testability: "Review each file individually. Then review imports between modules"
        }
      ]
    },
    {
      name: "Testing",
      tasks: [
        {
          agent: "developer",
          task: "Write comprehensive tests: test settings loading (valid/invalid configs), merging (default values, override precedence), validation (schema violations), file watching (modify then verify reload), logging (all levels, rotation, JSON format), validation (edge cases: empty input, null values, extreme values).",
          acceptance_criteria: "20+ test cases, all pass, edge cases covered",
          testability: "npm test → all pass"
        }
      ]
    }
  ]
})

// Step 2: Execute until middle of Phase 2
fleet_control(action = "go")
// Wait for Phase 2 Task 1 to complete but BEFORE Task 2 starts...

// Step 3: PAUSE the fleet
fleet_control(action = "pause")
// Verify: state.json saved to disk
// Verify: fleet status shows PAUSED
// Verify: no agents are running

// Step 4: Verify state persistence
// Check that state.json exists and contains:
// - completed tasks list
// - current phase index
// - task results with review data

// Step 5: RESUME the fleet
fleet_control(action = "resume")
// Verify: fleet resumes from Phase 2 Task 2 (not re-running completed tasks)
// Verify: previously approved tasks remain approved
// Verify: Phase 3 starts after Phase 2 completes

// Step 6: Verify final state
// All phases completed
// All tasks approved
// State saved to disk
```

#### State Persistence Diagram

```
┌────────────────────────────────────────────────────┐
│              PAUSE at Task 2 start                │
│                                                    │
│  Phase 1:  [████████████████] 100% ✓              │
│  Phase 2:  [████████░░░░░░░░]  50%  ◉ Task 1     │
│             [░░░░░░░░░░░░░░░░]   Task 2 (paused)  │
│  Phase 3:  [░░░░░░░░░░░░░░░░]   0%                │
│                                                    │
│  Saved to: state.json                              │
│  - phases[0]: { completed: true, tasks: [...] }    │
│  - phases[1]: { completed: false,                  │
│                  currentTask: 1,                    │
│                  tasks: [{ done: true, ... }] }     │
│  - phases[2]: { completed: false, tasks: [] }      │
└────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│              RESUME → continue from Task 2          │
│                                                    │
│  Phase 2 Task 2: RESUMING from saved state...      │
│  Phase 2 Task 1: ✓ Already completed (skipped)     │
│  Phase 3: Waiting for Phase 2 completion           │
│                                                    │
│  [████████░░░░░░░░] 50% → 100%                    │
│  [████████░░░░░░░░] 0% → 100%                     │
│                                                    │
│  Fleet complete! ✓                                 │
└────────────────────────────────────────────────────┘
```

---

### S9 — Cross-Model Benchmark Suite

**Purpose**: Compare different models side-by-side using identical tasks — measure quality, speed, and cost efficiency.

**Complexity**: ★★★★★ (Advanced)

#### Benchmark Configuration

```typescript
// benchmark-config.ts
interface BenchmarkConfig {
  name: string;
  models: string[];  // List of models to test
  tasks: BenchmarkTask[];
  thresholds: {
    minCodeQuality: number;  // Expected code quality score
    maxReviewCycles: number; // Acceptable max review cycles per task
    maxTokenUsage: number;   // Expected max tokens per task
  };
}

interface BenchmarkTask {
  id: string;
  phase: string;
  description: string;
  complexity: 'easy' | 'medium' | 'hard';
  expectedApproach: string;
  evaluationCriteria: string[];
  passThreshold: number;  // Score 0-100
}
```

#### Benchmark Scenarios

**S9a — Code Generation Quality**

```javascript
// Identical task given to each model
plan_project({
  name: "Model Benchmark: Code Generation",
  phases: [
    {
      name: "Sort Algorithm Library",
      tasks: [
        {
          agent: "developer",
          task: "Create a sort algorithms library in TypeScript with: bubble sort, quick sort, merge sort, insertion sort. Each algorithm should: accept an array, return a sorted array, have TypeScript generics support, include JSDoc comments with complexity analysis. Add a benchmark utility that runs each sort on arrays of 1000/10000/100000 elements and measures time.",
          acceptance_criteria: "All 4 sorts implemented and correct, TypeScript generics, JSDoc with Big-O notation, benchmark utility works",
          testability: "Sort [3,1,4,1,5,9,2,6] → verify [1,1,2,3,4,5,6,9] for each algorithm. Run benchmark → verify timing output"
        }
      ]
    }
  ]
})

// After completion, evaluate each model's output:
// Score each on:
// 1. Correctness (0-25): Do all sorts produce correct output?
// 2. Type Safety (0-25): Proper generics, no 'any'?
// 3. Code Quality (0-25): Readable, documented, efficient?
// 4. Performance (0-25): Benchmark results reasonable?
// Total: 100 points per model
```

**S9b — Code Review Quality**

```javascript
// Give models the same buggy code to review
plan_project({
  name: "Model Benchmark: Code Review",
  phases: [
    {
      name: "Buggy Code Review",
      tasks: [
        {
          agent: "tech-lead",
          task: "Review this code for bugs, security issues, and quality problems:\n\n```typescript\n// User authentication module\nimport express from 'express';\nconst router = express.Router();\nconst users = [];\n\n// Login endpoint\nrouter.post('/login', (req, res) => {\n  const { username, password } = req.body;\n  const user = users.find(u => u.username === username);\n  if (user && user.password === password) {\n    res.json({ token: 'token-' + username });\n  } else {\n    res.status(401).json({ error: 'Invalid' });\n  }\n});\n\n// Register endpoint  \nrouter.post('/register', (req, res) => {\n  const { username, password } = req.body;\n  users.push({ username, password });\n  res.json({ success: true });\n});\n\nexport default router;\n```\n\nIdentify all bugs, security issues, and quality problems.",
          acceptance_criteria: "Identifies: plain text passwords (security), no input validation (security), no rate limiting (security), users in memory (scalability), no password hashing (security), no JWT/signing (security), no authentication middleware (security)",
          testability: "Score: all 7 issues identified = 100 points"
        }
      ]
    }
  ]
})
```

**S9c — Design Review Quality**

```javascript
plan_project({
  name: "Model Benchmark: Design Review",
  phases: [
    {
      name: "UI Component Design Review",
      tasks: [
        {
          agent: "designer",
          task: "Review this CSS for a button component design system and identify issues:\n\n```css\n.btn {\n  padding: 10px 20px;\n  background-color: #3b82f6;\n  color: white;\n  border: none;\n  border-radius: 4px;\n  cursor: pointer;\n  font-size: 14px;\n  font-weight: 500;\n}\n\n.btn:hover {\n  background-color: #2563eb;\n}\n\n.btn:active {\n  background-color: #1d4ed8;\n}\n\n.btn-primary {\n  background-color: #3b82f6;\n}\n\n.btn-danger {\n  background-color: #ef4444;\n}\n\n.btn-success {\n  background-color: #22c55e;\n}\n```\n\nIdentify design system issues, accessibility problems, and improvement opportunities.",
          acceptance_criteria: "Identifies: hardcoded colors (should use CSS variables), missing focus styles (accessibility), missing disabled state, btn-primary duplicate of .btn base, no loading state, inconsistent border-radius usage, color contrast check needed, no dark mode support, no motion preference respect",
          testability: "Score all 8 identified issues = 100 points"
        }
      ]
    }
  ]
})
```

#### Benchmark Results Template

```
╔═══════════════════════════════════════════════════════╗
║           MODEL BENCHMARK RESULTS                     ║
╠══════════════════════┬═══════════╦══════════╦═════════╣
║ Metric               ║ Model A   ║ Model B  ║ Model C ║
╠══════════════════════╬═══════════╬══════════╬═════════╣
║ Code Quality (0-100) ║    85     ║    72    ║    91   ║
║ Review Accuracy      ║    90     ║    88    ║    82   ║
║ Design Review        ║    78     ║    95    ║    70   ║
║ Speed (avg/min)      ║    4.2    ║    3.8   ║    5.1  ║
║ Token Efficiency     ║   45k     ║   52k    ║   38k   ║
║ Review Cycles Needed ║    1.5    ║    2.3   ║    1.2  ║
║ Cost (estimated)     ║   $0.12   ║   $0.14  ║   $0.09 ║
╚══════════════════════╩═══════════╩══════════╩═════════╝

Recommendation: Model A (best overall balance)
```

---

### S10 — ZFS Migration Test

**Purpose**: Verify background mode and ZFS (Zellij Fleet Session) migration capabilities.

**Complexity**: ★★★★☆ (Advanced)

```
Migration Flow:
─────────────
Foreground Fleet
     │
     │ fleet_control(action="pause")
     ▼
Background Mode (survives terminal close)
     │
     │ /bg-export
     ▼
ZFS Mode (terminal multiplexer)
     │
     │ /zellij-start
     ▼
    ZFS Session
    ┌─────────────────────────────────────┐
    │  orchestrator  │  developer  │ ...  │
    │  [60%]        │  [20%]      │      │
    ├─────────────────────────────────────┤
    │  status bar (floating, 10 lines)   │
    │  agent grid  │  health  │ tokens   │
    │  [dev✓ tech⚠ des✓]                 │
    └─────────────────────────────────────┘
```

#### ZFS Layout Diagrams

```
Layout: fleet (default)
────────────────────────
┌─────────────────┬────────────┐
│                 │            │
│                 │            │
│    ORCHESTRATOR │  developer │
│    (60%)        │  (20%)     │
│                 │            │
│                 │            │
│                 │            │
├─────────────────┤  tech-lead │
│  status bar     └────────────┘
│  (floating)     ┌────────────┐
│                 │  designer  │
│                 │  (20%)     │
└─────────────────┴────────────┘

Layout: minimal
───────────────
┌─────────────────┬────────────┐
│                 │            │
│                 │            │
│    ORCHESTRATOR │  developer │
│    (60%)        │  (40%)     │
│                 │            │
│                 │            │
│                 │            │
├─────────────────┤  status bar│
│  status bar     └────────────┘
│  (floating)
└─────────────────┘

Layout: review
─────────────
┌─────────────────┬────────────┐
│                 │            │
│                 │            │
│    ORCHESTRATOR │  tech-lead │
│    (60%)        │  (20%)     │
│                 │            │
│                 │            │
├─────────────────┤            │
│                 │            │
│                 │            │
│                 │  designer  │
└─────────────────┴────────────┘
```

---

<a id="tier-3-health"></a>
## S11 — Health Monitoring & Stuck Detection

**Purpose**: Verify the health monitoring subsystem — stuck task detection, zombie detection, nudge system, and health bar rendering.

**Complexity**: ★★★☆☆ (Intermediate)
**Config**: Enable via `.caravel/config.json` → `{ health: true }`

```
Health Monitoring Flow:
──────────────────────
Phase Start
     │
     ├─▶ startPeriodicHealthChecks(interval=30s)
     │
     ├─▶ Per Task:
     │    ├─▶ Check: isStuck() → 120s threshold
     │    ├─▶ Check: isZombie() → 300s threshold
     │    ├─▶ Nudge if stuck: sendNudge(agent, taskId)
     │    └─▶ Escalate if zombie: escalate(agent, taskId)
     │
     ├─▶ Health Bar (ZFS):
     │   [developer✓ tech-lead⚠ designer✗]
     │
     └─▶ Phase End: stopHealthChecks()
```

#### Project: Build a Small Service (with health monitoring)

```javascript
plan_project({
  name: "Health Monitor Test Service",
  phases: [
    {
      name: "Setup with Health Enabled",
      tasks: [
        {
          agent: "developer",
          task: "Create a simple Node.js HTTP service with: health endpoint (/health), basic API endpoint (/api/echo that echoes back input), and a task that intentionally takes 5+ minutes to implement (complex data processing pipeline). Enable health monitoring via .caravel/config.json: { health: true, thresholds: { stuck: 120, zombie: 300, healthInterval: 30 } }.",
          acceptance_criteria: "Health endpoint works, API endpoint works, config.json created with health enabled, thresholds configured",
          testability: "curl localhost:3000/health → 200. curl localhost:3000/api/echo -d '{hello}' → echo back. Verify .caravel/config.json has health: true"
        }
      ]
    },
    {
      name: "Health Bar Verification",
      tasks: [
        {
          agent: "developer",
          task: "Verify health monitoring is active: check that .caravel/health.json exists during phase execution, verify health bar renders in ZFS status bar with per-agent status icons (✓/⚠/✗), verify nudge system creates entries in .caravel/messages.json when tasks exceed stuck threshold.",
          acceptance_criteria: "health.json exists, health bar shows [agent✓ agent⚠ agent✗] format, nudge entries exist when tasks are stuck",
          testability: "cat .caravel/health.json → verify valid JSON with agent statuses. Check .caravel/messages.json → verify nudge entries"
        }
      ]
    }
  ]
})

fleet_control(action = "go")
```

#### Expected Health Bar Output

```
╔═══════════════════════════════════════════════════════╗
║  CARAVEL FLEET [ZFS MODE] │ P1/2                    ║
║  ● developer  ◉ tech-lead⚠ ○ designer  │  3 agents  ║
║  P1: Setup  [████████░░░░░░░░] 40%                    ║
║  ▸ developer  Implement data processing pipeline      ║
║  ▸ tech-lead  stuck — nudge sent                       ║
║  [developer✓ tech-lead⚠ designer✓]                    ║
║  ● idle — waiting for work                             ║
║  ● idle — waiting for work                             ║
║  ▸ 12.5k / 3.2k  │ fleet: 45k tokens                  ║
║  Elapsed: 3m 42s  │ ZFS                                ║
╚═══════════════════════════════════════════════════════╝
```

---

<a id="tier-3-messaging"></a>
## S12 — Inter-Agent Messaging

**Purpose**: Verify inter-agent messaging — channels, nudge system, escalation, and messaging indicators in the widget bar.

**Complexity**: ★★★☆☆ (Intermediate)
**Config**: Enable via `.caravel/config.json` → `{ messaging: true }`

```
Messaging Flow:
─────────────
Agent A → sendNudge(agentB, taskId, "Need review")
     │
     ├─▶ .caravel/messages.json updated
     ├─▶ Channel: 'general' (default)
     ├─▶ Priority: 'high'
     ├─▶ Expiry: 5min (NUDGE_EXPIRY_MS)
     │
     ├─▶ On escalation:
     │    ├─▶ escalate(agent, taskId, "Urgent")
     │    ├─▶ Auto-routes to ['tech-lead', 'orchestrator']
     │    └─▶ Priority: 'escalation'
     │
     └─▶ Widget bar shows:
         [3 unread][1 escalation]
```

#### Project: Multi-Agent Coordination Test

```javascript
plan_project({
  name: "Messaging Coordination Test",
  phases: [
    {
      name: "Setup with Messaging",
      tasks: [
        {
          agent: "developer",
          task: "Create a project that exercises all messaging channels: 1) Create messages in 'general' channel, 2) Create messages in 'review' channel with review feedback, 3) Create an escalation in 'escalation' channel, 4) Send nudges between agents, 5) Verify messaging indicators appear in the widget bar [3 unread][1 escalation]. Enable messaging via .caravel/config.json: { messaging: true }.",
          acceptance_criteria: "All 3 DEFAULT_CHANNELS exist (general, review, escalation), messages persisted to .caravel/messages.json, nudges with 5min expiry, escalations auto-routed, widget bar shows indicators",
          testability: "cat .caravel/messages.json → verify all messages. Verify widget bar shows unread/escalation counts. Send nudge → verify .caravel/messages.json updated"
        }
      ]
    },
    {
      name: "Messaging Lifecycle",
      tasks: [
        {
          agent: "tech-lead",
          task: "Verify messaging lifecycle: 1) Get available channels → should return ['general', 'review', 'escalation'], 2) Create agent-specific channel by sending message, 3) Mark messages as read, 4) Verify getMessagesByChannel filters correctly, 5) Verify getUnresolvedNudges returns only unread nudges, 6) Resolve escalation and verify getOpenEscalations returns empty.",
          acceptance_criteria: "All channels listed, agent channels auto-created on message, markAsRead works, escalation resolution works, filters accurate",
          testability: "Verify each API: getAvailableChannels → ['general','review','escalation']. Create channel → verify .caravel/messages.json updated. Resolve → verify getOpenEscalations returns []"
        }
      ]
    }
  ]
})

fleet_control(action = "go")
```

---

<a id="tier-3-seance"></a>
## S13 — Predecessor Context Recovery (Seance)

**Purpose**: Verify the seance (session history) system — recording terminated agents, recovery context generation, and seance prefix injection on task retry.

**Complexity**: ★★★★☆ (Advanced)
**Config**: Enable via `.caravel/config.json` → `{ seance: true }`

```
Seance Recovery Flow:
───────────────────
Task Fails
     │
     ├─▶ recordTerminatedAgent(agent, taskId, phase, 'task_failed')
     │    ├─▶ .caravel/seances.json updated
     │    ├─▶ Captures: lastCheckpoint, workSummary, filesModified
     │    └─▶ SeanceRecord: { id, agentIdentity, taskId, phase, terminatedAt, reason, lastCheckpoint, workSummary, filesModified, toolCallHistory, contextWindow }
     │
     ├─▶ On Retry:
     │    ├─▶ getSeanceRecordsForTask(taskId, 2) → max 2 entries
     │    ├─▶ For each record:
     │    │    ├─▶ generateRecoveryContext(seance) → ≤500 chars
     │    │    └─▶ Format: '[SEANCE RECOVERY] {recoveryContext}'
     │    └─▶ Inject prefix into effective task description:
     │        [SEANCE RECOVERY] {workSummary}
     │        [AGENT] {agentIdentity}
     │        [RECOVERED CONTEXT] {filesModified, toolCallHistory}
     │
     └─▶ On Task Complete:
         └─▶ recordTerminatedAgent(agent, taskId, phase, 'task_complete')
```

#### Project: Test Seance Recovery with Intentional Failure

```javascript
plan_project({
  name: "Seance Recovery Test",
  phases: [
    {
      name: "Setup with Seance History",
      tasks: [
        {
          agent: "developer",
          task: "Create a TypeScript utility library with: 1) A string manipulation module (reverse, truncate, slugify), 2) A date formatting module (format, parse, diff), 3) A validation module (isEmail, isURL, isEmpty). Configure .caravel/config.json with seance: true. The implementation should be complex enough to produce meaningful work summaries and file modification history.",
          acceptance_criteria: "3 modules with 9+ functions total, TypeScript compiles, config.json has seance: true",
          testability: "import each module → verify all functions work. Check .caravel/seances.json → verify seance records created"
        }
      ]
    },
    {
      name: "Seance Verification",
      tasks: [
        {
          agent: "auditor",
          task: "Verify seance system: 1) Read .caravel/seances.json → verify valid JSON with seance records, 2) Check each record has required fields (id, agentIdentity, taskId, phase, terminatedAt, reason, workSummary, filesModified), 3) Verify generateRecoveryContext output is ≤500 chars and deterministic (same input → same output), 4) Verify getSeanceHistory returns records filtered by agent identity, 5) Verify getSeance(taskId) returns the correct seance record, 6) Verify clearSeance(taskId) removes the record, 7) Verify clearAllSeances clears all records.",
          acceptance_criteria: "seances.json valid, all required fields present, recovery context ≤500 chars and deterministic, CRUD operations work correctly",
          testability: "cat .caravel/seances.json → verify structure. Run test suite → all pass. Verify deterministic: generateRecoveryContext(seance1) === generateRecoveryContext(seance1)"
        }
      ]
    }
  ]
})

fleet_control(action = "go")
```

---

## Benchmark Suite

### Quick Benchmark Commands

```javascript
// Benchmark: Code Generation (give same task to different models)
// In each model's agent config, set:
// model: docker-models/<model-name>:32k

// Run the same task with each model and compare:
// 1. Code quality (manual review)
// 2. Time to completion
// 3. Token usage
// 4. Review cycles needed
// 5. Final test pass rate

// Benchmark: Code Review
// Give each model the same buggy code (from S9b)
// Score on issues identified

// Benchmark: Design Review
// Give each model the same CSS review task (from S9c)
// Score on issues identified
```

### Benchmark Scoring Rubric

| Category | Weight | Score Method |
|----------|--------|-------------|
| Correctness | 30% | Does the code work? (manual test) |
| Completeness | 20% | All requirements met? |
| Code Quality | 15% | Readable, documented, no stubs? |
| Efficiency | 15% | Reasonable complexity, good algorithms |
| Security | 10% | No security issues found |
| Review Effort | 10% | Fewer review cycles = better |

### Cost Calculator

```javascript
// After each benchmark run, calculate:
const totalTokens = metrics.reduce((sum, m) => sum + m.tokens, 0);
const cost = totalTokens * costPerToken;  // e.g., 0.0000003 per token
const hours = (totalTimeMs) / (1000 * 60 * 60);

console.log(`Cost: $${cost.toFixed(2)} for ${hours.toFixed(2)} hours of work`);
```

---

## Agent Quick Reference

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  CARAVEL AGENTS                                                      │
├──────────┬──────────────────────────────────┬────────────────────────┬──────────────────────────────┤
│ Agent    │ Model Reference                  │ Tools                  │ When to Use                  │
├──────────┼──────────────────────────────────┼────────────────────────┼──────────────────────────────┤
│ developer│ llama.cpp/Qwen/Qwen3.6-35B-A3B  │ read,write,edit,bash,  │ Implement features, fix      │
│          │ :GGUF:Q4_K_M                     │ grep,find,ls,searxng_  │ bugs, write tests/builds     │
├──────────┼──────────────────────────────────┼────────────────────────┼──────────────────────────────┤
│ tech-lead│ llama.cpp/Qwen/Qwen3.6-35B-A3B  │ read,write,edit,bash,  │ Architecture, code review,   │
│          │ :GGUF:Q4_K_M                     │ grep,find,ls           │ planning, logic error detect.│
├──────────┼──────────────────────────────────┼────────────────────────┼──────────────────────────────┤
│ designer │ llama.cpp/Qwen/Qwen3.6-35B-A3B  │ read,bash,grep,find,   │ UI review, visual design,    │
│          │ :GGUF:Q4_K_M                     │ ls,searxng_search      │ accessibility (vision)       │
├──────────┼──────────────────────────────────┼────────────────────────┼──────────────────────────────┤
│ documenter│llama.cpp/Qwen/Qwen3.6-35B-A3B  │ read,write,edit,grep   │ Documentation: README, API   │
│          │ :GGUF:Q4_K_M                     │                        │ docs, architecture docs      │
├──────────┼──────────────────────────────────┼────────────────────────┼──────────────────────────────┤
│ planner  │ llama.cpp/Qwen/Qwen3.6-35B-A3B  │ read,write,grep        │ Requirement gathering,       │
│          │ :GGUF:Q4_K_M                     │                        │ project planning             │
├──────────┼──────────────────────────────────┼────────────────────────┼──────────────────────────────┤
│ auditor  │ llama.cpp/Qwen/Qwen3.6-35B-A3B  │ read,write,grep,bash   │ Documentation audit, code    │
│          │ :GGUF:Q4_K_M                     │                        │ audit, quality gate checks   │
└──────────┴──────────────────────────────────┴────────────────────────┴──────────────────────────────┘

**Note:** All agents use `llama.cpp/Qwen/Qwen3.6-35B-A3B-GGUF:Q4_K_M` — matches the main agent model, supports vision (text+image), and eliminates network/config overhead. For multi-model comparison, override individual agents in their `agents/*.md` files.
```

---

## Feature Coverage Matrix

```
Feature                    │ S1 │ S2 │ S3 │ S4 │ S5 │ S6 │ S7 │ S8 │ S9 │ S10 │ S11 │ S12 │ S13
───────────────────────────┼────┼────┼────┼────┼────┼────┼────┼────┼────┼─────┼─────┼─────┼─────
Basic Fleet                │ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Two-Stage Review           │ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Code Review (Logic)        │    │    │ ███│ ███│ ███│ ███│ ███│ ███│ ███│     │     │     │ ███
Design Review              │    │ ███│ ███│    │ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Metrics Collection         │    │    │    │    │ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Telegram Integration       │    │    │    │    │    │ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Linear Integration         │    │    │    │    │    │ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Plane Integration          │    │    │    │    │    │ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Documenter Agent           │    │    │    │ ███│ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Planner Agent              │ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Auditor Agent              │    │    │ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
State Serialization        │    │    │    │    │    │    │    │ ███│ ███│ ███ │ ███ │ ███ │ ███
Pause/Resume               │    │    │    │    │    │    │    │ ███│ ███│ ███ │ ███ │ ███ │ ███
Background Mode            │    │    │    │    │    │    │    │ ███│ ███│ ███ │ ███ │ ███ │ ███
ZFS Migration              │    │    │    │    │    │    │    │ ███│ ███│ ███ │ ███ │ ███ │ ███
Cross-Model Benchmark      │    │    │    │    │    │    │    │ ███│ ███│ ███ │ ███ │ ███ │ ███
Testability Enforcement    │ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Gate Checks                │ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Logic Error Detection      │    │    │ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Design Token Checks        │    │ ███│    │    │ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Responsive Verification    │    │ ███│    │    │ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Agent Identity & Recovery  │    │    │    │    │    │    │    │     │     │ ███ │ ███ │ ███ │ ███
Health Monitoring          │    │    │    │    │    │    │    │     │     │ ███ │ ███ │ ███ │ ███
Inter-Agent Messaging      │    │    │    │    │    │    │    │     │     │ ███ │ ███ │ ███ │ ███
Predecessor Context (Seance)│   │    │    │    │    │    │    │     │     │ ███ │ ███ │ ███ │ ███
Config & Initialization    │    │    │    │    │    │    │    │     │     │ ███ │ ███ │ ███ │ ███
Health Bar (ZFS)           │    │    │    │    │    │    │    │     │     │     │ ███ │ ███ │ ███
Messaging Indicators       │    │    │    │    │    │    │    │     │     │     │ ███ │ ███ │ ███
```

---

## Expected Outputs

### Task Progress Format

```
▸ T1 [DONE] developer → Task Description (2m 33s) | 34k tokens ✓✓
```

Legend:
- `▸` = agent working (or `✓` = done, `○` = pending, `⏸` = paused)
- `[DONE]` / `[RUN]` / `[WAIT]` = status
- `T1` = task ID
- `developer` = agent name
- `(2m 33s)` = duration
- `34k tokens` = token usage
- `✓✓` = both reviews passed

### Widget Bar States

**Idle:**
```
╔══════════════════════════════════════════════════════╗
║          CARAVEL FLEET [IDLE]                        ║
║  ● developer  ● tech-lead  ● designer  3 agents     ║
║  Idle — waiting for phases                          ║
║  ▸ last action: none                               ║
║  0 reviews │ Elapsed: 0m 0s                         ║
╚══════════════════════════════════════════════════════╝
```

**Running:**
```
╔══════════════════════════════════════════════════════╗
║          CARAVEL FLEET [RUNNING]                     ║
║  ● developer  ◉ tech-lead  ○ designer  3 agents     ║
║  P2/4: Core Features  [████████░░░░░░░░] 40%  1/3   ║
║  ▸ developer  [qwen3:32k] → Auth middleware (12.5k) ║
║  1 ✓ 0 ○ | Review time: 3m 42s                      ║
╚══════════════════════════════════════════════════════╝
```

**Paused:**
```
╔══════════════════════════════════════════════════════╗
║          CARAVEL FLEET [PAUSED]                      ║
║  ● developer  ◉ tech-lead  ○ designer  3 agents     ║
║  P2/4: Core Features  [████████░░░░░░░░] 40%  1/3   ║
║  ⏸ paused — use /caravel-resume to continue         ║
║  1 ✓ 0 ○ | Saved state on disk                      ║
╚══════════════════════════════════════════════════════╝
```

### Metrics Export Format

**JSON:**
```json
{
  "timestamp": "2026-05-13T10:30:00Z",
  "fleet": {
    "total_tokens": 245000,
    "completed_tasks": 16,
    "failed_tasks": 0,
    "review_iterations": 8,
    "duration_ms": 3600000
  },
  "tasks": [
    {
      "id": "T1",
      "phase": "P1",
      "agent": "developer",
      "duration_ms": 120000,
      "tokens": 45000,
      "input_tokens": 32000,
      "output_tokens": 13000,
      "review_cycles": 1,
      "code_review": "approved",
      "design_review": "approved",
      "status": "completed"
    }
  ]
}
```

**CSV:**
```csv
task_id,phase,agent,duration_ms,tokens,input_tokens,output_tokens,review_cycles,code_review,design_review,status
T1,P1,developer,120000,45000,32000,13000,1,approved,approved,completed
T2,P1,tech-lead,90000,28000,22000,6000,1,approved,approved,completed
```

---

## Running These Tests

### Quick Start

```bash
# 1. Ensure Docker is running (for docker-models)
docker ps

# 2. Check model availability
# Verify docker-models are configured in agents/*.md

# 3. Launch Pi with caravel extension
# The caravel.ts extension should be in:
#   C:\Users\vl4dt\.pi\agent\extensions\caravel.ts

# 4. Run the first scenario
# In Pi chat: paste the plan_project() from S1, then fleet_control(action="go")
```

### Test Runner

A test runner script is provided in `tests/test-runner.ts` that can automate scenario execution.

### Customizing Models

To test with different models:

1. Edit the `model` field in the respective `agents/*.md` file
2. Run the same scenario
3. Compare results using the benchmark rubric above

Example:
```markdown
# Before (Model A — default)
model: llama.cpp/Qwen/Qwen3.6-35B-A3B-GGUF:Q4_K_M

# After (Model B — for comparison)
model: ollama/qwen3:8b
// or: openai/gpt-4o, lm-studio/gemma-4-e4b, etc.
```

### Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| Model not available | Check `pi --list-models` — verify provider is running (llama.cpp, Ollama, etc.) |
| Import errors in caravel.ts | Ensure caravel.ts is deployed to `~/.pi/agent/extensions/caravel.ts` |
| Command conflicts | Use `/caravel-pause` not `/pause`, `/caravel-go` not `/go` |
| Missing integrations | Configure `integrations/telegram.ts` or `integrations/linear.ts` with real credentials |
| Review loops exhausting | The task may need more specificity — add file paths and clearer acceptance criteria |
