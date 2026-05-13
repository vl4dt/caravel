# New Features and Issues

## Agents

- [○] **F1**: Documenter, in charge of writing and keeping documentation.
- [○] **F2**: Update the Designer agent to in addition to the current responsibilities also be the one in charge of defining the UI and UX guidelines, creating the design system and building and polishing all UI assets.
- [○] **F3**: Update the agents in charge of reviews to make sure every deliverable by the developer agent or designer agent complies with the requirements and is done for every task they determine to be complete and before they take and begin working on a new task.

## UI

- [✓] **F1**: The run_phase execution output still prints previously discussed garbage output:

```bash
▸ developer (llama.cpp/Qwen/Qwen3.6-35B-A3B-GGUF:Q4_K_M): xrGYPhTZ3b","responseModel":"Qwen3.6-35  [127k tokens]
```

The **_xrGYPhTZ3b","responseModel":"Qwen3.6-35_** portion is completely useless as it is.
The **_[127k tokens]_** part is still unclear what it represents.

It would be better if we had something like this:

```bash
run_phase
  ✓ T1 [OK] developer → Build TUI app... (llama.cpp/Qwen/Qwen3.6-35B-A3B-GGUF:Q4_K_M) [127k tokens] | 37m
  ▸ T2 [RUN] developer → Build all gauge... (llama.cpp/Qwen/Qwen3.6-35B-A3B-GGUF:Q4_K_M) [72k tokens] | 16m
    > writing: important_file.rs | 23s
  ○ T3 [WAIT] developer → Build sparkline...
```

- [○] **F2**: The widget bar reviews line shows unclear data:

```bash
0 reviews  │  Elapsed: 1h 48m
```

What does 0 reviews mean? at this point still there has been no reviews done? then what is that Elapsed time mean? it could be useful if it was the time spent reviewing across all reviews.

- [○] **F3**: The tokens line appears to show the same numbers or is unclear if the first one is the total tokens stats across all phases and all tasks or by the developer agent because these are the same numbers as the ones on the right:

```bash
▸ tokens: 71kin / 75kout │ [developer(71k/75k)]
```

## Core

- [○] **F1**: If we start the fleet using background processes can we in the middle of the execution launch the fleet in ZFS? or move it to ZFS? what would happen if we try? figure out the best approach to choose.
- [○] **F2**: Can we pause the whole fleet, serialize the current state of things, leave, come back and resume later? does the execution of the project plan survives multiple sessions? it would be great if it could survive even a blackout or a sudden interruption.
- [○] **F3**: It would be nice to have options of communications channels such as Telegram, not to act as Open Claw or Hermes or similar but to be follow on success or failure of tasks, situations where the user input is required to continue, the user should be able to leave the plan execution unattended but be able to monitor at a distance.
- [○] **F4**: Integration with https://linear.app/
- [○] **F5**: Integration with https://plane.so/
- [○] **F6**: Collect and measure every valuable metric for analysis, reporting and budgeting, everything that is important to review, retrospect and budget a project.
- [○] **F7**: I've noticed that the reviews don't catch lots of errors in the code in several kinds of codebases we need reviews that look for logic errors and every other kind of mistake that could cause the code to fail at runtime or fail to launch at all like stubs and placeholders that were never replaced, missing imports, missing definitions or implementations, things that show that the project was not really done. The definition of done should be "complete", I doubt there are any reviews happening at all and even the widget bar says "0 reviews" even after finishing all tasks on all phases.
- [○] **F9**: Update the agent or agents, skills and/or logic and processes to enforce the criteria that every product every task every work unit and deliverable should be testable that will determine the size of the tasks.
