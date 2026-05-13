# Caravel Tutorials — Learn by Doing

> Step-by-step tutorials for humans to learn Caravel from zero to mastery.
> Each tutorial is a hands-on exercise you follow in your own Pi session.
> No automation — just you, Pi, and the fleet.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Tier 1: First Fleet (Beginner)](#tier-1-first-fleet)
- [Tier 2: Review & Quality (Intermediate)](#tier-2-review-and-quality)
- [Tier 3: Real Projects (Advanced)](#tier-3-real-projects)
- [Tier 4: ZFS Mode (Power User)](#tier-4-zfs-mode)
- [Tier 5: Benchmarks & Customization (Expert)](#tier-5-benchmarks-and-customization)
- [Quick Reference](#quick-reference)

---

## Getting Started

### What You'll Need

1. **Pi v0.74+** installed and working
2. **Caravel extension** installed (see README.md → Installation)
3. **At least one model provider** configured in `~/.pi/agent/models.json`
4. **A project to work on** — we'll use a small, self-contained project so you can see results quickly

### First Time Setup Checklist

Run through these steps before starting the tutorials:

```bash
# 1. Verify Pi works
pi --list-models

# 2. Verify Caravel extension is loaded
# In Pi chat, type: /fleet
# You should see the Caravel widget bar

# 3. Verify your models.json has valid entries
# Check that provider names match what agents expect
```

### How to Use These Tutorials

Each tutorial has:

- **Goal** — what you'll build or learn
- **Steps** — exact things to type and do
- **What to expect** — what should happen
- **Verify** — how to check you succeeded
- **Troubleshooting** — common issues and fixes

**Pro tip:** Work in an empty directory for each tutorial so you don't clutter your workspace:

```bash
mkdir -p ~/caravel-tutorials && cd ~/caravel-tutorials
```

---

## Tier 1: First Fleet

### T1 — Your First Fleet: A CLI Task Manager

**Goal:** Understand the core fleet workflow — plan → execute → review → complete.

**Time:** 15–30 minutes

**What you'll learn:**
- How to describe a project in natural language
- How `plan_project` decomposes work into phases and tasks
- How the fleet executes tasks with sub-agents
- How two-stage review works (code + design)
- How to monitor progress via the widget bar

#### Step 1: Describe Your Project

Open Pi and type this in the chat:

> "I want to build a CLI task manager with a Kanban-style board. It should support creating tasks with title, description, priority, and status (todo, in-progress, done). Tasks should be persisted to a JSON file. It should have commands to list, add, move, delete, and search tasks."

**What to expect:** The main agent should respond with a plan proposal, breaking the project into phases.

#### Step 2: Review and Adjust the Plan

The main agent should present a phased plan. Review it:

- Are there enough phases? (You should see: setup, core data model, CLI commands, persistence, polish)
- Are the tasks specific and actionable?
- Does each task have a clear agent assignment?

If the plan looks good, say:

> "Yes, proceed with this plan."

If you want changes:

> "Add a phase for input validation. Make the tech lead review the architecture first."

#### Step 3: Launch the Fleet

Type:

> "go"

or

> "launch the fleet"

or

> "start building"

**What to expect:**
- The widget bar appears showing fleet status
- Phases run sequentially with review between each
- You'll see per-task details: which agent is working, which model, token counts
- Progress bar advances as tasks complete

Watch the widget bar for a minute — you should see:

```
CARAVEL FLEET  │  P1/5: Setup  │  ▸ RUN
[████░░░░░░░░░░░░] 20%  │  1/5 tasks
▸ P1 [RUN] developer → ollama/qwen3
▸ P2 [WAIT]
▸ P3 [WAIT]
2 reviews │ Elapsed: 1m 23s
```

#### Step 4: Watch the Review Gate

After a phase completes, you'll see review activity in the widget bar:

```
▸ P1 [REV] 2-stage review in progress
  Code review: tech-lead → llama.cpp/Qwen3
  Design review: designer → gemma4
```

The two-stage review checks:
1. **Code review** — correctness, architecture, edge cases
2. **Design review** — CLI UX, consistency, polish

If review finds issues, the developer auto-fixes and resubmits. Watch for the fix loop.

#### Step 5: Verify the Output

When the fleet completes (widget bar shows "DONE"), verify:

```bash
# Check the project structure
ls -la

# Run the task manager
node index.js add "Buy groceries" --priority high
node index.js add "Write report" --priority medium
node index.js list
node index.js list --status todo
node index.js move 1 done
node index.js delete 2
node index.js search groceries
```

**Expected results:**
- ✅ Tasks are created and persisted
- ✅ JSON file exists with task data
- ✅ `list` shows all tasks with status
- ✅ `move` changes task status
- ✅ `delete` removes a task
- ✅ `search` finds tasks by keyword

#### Troubleshooting

| Issue | Fix |
|-------|-----|
| Widget bar doesn't appear | Run `/fleet` to toggle visibility |
| Fleet hangs | Run `/diagnose` for root-cause analysis |
| Review fails repeatedly | Check that designer model supports vision (`"input": ["text", "image"]`) |
| Agent exits with error | Run `fleet_error_diagnosis()` for details |
| Model not found | Verify `~/.pi/agent/models.json` has the provider and model ID |

---

### T2 — Adding Dark Mode to an Existing App

**Goal:** Learn the analyze → plan → execute workflow for existing codebases.

**Time:** 10–20 minutes

**What you'll learn:**
- How `/analyze` scans an existing codebase
- How the auditor agent produces an analysis report
- How `/plan` converts analysis into phases
- Taking over and extending existing code

#### Step 1: Use the T1 Project

We'll add dark mode to the T1 task manager. First, make sure you've completed T1 and have a working project.

#### Step 2: Run Analysis

In Pi, type:

> "/analyze"

The agent runs a pre-flight scan and produces `ANALYSIS.md`:

```
✅ Codebase Analysis Complete

▸ Agent & Model
  • Agent: auditor
  • Model: ollama/qwen3:8b

▸ Execution
  • Input Tokens: 8,200
  • Output Tokens: 5,400

▸ Pre-Flight Scan
  ○ Total Files: 12
  ○ Languages: TypeScript
  ○ Entry Points: index.ts, config.json
  ○ Test Infrastructure: ✗ Not detected
```

#### Step 3: Review the Analysis

Read `ANALYSIS.md` in the editor. Look for:
- Detected frameworks and dependencies
- Entry points and file structure
- Any issues flagged

#### Step 4: Generate a Plan

Type:

> "/plan"

The planner generates `PLAN.md` with phases for adding dark mode. Review it:
- Does it cover all files that need changes? (CLI output, config, help text)
- Are phases ordered correctly? (config → implementation → testing)
- Are tasks specific enough?

#### Step 5: Execute

Type:

> "go"

#### Step 6: Verify Dark Mode

After completion, test:

```bash
# Toggle dark mode
node index.js config set theme dark

# Check output — should use ANSI dark mode colors
node index.js list

# Toggle back
node index.js config set theme light
```

---

### T3 — Exploring Fleet Commands

**Goal:** Get comfortable with all fleet control commands.

**Time:** 5–10 minutes

**What you'll learn:** All fleet control commands through hands-on use.

#### Quick Exercise: Start, Pause, Resume, Reset

1. Start any small project (a CLI calculator, a todo list, etc.):
   > "Build a simple CLI calculator with add, subtract, multiply, divide"

2. Let it run for a phase, then:
   > "pause"

3. Watch the widget bar change to "PAUSED":
   ```
   CARAVEL FLEET  │  P1/3  │  ⏸ PAUSED
   ```

4. Resume:
   > "resume"

5. After a phase completes, skip it:
   > "skip this phase"

6. Move to next:
   > "next phase"

7. Reset the entire fleet:
   > "reset"

8. Verify state was cleared:
   > fleet_status

---

## Tier 2: Review & Quality

### T4 — Understanding Two-Stage Review

**Goal:** Deep-dive into how the two-stage review process works.

**Time:** 15–25 minutes

**What you'll learn:**
- How code review and design review differ
- How review feedback flows to the developer
- How the fix loop works
- When and why reviews pass/fail

#### Step 1: Build Something with Visual Elements

> "Build a CLI expense tracker with a table view showing date, description, amount, and category. Format the table with alignment and borders."

This gives the designer something visual to review (table formatting).

#### Step 2: Watch the Review Process

When the fleet reaches review, observe:

```
CARAVEL FLEET  │  P2/4: Table View  │  ▸ REV
  Code review: tech-lead → llama.cpp/Qwen3
  Design review: designer → gemma4
```

In the agent output, you'll see:
- **Code review notes** — architecture, edge cases, error handling
- **Design review notes** — table alignment, color contrast, spacing

#### Step 3: Trigger Manual Review

After the fleet completes a phase, manually trigger another review:

> "review this phase"

or

> "run review"

Watch how the agents evaluate the same code differently:
- **Tech lead** focuses on correctness, performance, security
- **Designer** focuses on layout, consistency, accessibility

#### Step 4: Provide Manual Feedback

Give specific feedback:

> "review this phase with feedback: 'The table borders should use double-line characters, and the amount column should right-align with dollar signs'"

The developer will apply your feedback and resubmit.

---

### T5 — Code Review Deep Dive

**Goal:** Understand what the tech lead checks during code review.

**Time:** 10–15 minutes

**What you'll learn:** Common code quality issues the tech lead catches.

#### Step 1: Build a Project with Intentional Flaws

> "Build a CLI blog post manager that stores posts in JSON. Include: create, list, get, delete. Add full-text search with fuzzy matching."

The tech lead should flag:
- Missing input validation
- No error handling for file operations
- Inefficient search algorithm
- No schema validation for the JSON store

#### Step 2: Read the Review Output

After review, check the agent conversation for code review notes. Look for:

| Category | What to Look For |
|----------|-----------------|
| **Correctness** | Null checks, boundary conditions, edge cases |
| **Security** | Path traversal, injection, data exposure |
| **Performance** | O(n²) algorithms, unnecessary re-reads |
| **Architecture** | Separation of concerns, extensibility |
| **Testing** | Missing test coverage, testable design |

#### Step 3: Force a Review Loop

Give feedback that will cause the review to fail:

> "review this phase with feedback: 'There's no input validation on the post title. Add maximum length check and trim whitespace.'"

Watch the developer fix it and resubmit. This is the **red-green-refactor loop** in action.

---

## Tier 3: Real Projects

### T6 — Full-Stack Web App with Caravel

**Goal:** Build a complete web application end-to-end using the fleet.

**Time:** 30–60 minutes

**What you'll learn:**
- Building a full-stack project with Caravel
- Coordinating multiple agents on a larger project
- Managing the review process for a complex application

#### Step 1: Describe a Web App

> "I want to build a Kanban board web app with: multiple boards, drag-and-drop between columns, local storage persistence, dark mode, and responsive design."

This is a substantial project that should generate:
- 4–6 phases
- 10–20 tasks
- Multiple review iterations

#### Step 2: Set Up the Fleet

Let the planner propose the plan. Review:
- Are there enough phases for a proper web app? (setup, UI, logic, persistence, polish)
- Does it include both frontend and any backend if needed?
- Is drag-and-drop given its own phase?

#### Step 3: Execute and Monitor

Type "go" and watch:

1. **Phase 1** — Project setup (framework, dependencies, structure)
2. **Phase 2** — Core UI components
3. **Phase 3** — Board logic and state management
4. **Phase 4** — Drag-and-drop implementation
5. **Phase 5** — Persistence and polish

Watch the widget bar for:
- Per-agent activity (who's working on what)
- Token usage (cost awareness)
- Review status (how many reviews per phase)

#### Step 4: Verify the App

Open the browser at `http://localhost:3000` (or whatever port the app uses):

- ✅ Multiple boards can be created
- ✅ Cards can be dragged between columns
- ✅ Board state persists across page reloads
- ✅ Dark mode toggle works
- ✅ Responsive on mobile viewports

---

### T7 — Documentation Project

**Goal:** Use Caravel to create comprehensive project documentation.

**Time:** 10–20 minutes

**What you'll learn:**
- Using Caravel for non-coding tasks
- Documenter agent capabilities
- Generating structured documentation

#### Step 1: Ask for a Documentation Project

> "Create a complete documentation site for a fictional REST API. Include: API reference with OpenAPI spec, getting started guide, authentication docs, error codes reference, and a changelog. Output as static HTML."

#### Step 2: Review the Generated Docs

When complete, check:
- Are all sections present and well-structured?
- Is the API reference accurate and complete?
- Is the getting started guide actionable?
- Is the styling consistent?

---

### T8 — Custom Agent Development

**Goal:** Learn to add custom agents to your Caravel setup.

**Time:** 15–20 minutes

**What you'll learn:**
- Agent configuration format
- Tool assignment per agent
- Model selection per agent

#### Step 1: Create a New Agent

Create `agents/researcher.md`:

```yaml
---
name: researcher
description: Research specialist for gathering information
model: openai/gpt-4o
tools: read,bash,grep,find,ls,searxng_search
---

You are a Research Specialist. Your role is to gather
information, analyze sources, and produce research reports.
Be thorough, cite sources, and flag uncertainties.
```

#### Step 2: Use the New Agent

> "I want to build a recipe app. Research the top 10 trending recipes this month and include them in the initial dataset. Use the researcher agent for this."

The planner should route the research task to your new agent.

---

## Tier 4: ZFS Mode

### T9 — ZFS Fleet Session

**Goal:** Run the fleet inside Zellij for real-time monitoring.

**Time:** 15–30 minutes

**What you'll learn:**
- Installing and configuring Zellij
- Starting a ZFS session
- Navigating between agent panes
- Using ZFS keyboard shortcuts
- Managing the floating status bar

#### Step 1: Install Zellij

```bash
# macOS
brew install zellij

# Linux
curl -LO https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz
tar xzf zellij-*.tar.gz && sudo mv zellij /usr/local/bin/

# Windows
winget install Zellij.Zellij
```

#### Step 2: Start ZFS

In Pi, type:

> "/zellij-start"

You should see Zellij launch with:
- Left pane: orchestrator (60% width)
- Right area: agent tabs (developer, tech-lead, designer)
- Floating status bar: fleet overview

#### Step 3: Navigate Panes

Use the keyboard shortcuts:
- `Ctrl+o` — switch to orchestrator
- `Ctrl+d` — switch to developer pane
- `Ctrl+t` — switch to tech-lead pane
- `Ctrl+D` — switch to designer pane
- `Ctrl+w` — toggle status bar

#### Step 4: Start a Fleet in ZFS

In the orchestrator pane, describe your project and type "go". Watch:
- Agent output streaming in real-time in their panes
- Status bar updating every 2 seconds
- Per-agent model names and token counts

#### Step 5: Try Layouts

```bash
# Switch to minimal layout (just orchestrator + developer)
zellij action switch-layout minimal

# Switch to review layout
zellij action switch-layout review

# Switch to wide layout (side-by-side)
zellij action switch-layout wide
```

#### Step 6: Stop ZFS

> "/zellij-stop"

---

### T10 — Multi-Monitor Setup

**Goal:** Set up Caravel across multiple monitors.

**Time:** 10 minutes

**What you'll learn:**
- Multi-monitor ZFS layout
- Optimizing agent pane placement
- Keyboard-driven cross-monitor workflow

#### Step 1: Configure ZFS for Multi-Monitor

In ZFS mode:
- Put the **orchestrator pane** on your main monitor
- Put **agent tabs** on a secondary monitor
- Status bar visible on the main monitor

#### Step 2: Test the Workflow

1. Start a fleet in ZFS
2. Navigate between monitors using `Ctrl+o`, `Ctrl+d`, etc.
3. Watch the status bar on the main monitor while reading agent output on the second

---

## Tier 5: Benchmarks & Customization

### T11 — Model Comparison

**Goal:** Compare different models on the same Caravel task.

**Time:** 30–60 minutes per model

**What you'll learn:**
- How to benchmark models systematically
- Reading and comparing token usage
- Evaluating code quality across models

#### Step 1: Choose a Benchmark Task

Pick a complex but well-defined project:

> "Build a CLI file organizer that groups files by type into subdirectories. Support custom rules, dry-run mode, and a summary report."

#### Step 2: Run with Model A

Set the developer model to your first model, run the fleet, and record:
- Total tokens used
- Number of review iterations
- Code quality (does it work?)
- Time to complete

#### Step 3: Switch Models and Rerun

Change `agents/developer.md` model, rerun the same prompt, record the same metrics.

#### Step 4: Compare

| Metric | Model A | Model B | Model C |
|--------|---------|---------|---------|
| Tokens (input) | | | |
| Tokens (output) | | | |
| Review iterations | | | |
| Works on first try | | | |
| Code quality | | | |

---

### T12 — Fleet Error Diagnosis

**Goal:** Learn to diagnose and fix fleet errors.

**Time:** 15 minutes

**What you'll learn:**
- Reading error diagnoses
- Common failure modes and fixes
- Using `fleet_error_diagnosis` effectively

#### Step 1: Intentionally Break Something

Start a project, then cause errors:

1. **Bad model reference:**
   Change `agents/developer.md` to use a non-existent model:
   ```yaml
   model: nonexistent/bogus-model
   ```
   Run a fleet — watch the error, then run `fleet_error_diagnosis()`.

2. **Missing agent:**
   Temporarily rename an agent file:
   ```bash
   mv agents/designer.md agents/designer.md.bak
   ```
   Run a fleet that needs the designer — observe the "missing agent" diagnosis.

3. **Rate limit / network error:**
   Cause a network error by pointing to a dead server in `models.json`.
   Observe the "rate limit / connection" diagnosis.

#### Step 2: Practice Diagnosis

For each error:
1. Run `fleet_error_diagnosis()`
2. Read the diagnosis output
3. Apply the suggested fix
4. Verify the fix

#### Step 3: Use /diagnose

In Pi, type:

> "/diagnose"

This runs the same diagnosis from the main agent. Compare the outputs.

---

## Quick Reference

### Commands You'll Use Most

| Command | What It Does | When to Use |
|---------|-------------|-------------|
| `go` / `/go` | Launch the fleet | After a plan exists |
| `pause` | Pause all agents | To take a break |
| `resume` | Resume paused agents | To continue |
| `/fleet` | Toggle widget bar | If you can't see the bar |
| `/analyze` | Scan existing codebase | Before working on old code |
| `/plan` | Generate phases/tasks | After analysis or planning |
| `/diagnose` | Diagnose errors | When something fails |
| `fleet_status` | Check fleet state | Anytime to check progress |
| `/zellij-start` | Start ZFS mode | Power user monitoring |
| `/zellij-stop` | Stop ZFS session | When done with ZFS |

### Troubleshooting Quick Guide

| Symptom | Try First |
|---------|-----------|
| Widget bar not visible | `/fleet` |
| Fleet not starting | `pi --list-models` to verify models |
| Agent exits with code 1 | `fleet_error_diagnosis()` |
| Review fails repeatedly | Check designer model supports vision |
| Token budget exceeded | Switch to a smaller model |
| ZFS not working | Verify Zellij is installed (`zellij --version`) |
| Plan is too vague | Give more specific requirements |
| Plan is too detailed | Say "simplify the plan" or "merge phases" |

### Natural Language Commands

You don't need to memorize commands — natural language works:

| Say | Interpreted As |
|-----|---------------|
| "go" | `fleet_control(action="go")` |
| "pause" | `fleet_control(action="pause")` |
| "resume" | `fleet_control(action="resume")` |
| "skip this" | `fleet_control(action="skip")` |
| "next" | `fleet_control(action="next")` |
| "reset" | `fleet_control(action="reset")` |
| "review" | `review_task()` |
| "analyze" | `/analyze` |
| "plan" | `/plan` |
| "diagnose" | `/diagnose` |
| "start ZFS" | `/zellij-start` |
| "stop ZFS" | `/zellij-stop` |

---

## Learning Path Summary

```
Getting Started (5 min)
    │
    ▼
Tier 1: First Fleet (45 min total)
  T1 → Core pipeline        ──▶ You understand the basic workflow
  T2 → Existing codebase    ──▶ You can extend existing projects
  T3 → Fleet commands       ──▶ You can control the fleet
    │
    ▼
Tier 2: Review & Quality (30 min total)
  T4 → Two-stage review     ──▶ You understand quality gates
  T5 → Code review          ──▶ You know what gets reviewed
    │
    ▼
Tier 3: Real Projects (60 min total)
  T6 → Full-stack app       ──▶ You can build real projects
  T7 → Documentation        ──▶ You can generate docs
  T8 → Custom agents        ──▶ You can extend Caravel
    │
    ▼
Tier 4: ZFS Mode (25 min total)
  T9 → ZFS session          ──▶ You monitor fleets in real-time
  T10 → Multi-monitor       ──▶ You optimize your workspace
    │
    ▼
Tier 5: Mastery (60 min total)
  T11 → Model benchmarks    ──▶ You can compare models
  T12 → Error diagnosis     ──▶ You can troubleshoot anything
```

---

## Tips for Learning

1. **Go slow** — complete each tutorial before moving to the next
2. **Read the widget bar** — it's your primary monitoring tool
3. **Don't skip review** — the review loop is where quality happens
4. **Read the analysis** — `/analyze` output tells you what Caravel "sees"
5. **Use `/diagnose`** — it's better than guessing when something fails
6. **Try ZFS** — once you're comfortable, ZFS transforms monitoring
7. **Benchmark early** — compare models on simple tasks before complex ones
8. **Customize agents** — once confident, add your own agents for your workflow

## Related Documentation

- **[README.md](README.md)** — Installation, architecture, configuration
- **[SKILL.md](SKILL.md)** — Agent-facing guide (for when agents read docs)
- **[PROJECT-DESIGN.md](PROJECT-DESIGN.md)** — Architecture decisions
- **[tests/SCENARIOS.md](tests/SCENARIOS.md)** — Automated test battery (agent-focused)
- **[tests/README.md](tests/README.md)** — Test battery reference
- **[zellij-fleet-config.md](zellij-fleet-config.md)** — ZFS configuration guide
