---
name: fleet-orchestration
description: Auto-orchestrate the caravel fleet based on natural language user requests. Use when the user describes a project, says "build X", "create Y", or otherwise wants the fleet to plan and execute.
---

# Fleet Orchestration Skill

When the user describes a project or feature they want to build, follow this flow:

## Flow

1. **Assess scope** — Is this a full project that needs fleet orchestration, or a simple fix?
   - If simple fix → handle directly, no fleet needed
   - If full project → continue to planning

2. **Plan** — If the user hasn't described the project in enough detail to plan, use the **planner** agent (`agents/planner.md`) to interview them:
   ```
   subagent("planner", "Help me plan the project described above")
   ```
   The planner will ask questions one at a time and produce a `plan_project()` call.

3. **Execute** — Once a plan exists (either user provided or planner generated):
   ```
   // The plan_project call should be in context now
   run_phase(phaseIndex=0)
   review_task(phaseIndex=0)
   run_phase(phaseIndex=1)
   review_task(phaseIndex=1)
   // ... continue for all phases
   ```

4. **Monitor** — Open the dashboard with `/fleet` so the user can watch progress
   - Report phase completions to the user
   - If a review fails, explain what needs fixing

## Key Principles

- **Never ask the user to type TypeScript** — they describe in natural language
- **Use the planner agent** when the project scope is unclear
- **Auto-run** — after planning is complete, execute without asking
- **Report progress** — keep the user informed of what's happening
- **Respect interruptions** — if the user says "pause" or "stop", obey

## Example Interaction

```
User: "I want to build a kanban board app with drag-and-drop"
You: "Sure! Let me plan this out.
     What tech stack would you prefer? I recommend React + TypeScript + TailwindCSS,
     or I can suggest alternatives if you have preferences."
     (planner agent asks one question at a time)
...
     (planner produces plan_project call)
You: "Plan ready. Launching the fleet..."
     run_phase(phaseIndex=0)
     review_task(phaseIndex=0)
     // ...
```
