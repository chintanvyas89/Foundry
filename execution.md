# Workflow IR & Execution Engine Specification
**Version:** 2.0

---

# Overview

This document defines the architecture for executing AI-generated implementation plans inside a VS Code Chat Participant.

The goal is to separate the system into three independent components:

1. Planning Engine
2. Workflow IR (Intermediate Representation)
3. Execution Engine

The Planning Engine performs all reasoning.

The Execution Engine performs **zero reasoning**.

Instead, it interprets a deterministic workflow produced by the planner.

---

# Architecture

```
                              User

                                │

                                ▼

                  VS Code Chat (@codebase)

                                │

                                ▼

                   Chat Participant (Orchestrator)

                                │

             ┌──────────────────┴──────────────────┐
             │                                     │
             ▼                                     ▼

      Semantic Search                    Deterministic Search

             │                                     │
             └──────────────────┬──────────────────┘

                                ▼

                     Planning LLM Loop

                (multiple reasoning iterations)

                                ▼

                  Workflow IR (Final Output)

                                │

                                ▼

                     Execution Engine

        ┌──────────────┬───────────────┬──────────────┐
        │              │               │              │
        ▼              ▼               ▼              ▼

 WorkspaceExecutor  UserExecutor  TerminalExecutor ValidationExecutor

        │              │               │              │

        └──────────────┴───────────────┴──────────────┘

                                ▼

                      Progress Tracker

                                ▼

                    Stream updates to Chat
```

---

# Design Philosophy

Planning and execution are completely separated.

The planner understands:

- User intent
- Codebase
- Dependencies
- Architecture
- Required implementation

The executor understands only:

- Workflow IR
- Edit operations
- Terminal operations
- User interactions
- Validation

No architectural reasoning should happen after planning completes.

---

# Why Workflow IR?

Natural language plans are difficult to execute deterministically.

Workflow IR is the contract between:

```
Planning

↓

Execution
```

Everything after Workflow IR should be deterministic.

---

# Responsibilities

## Planner

Responsible for

- Semantic search
- Code graph lookup
- Dependency analysis
- Multi-step reasoning
- Implementation planning
- Producing Workflow IR

Planner MUST NOT execute anything.

---

## Chat Participant

The chat participant is the **workflow orchestrator**.

Responsibilities

- Receive user request
- Invoke planning pipeline
- Receive Workflow IR
- Invoke Execution Engine
- Stream progress
- Pause for manual steps
- Resume execution
- Display final summary

The chat participant DOES NOT perform editing itself.

It delegates execution to the Execution Engine.

---

## Execution Engine

Responsible for

- Reading Workflow IR
- Scheduling executable steps
- Invoking appropriate executors
- Tracking progress
- Persisting workflow state
- Resuming interrupted workflows

The Execution Engine performs zero planning.

---

# Why Not Hand Off To VS Code Chat?

The built-in VS Code Chat execution pipeline is not publicly extensible.

Instead:

```
User

↓

Chat Participant

↓

Execution Engine

↓

WorkspaceEdit
```

The entire workflow remains inside the extension.

This provides

- complete control
- deterministic execution
- resumable workflows
- enterprise customization
- future extensibility

---

# Workflow IR

```
{
    "version": "2.0",
    "objective": "",
    "summary": "",
    "steps": []
}
```

---

# Workflow Step

```
{
    "id": "",
    "title": "",
    "executor": "",
    "dependsOn": [],
    "completionCondition": {},
    "script": []
}
```

Notice

There is NO natural language implementation.

There is NO additional planning.

The script contains executable instructions.

---

# Executors

Supported executors

```
workspace
user
terminal
validation
```

Future executors

```
git

github

jira

docker

browser

terraform

kubernetes

mcp
```

---

# Completion Conditions

Automatic

```
{
    "type":"automatic"
}
```

User confirmation

```
{
    "type":"user_confirmation"
}
```

Command exit code

```
{
    "type":"command_exit_code",
    "expected":0
}
```

Tests pass

```
{
    "type":"tests_passed"
}
```

File modified

```
{
    "type":"file_modified",
    "path":"config.yaml"
}
```

---

# Edit Script

Instead of implementation text, the planner emits an executable edit script.

Example

```json
{
    "executor":"workspace",

    "script":[

        {
            "operation":"replace_function",

            "target":{

                "file":"services/user.go",

                "symbol":"UserService.CreateUser"
            },

            "replacement":"Complete replacement function"
        },

        {

            "operation":"insert_after",

            "target":{

                "file":"handlers/user.go",

                "symbol":"CreateUserHandler"
            },

            "code":"..."
        }
    ]
}
```

This script can be executed without another planning step.

---

# Workspace Operations

Initial supported operations

```
replace_function

replace_method

replace_block

replace_lines

insert_before

insert_after

replace_text

append

prepend

create_file

delete_file

rename_symbol

add_import

remove_import

move_file
```

Future operations

```
rename_file

extract_method

inline_method

move_symbol

change_signature

format_document
```

---

# Workspace Executor

Algorithm

```
Read Workflow Step

↓

Read Script

↓

For each Operation

↓

Resolve Symbol

↓

Compute Range

↓

Create WorkspaceEdit

↓

Apply WorkspaceEdit

↓

Format Document

↓

Save

↓

Next Operation

↓

Step Complete
```

The Workspace Executor never performs reasoning.

It only interprets the script.

---

# User Executor

Example

```json
{
    "executor":"user",

    "script":[

        {

            "operation":"manual",

            "instructions":[

                "Open config.yaml",

                "Configure OAuth Client ID",

                "Save file"
            ]
        }
    ],

    "completionCondition":{

        "type":"user_confirmation"
    }
}
```

Execution pauses until completion.

---

# Terminal Executor

Example

```json
{
    "executor":"terminal",

    "script":[

        {

            "operation":"run",

            "command":"go test ./..."
        }
    ]
}
```

---

# Validation Executor

Supported validations

```
build

tests

lint

diagnostics

custom
```

---

# Workflow Scheduler

Execution flow

```
Load Workflow

↓

Find Runnable Steps

↓

Execute

↓

Update State

↓

Pause if Required

↓

Continue

↓

Workflow Complete
```

---

# Workflow State

Persist state

```
workflow.json

workflow.state.json
```

Example

```json
{
    "currentStep":"step-5",

    "completed":[

        "step-1",

        "step-2",

        "step-3",

        "step-4"
    ]
}
```

This enables

- resume
- crash recovery
- long-running workflows

---

# Progress Streaming

The Chat Participant streams execution progress.

Example

```
✔ Planning Complete

✔ Updated UserService

✔ Updated Handler

⏳ Waiting for user

Configure OAuth credentials.

[ Continue ]

✔ OAuth configured

▶ Running tests

✔ Tests passed

🎉 Workflow Complete
```

---

# Extension Architecture

```
src/

    participant/

        codebaseParticipant.ts

    planner/

        planner.ts

        workflowCompiler.ts

    execution/

        executionEngine.ts

        workflowScheduler.ts

        workflowStateStore.ts

    executors/

        workspaceExecutor.ts

        terminalExecutor.ts

        userExecutor.ts

        validationExecutor.ts

    workspace/

        symbolResolver.ts

        workspaceEditBuilder.ts

        formatter.ts
```

---

# Execution Engine Interfaces

```typescript
interface WorkflowExecutor {

    supports(step: WorkflowStep): boolean;

    execute(
        step: WorkflowStep,
        context: WorkflowExecutionContext
    ): Promise<ExecutionResult>;
}
```

---

# WorkflowExecutionContext

```typescript
interface WorkflowExecutionContext {

    workflow: Workflow;

    workspace: WorkspaceContext;

    cancellationToken: vscode.CancellationToken;

    progressReporter: ProgressReporter;

    stateStore: WorkflowStateStore;
}
```

---

# Planner Output Requirements

The planner MUST output Workflow IR directly.

The planner SHOULD NOT output natural language plans.

The planner MUST

- preserve every implementation detail
- classify each step
- generate executable edit scripts
- identify manual steps
- identify terminal commands
- identify validation steps
- define dependencies
- define completion conditions

No formatter LLM should be required.

---

# Future Enhancements

- Parallel execution
- Rollback support
- Diff preview
- Git integration
- Multi-workspace support
- Remote execution
- Distributed executors
- Custom enterprise executors
- MCP-based executors

---

# Guiding Principles

1. Planning happens exactly once.
2. Workflow IR is the single source of truth.
3. Execution is deterministic.
4. Executors never perform architectural reasoning.
5. Chat Participant is an orchestrator, not an executor.
6. Workspace edits are generated from executable edit scripts.
7. Every step declares its executor.
8. Every step declares its completion condition.
9. Workflows are resumable.
10. New executors can be added without changing the planner.
11. The architecture should support enterprise-specific executors and workflows.