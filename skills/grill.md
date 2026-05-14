---
name: grill
description: The /grill command relentlessly challenges the user's project idea from both angles — the requirements (why are we building this? what problem are we solving?) and the plan (is this the right approach? what are we missing?). One question at a time, relentless. Persists output to SCOPE.md. Use when user says "/grill", "grill me", "challenge my idea", "stress-test this", or when scope is unclear and you would normally delegate to the planner.
---

# /grill Command

## Purpose

Before planning or building, **stress-test the user's idea relentlessly**. Challenge both the *requirements* and the *plan*. Produce a durable `SCOPE.md` artifact.

## Invocation

The user invokes this by typing `/grill` or `/grill-me`, or by saying:
- "grill me"
- "challenge my idea"
- "stress-test this"
- "don't just build it, question it"

The main agent can also **auto-trigger** when the user's request is too vague.

## How It Works

### 1. Two-Angle Challenge

The grill attacks from **two independent angles**, one question at a time:

#### Angle A: Requirements (The "Why")
- What problem are we actually solving?
- Who is this for? What do they do today?
- What happens if we *don't* build this?
- What does success look like in measurable terms?
- What's the simplest thing that could possibly work?
- Are we building a prototype, MVP, or production system?
- What are we explicitly NOT building?

#### Angle B: Plan (The "How")
- Are we tackling the right things in the right order?
- What are we missing? What edge cases?
- What assumptions are we making that might be wrong?
- Is the tech stack appropriate for the scale?
- What could go wrong?
- What are the trade-offs of each major decision?

### 2. Ask ONE Question at a Time

Ask questions **one at a time**, relentlessly. Do not dump multiple questions. For each question:

- Provide your **recommended answer** with reasoning
- Wait for the user's response
- If the answer is vague, push back harder
- If the answer reveals a flaw, dig deeper
- Move to the next question only after resolving the current one

### 3. Sign Off

When the user seems ready (they say "let's move on", "that's enough", "looks good", or similar), produce:

1. **A checklist** — every major decision point with the agreed answer
2. **SCOPE.md** — a structured artifact that both angles of the grill produce

### 4. Persist to SCOPE.md

The output is **always persisted** to `SCOPE.md` in the project root. This is not a chat-only interaction.

```markdown
# Project Scope

> Grill completed: YYYY-MM-DD
> Questions asked: N
> User confirmed: Yes
> Plan ready: Yes / No

## Requirements (The "Why")

| # | Question | Answer | Confirmed |
|---|----------|--------|-----------|
| 1 | Problem? | ... | ☑ User |
| 2 | Users? | ... | ☐ Pending |

## Design Decisions (The "How")

| # | Decision | Answer | Confirmed |
|---|----------|--------|-----------|
| 1 | Tech stack? | ... | ☑ User |
| 2 | Priority? | ... | ☐ Pending |

## Exclusions

- Explicitly NOT building:
  - ...
  - ...

## Risks & Unknowns

- ...

## Sign-Off

User confirmed: ☐ Not confirmed ☑ Confirmed
Ready to plan: ☐ Not ready ☑ Ready
```

## Auto-Trigger Conditions

The main agent should **auto-trigger** the grill when:

1. User says something vague like "build me something cool" or "I want a web app"
2. User's request has no clear problem statement
3. User's request has no defined users or success criteria
4. User jumps straight to implementation without clarifying scope
5. The planner would be too uncertain to produce a useful plan

When auto-triggering, the main agent should say:

> "Before I plan this, let me challenge your idea to make sure we build the right thing. This will produce a `SCOPE.md` — one question at a time. Ready?"

## Rules

- **Relentless but respectful** — push hard, don't soft-pedal
- **Recommended answers** — always provide your recommendation with reasoning
- **No question dumping** — one question, wait for response, then next
- **Persist everything** — output to `SCOPE.md`, not just chat
- **Track sign-off** — explicitly mark what the user has confirmed vs. what's pending
- **Call out gaps** — if the user skips a critical question, flag it
- **Know when to stop** — when the user signals readiness, produce the sign-off
- **Don't over-grill** — for simple, well-defined requests, do a lighter pass

## When NOT to Grill

- The user explicitly says "skip the grill" or "just build it"
- The request is already crystal clear (e.g., "add a button to page X")
- The user is in the middle of `/go` — don't interrupt active execution
- The user says they already have a scope document they want to use

## Output

The `/grill` command produces `SCOPE.md` in the project root:

```bash
# After running /grill:
✓ Grill complete.
  Questions asked: 14
  User confirmed: Yes
  Artifact: SCOPE.md
  Status: Ready to plan → run /plan or /go
```

## Example Flow

```
User: /grill
Agent:
  Q1: "What problem does this solve for users?
       My guess: you need a way to track personal expenses and see where money goes.
       Is that right, or is the real problem something else?"
  ...
  (user responds)
  
  Agent:
  Q2: "Who specifically is using this? Yourself? Your team? External customers?
       This changes the scope significantly. My guess: just you for now.
       Am I right?"
  ...
  (continues one question at a time)
  
  Agent:
  "Alright, I think we have enough. Let me produce the scope.
   
   ✓ Scope produced: SCOPE.md
   Questions: 14 | Confirmed: Yes
   Ready to plan."
```

## When to Use

- User types `/grill` or `/grill-me`
- User says "challenge my idea", "stress-test this", "grill me"
- Scope is unclear and you're about to plan or delegate to the planner
- Before `plan_project()` — to ensure foundations are solid
- After `/analyze` — to challenge the analysis assumptions

## When Not to Use

- User says "skip the grill"
- Request is already specific and clear
- During active `/go` execution
- User explicitly has a scope document they want to use

## Integration with Planner

After the grill completes:

1. **If the user confirms the scope** → delegate to the planner:
   > "Scope is solid. I'll hand you off to the planner who will turn this into a phased plan."

2. **If the user wants to plan directly** → proceed to `plan_project()`:
   > "Scope confirmed. Let's plan: `plan_project({ name: '...', phases: [...] })`"

3. **If more grill is needed** → continue grilling:
   > "One more question before we move on..."
