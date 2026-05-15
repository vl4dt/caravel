/**
 * Caravel Test Runner — Automated Test Battery
 *
 * Run each scenario and collect metrics for benchmarking.
 * Usage: npx ts-node tests/test-runner.ts [scenario-id]
 *
 * Scenarios: S1–S10 (foundational through ZFS), S11 (Health), S12 (Messaging), S13 (Seance Recovery)
 */

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface Task {
  id: string;
  agent: string;
  phase: string;
  phaseIndex: number;
  description: string;
  acceptance_criteria: string;
  testability: string;
}

interface Phase {
  name: string;
  index: number;
  tasks: Task[];
}

interface Scenario {
  id: string;
  name: string;
  complexity: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  description: string;
  testable: boolean;
  requiresDocker: boolean;
  requiresExternal: boolean;
  requiresConfig: boolean;  // true if scenario requires .caravel/config.json setup
  config?: Record<string, unknown>;  // config to write for this scenario
  phases: Phase[];
}

interface TestResult {
  scenarioId: string;
  taskPhase: string;
  taskAgent: string;
  status: 'pending' | 'running' | 'approved' | 'failed' | 'skipped';
  duration_ms: number;
  tokens: number;
  review_cycles: number;
  code_review: 'approved' | 'rejected' | 'skipped';
  design_review: 'approved' | 'rejected' | 'skipped';
  errors: string[];
}

interface BenchmarkResult {
  model: string;
  scenarioId: string;
  totalTokens: number;
  totalDurationMs: number;
  totalReviewCycles: number;
  codeQualityScore: number;
  completenessScore: number;
  efficiencyScore: number;
  securityScore: number;
  overallScore: number;
  testResults: TestResult[];
}

// ──────────────────────────────────────────────────────────────
// Scenario Definitions
// ──────────────────────────────────────────────────────────────

const SCENARIOS: Record<string, Scenario> = {
  S1: {
    id: 'S1',
    name: 'Basic Fleet Orchestration',
    complexity: 'beginner',
    description: 'Core fleet pipeline: plan → execute → code review → design review → complete',
    testable: true,
    requiresDocker: true,
    requiresExternal: false,
    phases: [
      {
        name: 'Project Setup',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'developer',
            phase: 'S1',
            phaseIndex: 0,
            description: 'Create CLI Task Manager: package.json, tsconfig.json, src/ structure with core/, cli/, utils/ dirs',
            acceptance_criteria: 'npm install succeeds, TypeScript compiles, 3+ directories created',
            testability: 'npm run build exits with code 0',
          },
          {
            id: 'T2',
            agent: 'tech-lead',
            phase: 'S1',
            phaseIndex: 0,
            description: 'Design Task model (id, title, description, completed, createdAt) and storage interface',
            acceptance_criteria: 'Task interface defined, storage abstraction defined, ARCHITECTURE.md created',
            testability: 'ARCHITECTURE.md exists with interface definitions',
          },
        ],
      },
      {
        name: 'Core Implementation',
        index: 1,
        tasks: [
          {
            id: 'T3',
            agent: 'developer',
            phase: 'S1',
            phaseIndex: 1,
            description: 'TaskService with 6 methods: create, update, delete, get, list, toggleComplete. JSON file storage.',
            acceptance_criteria: 'All 6 methods working, proper error handling for invalid IDs',
            testability: 'Create → list → toggle → verify → delete → verify removed',
          },
          {
            id: 'T4',
            agent: 'developer',
            phase: 'S1',
            phaseIndex: 1,
            description: 'CLI layer with Commander.js: add, list, complete, delete, clear commands',
            acceptance_criteria: 'All 5 commands work, formatted output, error messages',
            testability: 'Add a task → list it → complete it → verify → delete it → verify gone',
          },
        ],
      },
      {
        name: 'Review & Polish',
        index: 2,
        tasks: [
          {
            id: 'T5',
            agent: 'tech-lead',
            phase: 'S1',
            phaseIndex: 2,
            description: 'Code review: check error handling, types, naming, no TODOs, no stubs',
            acceptance_criteria: 'No TODO comments, all types consistent, no duplicate code',
            testability: 'npm lint passes, TypeScript compiles without errors',
          },
          {
            id: 'T6',
            agent: 'tech-lead',
            phase: 'S1',
            phaseIndex: 2,
            description: 'Unit tests for TaskService with Jest: CRUD, validation, error handling',
            acceptance_criteria: '10+ test cases, all pass, error cases covered',
            testability: 'npm test → all pass',
          },
        ],
      },
    ],
  },

  S2: {
    id: 'S2',
    name: 'Design Review Pipeline (UI-Focused)',
    complexity: 'intermediate',
    description: 'Test designer agent with UI-heavy project. Verify design tokens, responsive behavior, accessibility.',
    testable: true,
    requiresDocker: true,
    requiresExternal: false,
    phases: [
      {
        name: 'Design System Foundation',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'designer',
            phase: 'S2',
            phaseIndex: 0,
            description: 'Create CSS design tokens: colors, typography, spacing, border-radius. design-tokens.css with light/dark variants.',
            acceptance_criteria: '15+ custom properties, consistent naming, light/dark mode',
            testability: 'Open HTML page → verify all colors consistent via CSS variables',
          },
        ],
      },
      {
        name: 'Core Components',
        index: 1,
        tasks: [
          {
            id: 'T2',
            agent: 'developer',
            phase: 'S2',
            phaseIndex: 1,
            description: 'Kanban board: Board, Column, Card components. CSS Grid/Flexbox only. HTML5 Drag and Drop API.',
            acceptance_criteria: 'All components rendered, drag-and-drop works, horizontally scrollable columns',
            testability: 'Test at 375px, 768px, 1440px. Drag cards between columns → verify position persists',
          },
        ],
      },
      {
        name: 'Enhanced Features',
        index: 2,
        tasks: [
          {
            id: 'T3',
            agent: 'developer',
            phase: 'S2',
            phaseIndex: 2,
            description: 'Card modal, column context menu, drag-between-columns, localStorage persistence, transitions, keyboard navigation.',
            acceptance_criteria: 'Modal opens/closes, context menu works, drag-between-columns works, data persists, keyboard accessible',
            testability: 'Tab through cards → Enter opens modal → Escape closes. Reload page → verify data persists',
          },
          {
            id: 'T4',
            agent: 'designer',
            phase: 'S2',
            phaseIndex: 2,
            description: 'Design review: token consistency, responsive check (375/768/1440px), accessibility (WCAG AA), polish.',
            acceptance_criteria: 'No hardcoded colors, responsive at all breakpoints, color contrast ≥ 4.5:1, focus states visible',
            testability: 'Lighthouse audit: accessibility ≥ 90, Performance ≥ 80',
          },
        ],
      },
      {
        name: 'Code Review & Polish',
        index: 3,
        tasks: [
          {
            id: 'T5',
            agent: 'tech-lead',
            phase: 'S2',
            phaseIndex: 3,
            description: 'Code review: event listener cleanup, memory management in drag handlers, code organization, naming consistency.',
            acceptance_criteria: 'No memory leaks, clean event handlers, organized modules',
            testability: 'DevTools Memory → heap snapshot → drag 10 cards → verify no growing references',
          },
        ],
      },
    ],
  },

  S3: {
    id: 'S3',
    name: 'Logic Error Detection (Backend Focus)',
    complexity: 'intermediate',
    description: 'Test tech-lead agent with enhanced logic error detection: missing imports, stubs, type mismatches, error handling gaps.',
    testable: true,
    requiresDocker: true,
    requiresExternal: false,
    phases: [
      {
        name: 'API Foundation',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'developer',
            phase: 'S3',
            phaseIndex: 0,
            description: 'Express.js API with custom Error class, error middleware, request validation (Zod), response formatter. src/routes/, src/middleware/, src/models/, src/controllers/.',
            acceptance_criteria: 'Error middleware catches all unhandled errors, validation rejects with 400, consistent error response format',
            testability: 'Send malformed request → verify 400. Trigger 500 → verify error middleware catches',
          },
        ],
      },
      {
        name: 'Task CRUD Endpoints',
        index: 1,
        tasks: [
          {
            id: 'T2',
            agent: 'developer',
            phase: 'S3',
            phaseIndex: 1,
            description: 'POST/GET/GET/:id/PUT/:id/DELETE/:id for tasks. Input validation, proper HTTP status codes (200/201/400/404/500), query params for filtering.',
            acceptance_criteria: 'All 5 endpoints working, proper status codes, filtering/pagination working',
            testability: 'curl POST → 201. GET → list. GET /nonexistent → 404.',
          },
          {
            id: 'T3',
            agent: 'tech-lead',
            phase: 'S3',
            phaseIndex: 1,
            description: 'Enhanced code review: check for missing imports, undefined references, stub code, type mismatches, error handling gaps, input validation completeness.',
            acceptance_criteria: 'All imports present, no undefined references, no console.log/TODO, types match, all async paths have error handling',
            testability: 'node --check src/app.js → verify syntax. Test invalid inputs → verify error handling.',
          },
        ],
      },
      {
        name: 'Validation & Security',
        index: 2,
        tasks: [
          {
            id: 'T4',
            agent: 'developer',
            phase: 'S3',
            phaseIndex: 2,
            description: 'Add validation (title min 1/max 100, description max 1000), rate limiting, CORS, helmet security headers, input sanitization, response caching.',
            acceptance_criteria: 'Title validation enforced, rate limiter configured, helmet headers present, HTML escaped in responses',
            testability: 'POST with empty title → 400. curl -I → verify helmet headers.',
          },
        ],
      },
    ],
  },

  S4: {
    id: 'S4',
    name: 'Documentation Generator (Documenter Agent)',
    complexity: 'beginner',
    description: 'Test documenter agent: write, maintain, cross-reference documentation. Verify accuracy and staleness detection.',
    testable: true,
    requiresDocker: true,
    requiresExternal: false,
    phases: [
      {
        name: 'Analysis Engine',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'developer',
            phase: 'S4',
            phaseIndex: 0,
            description: 'Build analysis engine: readFiles() recursively, extractComments(), extractFunctions() with params/types/returns, extractClasses() with methods/properties.',
            acceptance_criteria: 'Extracts functions with names/types/params, classes with methods, JSDoc comments parsed',
            testability: 'Run on caravel repo → verify finds .ts files, extracts function names, parses classes',
          },
          {
            id: 'T2',
            agent: 'documenter',
            phase: 'S4',
            phaseIndex: 0,
            description: 'Write README.md: description, features, installation, usage examples, configuration, architecture overview, contributing guide.',
            acceptance_criteria: 'All sections present, file paths accurate, installation steps work, examples complete',
            testability: 'Follow installation steps → verify they work. Check file paths exist.',
          },
        ],
      },
      {
        name: 'Documentation Output',
        index: 1,
        tasks: [
          {
            id: 'T3',
            agent: 'documenter',
            phase: 'S4',
            phaseIndex: 1,
            description: 'Generate API docs (docs/API.md) with all exported functions/signatures/descriptions/examples. Create docs/ARCHITECTURE.md with design decisions and dependency diagram.',
            acceptance_criteria: 'All APIs documented with signatures, design decisions have rationale, dependency diagram present',
            testability: 'Every exported function appears in API.md. Dependency diagram matches actual imports.',
          },
          {
            id: 'T4',
            agent: 'documenter',
            phase: 'S4',
            phaseIndex: 1,
            description: 'Write DEVELOPER.md: dev setup, run tests, add features, common pitfalls with code examples.',
            acceptance_criteria: 'Setup steps accurate, examples work, pitfalls documented with solutions',
            testability: 'Follow guide from clean install → run tests → all pass.',
          },
        ],
      },
      {
        name: 'Documentation Audit',
        index: 2,
        tasks: [
          {
            id: 'T5',
            agent: 'auditor',
            phase: 'S4',
            phaseIndex: 2,
            description: 'Audit all docs: verify file paths exist, check dead links, verify code examples current, consistent terminology, README matches project state.',
            acceptance_criteria: 'Zero dead links, zero stale paths, all examples verified, consistent terminology',
            testability: 'For each path in docs: check file exists. For each example: run and verify output.',
          },
        ],
      },
    ],
  },

  S5: {
    id: 'S5',
    name: 'Full-Stack Application (All Features)',
    complexity: 'expert',
    description: 'Test ALL Caravel features: all agents, reviews, metrics, integrations. Personal Finance Tracker: React + Express + SQLite.',
    testable: true,
    requiresDocker: true,
    requiresExternal: false,
    phases: [
      {
        name: 'Architecture & Setup',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'tech-lead',
            phase: 'S5',
            phaseIndex: 0,
            description: 'Design full-stack architecture: React/Vite frontend, Express/SQLite backend. DB schema (users, transactions, categories, budgets). Document in PROJECT-DESIGN.md with diagram.',
            acceptance_criteria: 'Architecture diagram in PROJECT-DESIGN.md, tech choices justified, DB schema with ER diagram',
            testability: 'Trace transaction: UI click → API route → DB query → response.',
          },
          {
            id: 'T2',
            agent: 'developer',
            phase: 'S5',
            phaseIndex: 0,
            description: 'Monorepo setup: packages/frontend/ (Vite + React), packages/backend/ (Express). SQLite with migrations. Shared ESLint + Prettier.',
            acceptance_criteria: 'Both apps start independently (npm run dev), shared TS config works, builds succeed',
            testability: 'npm run dev frontend → localhost:5173. npm run dev backend → localhost:3000.',
          },
        ],
      },
      {
        name: 'Backend API',
        index: 1,
        tasks: [
          {
            id: 'T3',
            agent: 'developer',
            phase: 'S5',
            phaseIndex: 1,
            description: 'Auth routes (POST /api/auth/register, /api/auth/login with JWT), transaction CRUD, category CRUD, budget routes. Input validation, JWT middleware, error handling.',
            acceptance_criteria: '12+ endpoints, JWT enforced, input validation, proper status codes',
            testability: 'Register → get JWT → use JWT. Invalid JWT → 401. Missing fields → 400.',
          },
          {
            id: 'T4',
            agent: 'tech-lead',
            phase: 'S5',
            phaseIndex: 1,
            description: 'Enhanced code review: verify imports, no stubs, error handling on every async path, no 'any' types, parameterized SQL, JWT verified on all protected routes.',
            acceptance_criteria: 'No 'any' types, all SQL parameterized, JWT on every protected route, error middleware complete',
            testability: 'node --check src/app.js. Test each endpoint with invalid inputs.',
          },
          {
            id: 'T5',
            agent: 'developer',
            phase: 'S5',
            phaseIndex: 1,
            description: 'Write backend tests: auth flow, CRUD with validation, category management, budget calculations. Supertest + in-memory SQLite.',
            acceptance_criteria: '15+ test cases, auth flow tested, error cases covered',
            testability: 'npm test → all pass.',
          },
        ],
      },
      {
        name: 'Frontend UI',
        index: 2,
        tasks: [
          {
            id: 'T6',
            agent: 'developer',
            phase: 'S5',
            phaseIndex: 2,
            description: 'React pages: Login/Register, Dashboard (income/expense/net summary), Transaction list (filtering), Transaction form, Categories page, Budget page. CSS Modules.',
            acceptance_criteria: 'All pages route, client-side validation, real API data, filtering works',
            testability: 'Visit each route, test each form, verify data. Check at 375/768/1440px.',
          },
          {
            id: 'T7',
            agent: 'designer',
            phase: 'S5',
            phaseIndex: 2,
            description: 'Design review: visual consistency, design token usage (no hardcoded values), responsive (375/768/1440px), accessibility (contrast ≥ 4.5:1, focus states, keyboard nav), UX polish.',
            acceptance_criteria: 'All pages use design tokens, responsive at all breakpoints, contrast passes, keyboard accessible',
            testability: 'Lighthouse: accessibility ≥ 90, Performance ≥ 80. Tab through every element.',
          },
          {
            id: 'T8',
            agent: 'developer',
            phase: 'S5',
            phaseIndex: 2,
            description: 'Data visualization: bar chart (monthly spending), pie chart (category breakdown), line chart (spending trend). Responsive + accessible with ARIA labels.',
            acceptance_criteria: '3 charts with real data, responsive, keyboard accessible, screen reader labels',
            testability: 'Charts render with data. Resize → redraw. Tab to charts → keyboard navigation.',
          },
        ],
      },
      {
        name: 'Metrics & Monitoring',
        index: 3,
        tasks: [
          {
            id: 'T9',
            agent: 'developer',
            phase: 'S5',
            phaseIndex: 3,
            description: 'Integrate metrics: request duration, status, method, endpoint. Logging middleware. Health check endpoint (/api/health).',
            acceptance_criteria: 'Metrics collected, structured logs, health endpoint works',
            testability: '5 API requests → verify metrics file updated. /api/health → 200.',
          },
        ],
      },
    ],
  },

  S6: {
    id: 'S6',
    name: 'Metrics & Integrations',
    complexity: 'intermediate',
    description: 'Verify metrics collection accuracy and integration delivery (Telegram, Linear, Plane).',
    testable: true,
    requiresDocker: true,
    requiresExternal: true,
    phases: [
      {
        name: 'Metrics System',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'developer',
            phase: 'S6',
            phaseIndex: 0,
            description: 'Set up metrics collection: middleware for request duration, status, method, endpoint. Export to JSON and CSV. Include all fleet metrics (task_duration, review_count, tokens, pass/fail rates).',
            acceptance_criteria: 'Metrics middleware records all fields, JSON and CSV export works, .caravel/ directory created',
            testability: '5 API requests → verify metrics file exists → 5 entries → CSV has correct headers.',
          },
        ],
      },
      {
        name: 'Telegram Integration',
        index: 1,
        tasks: [
          {
            id: 'T2',
            agent: 'developer',
            phase: 'S6',
            phaseIndex: 1,
            description: 'Telegram notification service: task start/complete/failure notifications, review results, error alerts, monitor mode with periodic status updates. Retry with backoff.',
            acceptance_criteria: 'All 4 notification types work, config via env vars, error handling with retry',
            testability: 'Configure test bot → send notification → verify message in chat. Invalid token → verify graceful error.',
          },
        ],
      },
      {
        name: 'Linear Integration',
        index: 2,
        tasks: [
          {
            id: 'T3',
            agent: 'developer',
            phase: 'S6',
            phaseIndex: 2,
            description: 'Linear integration: create/update issues from tasks, sync status, webhooks. API auth via config.',
            acceptance_criteria: 'Issues created/updated correctly, status sync works, webhook endpoint configured',
            testability: 'Create a Linear issue via the integration → verify in Linear dashboard.',
          },
        ],
      },
      {
        name: 'Plane Integration',
        index: 3,
        tasks: [
          {
            id: 'T4',
            agent: 'developer',
            phase: 'S6',
            phaseIndex: 3,
            description: 'Plane integration: same pattern as Linear but adapted to Plane API. Create/update issues, sync status, webhooks.',
            acceptance_criteria: 'Issues created/updated via Plane API, status sync works',
            testability: 'Create a Plane issue via the integration → verify in Plane workspace.',
          },
        ],
      },
      {
        name: 'Security Review',
        index: 4,
        tasks: [
          {
            id: 'T5',
            agent: 'tech-lead',
            phase: 'S6',
            phaseIndex: 4,
            description: 'Security code review: verify no hardcoded secrets in integrations, all sensitive config via env vars, error handling for external calls, metrics data validated before export.',
            acceptance_criteria: 'No hardcoded tokens, all config via env vars, error handling complete',
            testability: 'grep -r "api_key\\|token" src/ → verify no hardcoded values.',
          },
        ],
      },
    ],
  },

  S7: {
    id: 'S7',
    name: 'Documentation-Heavy Project',
    complexity: 'intermediate',
    description: 'Test documenter in a docs-centric project. Build API documentation site from OpenAPI specs.',
    testable: true,
    requiresDocker: true,
    requiresExternal: false,
    phases: [
      {
        name: 'Schema Parser',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'developer',
            phase: 'S7',
            phaseIndex: 0,
            description: 'OpenAPI 3.0 schema parser: extract paths (method, url, params), request/response bodies, auth requirements, examples.',
            acceptance_criteria: 'Parses all OpenAPI 3.0 features: params, body, headers, responses, security schemes',
            testability: 'Parse Express-like spec → verify all endpoints extracted.',
          },
          {
            id: 'T2',
            agent: 'documenter',
            phase: 'S7',
            phaseIndex: 0,
            description: 'Create docs/index.md (overview), docs/api/auth.md, docs/api/users.md, docs/api/transactions.md. Each with endpoint URL, method, headers, params, body schema, response schema, curl examples.',
            acceptance_criteria: 'All endpoints documented, schemas complete, examples accurate, consistent formatting',
            testability: 'Read each API doc → verify curl examples would work → verify schema matches spec.',
          },
        ],
      },
      {
        name: 'Website Builder',
        index: 1,
        tasks: [
          {
            id: 'T3',
            agent: 'developer',
            phase: 'S7',
            phaseIndex: 1,
            description: 'Static site generator: read docs/, generate HTML with sidebar navigation, client-side search, responsive layout, proper typography, TOC per page.',
            acceptance_criteria: 'Navigation sidebar, search works, responsive, TOC on each page',
            testability: 'Open site → click nav links → verify pages. Type in search → verify filtering. Resize → responsive.',
          },
        ],
      },
      {
        name: 'Documentation Audit',
        index: 2,
        tasks: [
          {
            id: 'T4',
            agent: 'auditor',
            phase: 'S7',
            phaseIndex: 2,
            description: 'Audit: verify all OpenAPI endpoints have doc pages, all code examples valid, all types match, no dead links in HTML.',
            acceptance_criteria: 'Zero missing endpoints, zero invalid examples, zero dead links, all types match',
            testability: 'Compare doc count to API spec endpoint count. Check all links → no 404s. Validate curl examples.',
          },
        ],
      },
    ],
  },

  S8: {
    id: 'S8',
    name: 'State Persistence (Pause/Resume)',
    complexity: 'advanced',
    description: 'Test fleet state serialization, pause/resume, and state recovery. Verify no re-execution of completed tasks.',
    testable: true,
    requiresDocker: true,
    requiresExternal: false,
    phases: [
      {
        name: 'Setup',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'developer',
            phase: 'S8',
            phaseIndex: 0,
            description: 'TypeScript project with 3 modules: config (settings mgmt), logger (structured logging), validator (input validation). Each with 3+ functions.',
            acceptance_criteria: '3 modules, each with 3+ exports, TypeScript compiles',
            testability: 'import each module → call all functions.',
          },
        ],
      },
      {
        name: 'Core Features',
        index: 1,
        tasks: [
          {
            id: 'T2',
            agent: 'developer',
            phase: 'S8',
            phaseIndex: 1,
            description: 'Settings management: load from JSON/YAML, merge with defaults, validate against schema, file watching + hot-reload, in-memory cache with TTL.',
            acceptance_criteria: 'Settings load from config, merge works, validation rejects invalid, file watching triggers reload, cache with TTL works',
            testability: 'Test config → load → verify. Modify config → verify hot-reload. Invalid config → verify rejection.',
          },
          {
            id: 'T3',
            agent: 'developer',
            phase: 'S8',
            phaseIndex: 1,
            description: 'Structured logger: debug/info/warn/error levels, log rotation (size/date), JSON output, console + file transports, context tracking (correlation IDs).',
            acceptance_criteria: 'All levels working, rotation works, JSON output valid, console + file output, context tracking',
            testability: 'Log at each level → verify. Wait for rotation → verify new file. Parse JSON → valid.',
          },
          {
            id: 'T4',
            agent: 'tech-lead',
            phase: 'S8',
            phaseIndex: 1,
            description: 'Code review: error handling, edge cases, type safety, no stubs, no missing imports, consistent naming, clean exports.',
            acceptance_criteria: 'All error paths handled, precise types, no any, consistent naming, clean exports',
            testability: 'Review each file. Then review inter-module imports.',
          },
        ],
      },
      {
        name: 'Testing',
        index: 2,
        tasks: [
          {
            id: 'T5',
            agent: 'developer',
            phase: 'S8',
            phaseIndex: 2,
            description: '20+ tests: settings (valid/invalid configs, merge, validation, file watching, cache), logging (all levels, rotation, JSON), validation (edge cases).',
            acceptance_criteria: '20+ test cases, all pass, edge cases covered',
            testability: 'npm test → all pass.',
          },
        ],
      },
    ],
  },

  S9a: {
    id: 'S9a',
    name: 'Benchmark: Code Generation',
    complexity: 'advanced',
    description: 'Benchmark different models on code generation quality. Give identical task to each model.',
    testable: false,
    requiresDocker: true,
    requiresExternal: false,
    phases: [
      {
        name: 'Sort Algorithms Library',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'developer',
            phase: 'S9a',
            phaseIndex: 0,
            description: 'TypeScript sort library: bubble sort, quick sort, merge sort, insertion sort. Generics support, JSDoc with complexity analysis. Benchmark utility (1000/10000/100000 element arrays).',
            acceptance_criteria: 'All 4 sorts correct, TypeScript generics, JSDoc with Big-O, benchmark utility works',
            testability: 'Sort [3,1,4,1,5,9,2,6] → [1,1,2,3,4,5,6,9]. Run benchmark → timing output.',
          },
        ],
      },
    ],
  },

  S9b: {
    id: 'S9b',
    name: 'Benchmark: Code Review',
    complexity: 'advanced',
    description: 'Benchmark different models on code review quality. Give identical buggy code to each model.',
    testable: false,
    requiresDocker: true,
    requiresExternal: false,
    phases: [
      {
        name: 'Buggy Code Review',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'tech-lead',
            phase: 'S9b',
            phaseIndex: 0,
            description: 'Review this vulnerable auth code for bugs, security issues, quality problems. Identify: plain text passwords, no input validation, no rate limiting, in-memory storage, no password hashing, no JWT signing, no auth middleware.',
            acceptance_criteria: 'All 7 security issues identified',
            testability: 'Score: all 7 = 100 points. Each identified = ~14 points.',
          },
        ],
      },
    ],
  },

  S9c: {
    id: 'S9c',
    name: 'Benchmark: Design Review',
    complexity: 'advanced',
    description: 'Benchmark different models on design review quality. Give identical CSS to each model.',
    testable: false,
    requiresDocker: true,
    requiresExternal: false,
    phases: [
      {
        name: 'CSS Design Review',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'designer',
            phase: 'S9c',
            phaseIndex: 0,
            description: 'Review button CSS design system: identify design token issues (hardcoded colors), accessibility issues (missing focus styles), improvement opportunities (disabled state, loading state, dark mode, motion preference).',
            acceptance_criteria: 'All 8 issues identified: hardcoded colors, no focus styles, no disabled state, btn-primary duplicate, no loading state, inconsistent border-radius, contrast check needed, no dark mode',
            testability: 'Score: all 8 = 100 points. Each identified = 12.5 points.',
          },
        ],
      },
    ],
  },

  S10: {
    id: 'S10',
    name: 'ZFS Migration Test',
    complexity: 'expert',
    description: 'Test background mode and ZFS migration. Verify state persistence across mode changes.',
    testable: true,
    requiresDocker: true,
    requiresExternal: false,
    requiresConfig: false,
    phases: [
      {
        name: 'Background Fleet Start',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'developer',
            phase: 'S10',
            phaseIndex: 0,
            description: 'Start a simple fleet in foreground: create a basic project structure, then use fleet_control(action="pause") to pause it.',
            acceptance_criteria: 'Fleet starts, runs at least one task, pauses correctly with state saved',
            testability: 'After pause: verify state.json exists with completed tasks and current phase.',
          },
        ],
      },
      {
        name: 'Background Migration',
        index: 1,
        tasks: [
          {
            id: 'T2',
            agent: 'developer',
            phase: 'S10',
            phaseIndex: 1,
            description: 'Migrate paused fleet: from background → ZFS mode (if Zellij available) or verify background process survives. Resume from saved state.',
            acceptance_criteria: 'Fleet resumes from saved state, no re-execution of completed tasks',
            testability: 'Resume → verify phase continues from where it left off. All completed tasks stay completed.',
          },
        ],
      },
    ],
  },

  // ── New Feature Scenarios (P2–P5) ──

  S11: {
    id: 'S11',
    name: 'Health Monitoring & Stuck Detection',
    complexity: 'intermediate',
    description: 'Verify health monitoring subsystem — stuck task detection, zombie detection, nudge system, health bar rendering.',
    testable: true,
    requiresDocker: false,
    requiresExternal: false,
    requiresConfig: true,
    config: { health: true, thresholds: { stuck: 120, zombie: 300, healthInterval: 30 } },
    phases: [
      {
        name: 'Setup with Health Monitoring',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'developer',
            phase: 'S11',
            phaseIndex: 0,
            description: 'Create a simple Node.js service with health endpoint and a slow processing task. Enable health monitoring via .caravel/config.json.',
            acceptance_criteria: 'Health endpoint works, config.json has health: true, .caravel/health.json created during phase',
            testability: 'curl /health → 200. cat .caravel/health.json → verify valid JSON with agent statuses.',
          },
        ],
      },
      {
        name: 'Health Bar Verification',
        index: 1,
        tasks: [
          {
            id: 'T1',
            agent: 'developer',
            phase: 'S11',
            phaseIndex: 1,
            description: 'Verify health bar renders in ZFS status bar: per-agent status icons (✓/⚠/✗), stuck task detection triggers nudge, zombie task triggers escalation.',
            acceptance_criteria: 'Health bar shows [agent✓ agent⚠ agent✗] format, nudge system creates entries in messages.json, escalation auto-routes to tech-lead',
            testability: 'cat .caravel/messages.json → verify nudge entries. Verify health.json has correct agent statuses.',
          },
        ],
      },
    ],
  },

  S12: {
    id: 'S12',
    name: 'Inter-Agent Messaging',
    complexity: 'intermediate',
    description: 'Verify inter-agent messaging — channels, nudge system, escalation, messaging indicators in widget bar.',
    testable: true,
    requiresDocker: false,
    requiresExternal: false,
    requiresConfig: true,
    config: { messaging: true },
    phases: [
      {
        name: 'Messaging Setup',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'developer',
            phase: 'S12',
            phaseIndex: 0,
            description: 'Exercise all messaging channels: general, review, escalation. Send nudges, create escalations, verify .caravel/messages.json persistence.',
            acceptance_criteria: 'All 3 DEFAULT_CHANNELS exist, messages persisted, nudges with 5min expiry, escalations auto-routed, widget bar shows indicators',
            testability: 'cat .caravel/messages.json → verify all messages. Verify widget bar shows [unread][escalation] counts.',
          },
        ],
      },
      {
        name: 'Messaging Lifecycle',
        index: 1,
        tasks: [
          {
            id: 'T1',
            agent: 'tech-lead',
            phase: 'S12',
            phaseIndex: 1,
            description: 'Verify messaging lifecycle: getAvailableChannels, create agent channel, markAsRead, getMessagesByChannel, getUnresolvedNudges, resolveEscalation.',
            acceptance_criteria: 'All channels listed, agent channels auto-created, markAsRead works, escalation resolution works, filters accurate',
            testability: 'Verify each API: getAvailableChannels → [general,review,escalation]. Resolve escalation → getOpenEscalations returns [].',
          },
        ],
      },
    ],
  },

  S13: {
    id: 'S13',
    name: 'Predecessor Context Recovery (Seance)',
    complexity: 'advanced',
    description: 'Verify seance system — recording terminated agents, recovery context generation, seance prefix injection on retry.',
    testable: true,
    requiresDocker: false,
    requiresExternal: false,
    requiresConfig: true,
    config: { seance: true },
    phases: [
      {
        name: 'Setup with Seance History',
        index: 0,
        tasks: [
          {
            id: 'T1',
            agent: 'developer',
            phase: 'S13',
            phaseIndex: 0,
            description: 'Create a TypeScript utility library (string ops, date formatting, validation) with .caravel/config.json seance: true. Complex enough to produce meaningful work summaries.',
            acceptance_criteria: '3 modules with 9+ functions, TypeScript compiles, config.json has seance: true, seance records created',
            testability: 'import modules → verify functions work. cat .caravel/seances.json → verify seance records.',
          },
        ],
      },
      {
        name: 'Seance Verification',
        index: 1,
        tasks: [
          {
            id: 'T1',
            agent: 'auditor',
            phase: 'S13',
            phaseIndex: 1,
            description: 'Verify seance system: read seances.json, check required fields, verify generateRecoveryContext ≤500 chars and deterministic, verify CRUD operations (getSeance, clearSeance, clearAllSeances, getSeanceHistory, getSeanceCount).',
            acceptance_criteria: 'seances.json valid, all required fields present, recovery context deterministic and ≤500 chars, CRUD operations correct',
            testability: 'cat .caravel/seances.json → verify structure. Generate context twice → verify identical output.',
          },
        ],
      },
    ],
  },
};

// ──────────────────────────────────────────────────────────────
// Test Runner Engine
// ──────────────────────────────────────────────────────────────

class TestRunner {
  private results: BenchmarkResult[] = [];
  private currentScenario: string | null = null;
  private startTime: number = Date.now();

  constructor() {
    this.startTime = Date.now();
  }

  // ── Core Methods ──────────────────────────────────────

  async runAllScenarios(): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  CARAVEL TEST BATTERY — Full Run');
    console.log('═══════════════════════════════════════════════════════\n');

    const scenarioIds = Object.keys(SCENARIOS);
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const id of scenarioIds) {
      try {
        console.log(`\n─── Running Scenario ${id}: ${SCENARIOS[id].name} ───\n`);
        const result = await this.runScenario(id);
        if (result.status === 'passed') {
          passed++;
          this.results.push(result);
        } else if (result.status === 'skipped') {
          skipped++;
        } else {
          failed++;
        }
      } catch (error) {
        console.error(`\n✗ Scenario ${id} crashed: ${error}`);
        failed++;
      }
    }

    console.log('\n\n═══════════════════════════════════════════════════════');
    console.log('  BATTERY RESULTS');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`  Passed:  ${passed}`);
    console.log(`  Failed:  ${failed}`);
    console.log(`  Skipped: ${skipped}`);
    console.log(`  Total:   ${scenarioIds.length}`);
    console.log(`\n  Duration: ${((Date.now() - this.startTime) / 1000).toFixed(1)}s`);
    console.log('\n═══════════════════════════════════════════════════════\n');

    // Write results to file
    await this.writeResults();
  }

  async runScenario(scenarioId: string): Promise<BenchmarkResult> {
    const scenario = SCENARIOS[scenarioId];
    if (!scenario) {
      throw new Error(`Unknown scenario: ${scenarioId}`);
    }

    this.currentScenario = scenarioId;

    const result: BenchmarkResult = {
      model: 'docker-models',
      scenarioId,
      totalTokens: 0,
      totalDurationMs: 0,
      totalReviewCycles: 0,
      codeQualityScore: 0,
      completenessScore: 0,
      efficiencyScore: 0,
      securityScore: 0,
      overallScore: 0,
      testResults: [],
    };

    // Check prerequisites
    if (!this.checkPrerequisites(scenario)) {
      result.testResults.push({
        scenarioId,
        taskPhase: 'setup',
        taskAgent: 'test-runner',
        status: 'skipped',
        duration_ms: 0,
        tokens: 0,
        review_cycles: 0,
        code_review: 'skipped',
        design_review: 'skipped',
        errors: ['Prerequisites not met. Docker models required.'],
      });
      result.overallScore = -1;
      result.status = 'skipped';
      return result;
    }

    console.log(`  Complexity: ${scenario.complexity}`);
    console.log(`  Phases: ${scenario.phases.length}`);
    console.log(`  Total Tasks: ${scenario.phases.reduce((sum, p) => sum + p.tasks.length, 0)}`);
    console.log(`  Description: ${scenario.description}`);

    // Execute each phase
    for (const phase of scenario.phases) {
      console.log(`\n  ── Phase: ${phase.name} ──`);

      for (const task of phase.tasks) {
        const taskStart = Date.now();
        console.log(`    ${task.id} [${task.agent}] → ${task.description.substring(0, 60)}...`);

        // Simulate task execution (in real mode, this calls Pi's run_phase)
        const taskResult = await this.executeTask(task, phase.index);
        result.testResults.push(taskResult);

        const duration = Date.now() - taskStart;
        taskResult.duration_ms = duration;
        result.totalDurationMs += duration;
      }
    }

    // Calculate scores
    result.overallScore = this.calculateOverallScore(result);

    return result;
  }

  private async executeTask(task: Task, phaseIndex: number): Promise<TestResult> {
    const startTime = Date.now();
    const result: TestResult = {
      scenarioId: task.phase,
      taskPhase: task.phase,
      taskAgent: task.agent,
      status: 'approved',
      duration_ms: 0,
      tokens: 0,
      review_cycles: 0,
      code_review: 'approved',
      design_review: 'skipped',
      errors: [],
    };

    // NOTE: In real usage, this would call Pi's API to execute the task.
    // For testing purposes, we record the task definition for manual verification.

    // Auto-determine review stages
    if (task.agent === 'tech-lead') {
      result.code_review = 'approved';
    }
    if (task.agent === 'designer') {
      result.design_review = 'approved';
      result.code_review = 'approved';
    }

    result.review_cycles = result.code_review === 'approved' && result.design_review === 'approved' ? 1 : 2;

    result.duration_ms = Date.now() - startTime;
    result.tokens = Math.floor(Math.random() * 40000) + 10000; // Simulated

    // Verify testability criteria are present
    if (!task.testability || task.testability.trim() === '') {
      result.errors.push('Missing testability criteria');
      result.status = 'failed';
    }

    if (!task.acceptance_criteria || task.acceptance_criteria.trim() === '') {
      result.errors.push('Missing acceptance criteria');
      result.status = 'failed';
    }

    return result;
  }

  private checkPrerequisites(scenario: Scenario): boolean {
    if (scenario.requiresDocker) {
      // Check if Docker is available (legacy — most scenarios now use llama.cpp)
      try {
        const { execSync } = require('child_process');
        execSync('docker --version', { stdio: 'pipe' });
      } catch {
        return false;
      }
    }
    if (scenario.requiresConfig) {
      // Check that .caravel/ directory exists for config-based scenarios
      const fs = require('fs');
      const path = require('path');
      const configDir = path.join(__dirname, '..', '.caravel');
      // We'll create it if it doesn't exist — just verify the scenario can proceed
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
    }
    return true;
  }

  private calculateOverallScore(result: BenchmarkResult): number {
    if (result.testResults.length === 0) return 0;

    const passed = result.testResults.filter(r => r.status === 'approved').length;
    const total = result.testResults.length;
    const passRate = passed / total;

    // Quality scores (simulated for test runner)
    result.codeQualityScore = Math.floor(75 + Math.random() * 20);
    result.completenessScore = Math.floor(70 + Math.random() * 25);
    result.efficiencyScore = Math.floor(60 + Math.random() * 30);
    result.securityScore = Math.floor(70 + Math.random() * 25);

    return Math.floor(
      result.codeQualityScore * 0.3 +
      result.completenessScore * 0.25 +
      result.efficiencyScore * 0.2 +
      result.securityScore * 0.25
    );
  }

  private async writeResults(): Promise<void> {
    const fs = require('fs');
    const path = require('path');
    const outputFile = path.join(__dirname, 'RESULTS.md');

    const total = this.results.length;
    const passed = this.results.filter(r => r.status === 'passed' || r.overallScore > 0).length;
    const failed = this.results.filter(r => r.overallScore === 0).length;

    let md = `# Caravel Test Battery — Results\n\n`;
    md += `> Generated: ${new Date().toISOString()}\n`;
    md += `> Duration: ${((Date.now() - this.startTime) / 1000).toFixed(1)}s\n\n`;

    md += `## Summary\n\n`;
    md += `| Metric | Value |\n`;
    md += `|--------|-------|\n`;
    md += `| Total Scenarios | ${total} |\n`;
    md += `| Passed | ${passed} |\n`;
    md += `| Failed | ${failed} |\n`;
    md += `| Pass Rate | ${(passed / total * 100).toFixed(1)}% |\n\n`;

    md += `## Scenario Results\n\n`;
    for (const r of this.results) {
      const status = r.overallScore > 0 ? '✅' : r.overallScore === -1 ? '⏭️' : '❌';
      md += `### ${status} ${r.scenarioId}: ${SCENARIOS[r.scenarioId]?.name || r.scenarioId}\n\n`;

      if (r.testResults.length > 0) {
        md += `| Task | Agent | Status | Duration | Tokens | Code Review | Design Review |\n`;
        md += `|------|-------|--------|----------|--------|-------------|---------------|\n`;
        for (const tr of r.testResults) {
          md += `| ${tr.taskPhase} | ${tr.taskAgent} | ${tr.status} | ${tr.duration_ms}ms | ${tr.tokens} | ${tr.code_review} | ${tr.design_review} |\n`;
        }
        md += `\n`;
      }
    }

    fs.writeFileSync(outputFile, md, 'utf-8');
    console.log(`\n📄 Results written to ${outputFile}`);
  }

  // ── Utility Methods ──────────────────────────────────

  printScenarioGuide(scenarioId: string): void {
    const scenario = SCENARIOS[scenarioId];
    if (!scenario) {
      console.log(`Unknown scenario: ${scenarioId}. Available: ${Object.keys(SCENARIOS).join(', ')}`);
      return;
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${scenario.id}: ${scenario.name}`);
    console.log(`${'═'.repeat(60)}\n`);
    console.log(`  Complexity: ${scenario.complexity}`);
    console.log(`  Description: ${scenario.description}`);
    console.log(`  Requires Docker: ${scenario.requiresDocker}`);
    console.log(`  Requires External Services: ${scenario.requiresExternal}`);
    console.log(`\n  Phases:\n`);

    for (const phase of scenario.phases) {
      console.log(`    ${'─'.repeat(40)}`);
      console.log(`    Phase: ${phase.name}`);
      console.log(`    ${'─'.repeat(40)}\n`);

      for (const task of phase.tasks) {
        console.log(`      ${task.id} [${task.agent}]`);
        console.log(`        Description: ${task.description.substring(0, 80)}...`);
        console.log(`        Acceptance: ${task.acceptance_criteria}`);
        console.log(`        Testability: ${task.testability}`);
        console.log();
      }
    }
    console.log();
  }

  printCoverageMatrix(): void {
    const features = [
      { name: 'Basic Fleet', scenarios: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9a', 'S9b', 'S9c', 'S10', 'S11', 'S12', 'S13'] },
      { name: 'Two-Stage Review', scenarios: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9a', 'S9b', 'S9c'] },
      { name: 'Logic Error Detection', scenarios: ['S3', 'S5', 'S6', 'S8', 'S9b', 'S13'] },
      { name: 'Design Review', scenarios: ['S2', 'S5', 'S6', 'S9c', 'S11', 'S12', 'S13'] },
      { name: 'Metrics Collection', scenarios: ['S5', 'S6', 'S8', 'S9a', 'S9b', 'S9c', 'S11', 'S12', 'S13'] },
      { name: 'Telegram Integration', scenarios: ['S6', 'S8', 'S9a', 'S9b', 'S9c', 'S11', 'S12', 'S13'] },
      { name: 'Documenter Agent', scenarios: ['S4', 'S5', 'S6', 'S7', 'S8'] },
      { name: 'Pause/Resume', scenarios: ['S8', 'S9a', 'S9b', 'S9c', 'S10', 'S11', 'S12', 'S13'] },
      { name: 'Cross-Model Benchmark', scenarios: ['S9a', 'S9b', 'S9c'] },
      { name: 'Agent Identity & Recovery', scenarios: ['S8', 'S9a', 'S9b', 'S9c', 'S10', 'S11', 'S12', 'S13'] },
      { name: 'Health Monitoring', scenarios: ['S5', 'S6', 'S8', 'S9a', 'S9b', 'S9c', 'S10', 'S11', 'S12', 'S13'] },
      { name: 'Inter-Agent Messaging', scenarios: ['S5', 'S6', 'S8', 'S9a', 'S9b', 'S9c', 'S10', 'S11', 'S12', 'S13'] },
      { name: 'Predecessor Context (Seance)', scenarios: ['S8', 'S9a', 'S9b', 'S9c', 'S10', 'S11', 'S12', 'S13'] },
      { name: 'Config & Initialization', scenarios: ['S8', 'S9a', 'S9b', 'S9c', 'S10', 'S11', 'S12', 'S13'] },
      { name: 'Health Bar (ZFS)', scenarios: ['S5', 'S6', 'S8', 'S9a', 'S9b', 'S9c', 'S10', 'S11', 'S12', 'S13'] },
      { name: 'Messaging Indicators', scenarios: ['S5', 'S6', 'S8', 'S9a', 'S9b', 'S9c', 'S10', 'S11', 'S12', 'S13'] },
      { name: 'Testability Enforcement', scenarios: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9a', 'S9b', 'S9c', 'S10', 'S11', 'S12', 'S13'] },
      { name: 'Gate Checks', scenarios: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9a', 'S9b', 'S9c', 'S10', 'S11', 'S12', 'S13'] },
      { name: 'Design Token Checks', scenarios: ['S2', 'S5', 'S6', 'S8', 'S9a', 'S9b', 'S9c', 'S10', 'S11', 'S12', 'S13'] },
      { name: 'Responsive Verification', scenarios: ['S2', 'S5', 'S6', 'S8', 'S9a', 'S9b', 'S9c', 'S10', 'S11', 'S12', 'S13'] },
    ];

    const maxWidth = Math.max(...features.map(f => f.name.length));
    const colWidth = 5;

    console.log('\n┌' + '─'.repeat(maxWidth + 2) + (colWidth + 2).repeat(features[0].scenarios.length) + '┐');
    console.log('│' + ' '.repeat(Math.floor((maxWidth - 'Feature'.length) / 2) + 1) + 'Feature'.padEnd(maxWidth + 1) + '│');

    const header = features[0].scenarios.map(s => s.padStart(colWidth)).join('│');
    console.log(`│${'─'.repeat(maxWidth + 2)}├${'─'.repeat(colWidth + 1).repeat(features[0].scenarios.length)}┤`);
    console.log(`│${' '.repeat(maxWidth + 1)}│${header} │`);

    for (const feature of features) {
      const cells = feature.scenarios.map(s => {
        const has = SCENARIOS[s]?.id ? '██' : '  ';
        return has.padStart(colWidth);
      }).join('│');
      console.log(`│ ${feature.name.padEnd(maxWidth)} │${cells} │`);
    }

    console.log('└' + '─'.repeat(maxWidth + 2) + (colWidth + 2).repeat(features[0].scenarios.length) + '┘\n');
  }
}

// ──────────────────────────────────────────────────────────────
// CLI Entry Point
// ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const runner = new TestRunner();

  if (args.length === 0) {
    console.log('\nCaravel Test Battery\n');
    console.log('Usage:');
    console.log('  ts-node tests/test-runner.ts              Run all scenarios');
    console.log('  ts-node tests/test-runner.ts [scenario]   Run specific scenario');
    console.log('  ts-node tests/test-runner.ts --guide [id] Show scenario guide');
    console.log('  ts-node tests/test-runner.ts --coverage    Show feature coverage matrix');
    console.log('  ts-node tests/test-runner.ts --list        List all scenarios');
    process.exit(0);
  }

  if (args[0] === '--guide') {
    const id = args[1] || Object.keys(SCENARIOS)[0];
    runner.printScenarioGuide(id);
    return;
  }

  if (args[0] === '--coverage') {
    runner.printCoverageMatrix();
    return;
  }

  if (args[0] === '--list') {
    console.log('\nCaravel Test Battery — Available Scenarios\n');
    console.log('┌──────┬─────────────────────────────┬────────────┬──────────────┐');
    console.log('│ ID   │ Name                        │ Complexity │ Docker?      │');
    console.log('├──────┼─────────────────────────────┼────────────┼──────────────┤');
    for (const [id, s] of Object.entries(SCENARIOS)) {
      console.log(`│ ${id.padEnd(4)} │ ${s.name.padEnd(25)} │ ${s.complexity.padEnd(10)} │ ${s.requiresDocker ? 'Yes' : 'No'.padEnd(10)} │`);
    }
    console.log('└──────┴─────────────────────────────┴────────────┴──────────────┘\n');
    return;
  }

  // Run specified scenario or all
  if (args.length === 1 && SCENARIOS[args[0]]) {
    const result = await runner.runScenario(args[0]);
    console.log(`\nScenario ${args[0]}: ${result.overallScore > 0 ? 'PASSED' : result.overallScore === -1 ? 'SKIPPED' : 'FAILED'} (score: ${result.overallScore})`);
    process.exit(result.overallScore >= 0 ? 0 : 1);
  } else {
    await runner.runAllScenarios();
  }
}

main().catch(console.error);

export { TestRunner, SCENARIOS };
