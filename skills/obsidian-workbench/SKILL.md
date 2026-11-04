---
name: obsidian-workbench
description: Use when creating, querying, listing, updating, or moving tasks/todos and modifying task status in Obsidian Workbench Kanban boards via the Obsidian CLI.
---

# Obsidian Workbench Task Operations

This skill enables agents and scripts to interact directly with **Obsidian Workbench Kanban boards** using the official Obsidian CLI (`obsidian`). It provides a complete lifecycle for tasks: creation, reading/listing, and status/column modification.

## Prerequisites

1. **Obsidian App**: Must be running.
2. **Obsidian CLI**: Enabled under `Settings → General → Command line interface`.
3. **Workbench Plugin**: Installed and enabled in Obsidian (requires Obsidian 1.12.2+ for CLI command registration).
4. **Binary on PATH**: Ensure `/opt/homebrew/bin/obsidian` or `obsidian` is on PATH.

---

## Command Reference

| Action | Command | Key Flags | Description |
| :--- | :--- | :--- | :--- |
| **Create Task** | `obsidian workbench:create-task` | `title` (req), `board`, `column`, `description`, `backend` | Creates a new task on the board with `source: agent`. |
| **List Tasks** | `obsidian workbench:list-tasks` | `board`, `column`, `format` | Lists tasks on a board (or specific column). Supports `plain` or `json`. |
| **Get Task** | `obsidian workbench:get-task` | `id` (req), `board`, `format` | Retrieves detailed information for a task by its ID. |
| **Update Task** | `obsidian workbench:update-task` | `id` (req), `column`/`status`, `title`, `description`, `backend`, `board` | Updates properties or moves the task across columns (status change). |
| **Move Task** | `obsidian workbench:move-task` | `id` (req), `column` (req), `board` | Moves a task to a target column (convenience alias for status transitions). |
| **Delete Task** | `obsidian workbench:delete-task` | `id` (req), `board` | Deletes a task from the board. |

---

## 1. Task Creation (`workbench:create-task`)

### Flags
- `title=<title>` (**required**): Title of the task card.
- `board=<board>` (optional): Board name (case-insensitive) or board ID. Defaults to the **active board**; falls back to the first board.
- `column=<column>` (optional): Target column name or ID. Defaults to `Inbox`, then `Backlog`, then the first column.
- `description=<text>` (optional): Markdown description (up to 20,000 characters).
- `backend=<backend>` (optional): Task-level agent execution backend (`pi`, `omp`, `opencode`).

### Examples

**Quick task in default board / Inbox:**
```bash
obsidian workbench:create-task title="Review quarterly roadmap"
```

**Detailed task in specific board and column:**
```bash
obsidian workbench:create-task \
  board="Agent Integration" \
  column="Backlog" \
  title="Fix database migration timeouts" \
  description="Reproduced under heavy load when applying schema patches." \
  backend="pi"
```

---

## 2. Task Reading & Listing

### List Tasks (`workbench:list-tasks`)
Retrieve all tasks or filter by a specific column.

**Human-readable list of active board:**
```bash
obsidian workbench:list-tasks
```

**Filter by column:**
```bash
obsidian workbench:list-tasks board="Agent Integration" column="Backlog"
```

**Structured JSON output (recommended for automated agent parsing):**
```bash
obsidian workbench:list-tasks format=json
```

### Get Single Task Details (`workbench:get-task`)

Locates the task across all boards automatically by ID.

```bash
# Human-readable summary
obsidian workbench:get-task id="t_1730635200000"

# JSON format
obsidian workbench:get-task id="t_1730635200000" format=json
```

---

## 3. Modifying Task Status & Properties

In Workbench Kanban, **task status is represented by its column** (e.g. `Backlog` → `In Progress` → `Done`).

### Move Task / Change Status (`workbench:move-task` or `workbench:update-task`)

**Move to 'In Progress':**
```bash
obsidian workbench:move-task id="t_1730635200000" column="In Progress"
```

**Mark as 'Done':**
```bash
obsidian workbench:move-task id="t_1730635200000" column="Done"
```

### Update Properties (`workbench:update-task`)
Update title, description, execution backend, and/or column simultaneously:

```bash
obsidian workbench:update-task \
  id="t_1730635200000" \
  title="Fix database migration timeouts (reproduced)" \
  column="In Progress" \
  backend="opencode"
```

---

## 4. Deleting a Task (`workbench:delete-task`)

```bash
obsidian workbench:delete-task id="t_1730635200000"
```

---

## Scripting Recipes

### Python Integration
```python
import json
import subprocess

def create_workbench_task(title: str, description: str = "", column: str = "Backlog") -> str:
    res = subprocess.run(
        ["obsidian", "workbench:create-task", f"title={title}", f"column={column}", f"description={description}"],
        capture_output=True,
        text=True,
        check=True,
    )
    return res.stdout.strip()

def list_workbench_tasks(board: str = "", column: str = "") -> list[dict]:
    cmd = ["obsidian", "workbench:list-tasks", "format=json"]
    if board: cmd.append(f"board={board}")
    if column: cmd.append(f"column={column}")
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(res.stdout)

def advance_task_status(task_id: str, new_status: str) -> None:
    subprocess.run(
        ["obsidian", "workbench:move-task", f"id={task_id}", f"column={new_status}"],
        check=True,
    )
```

---

## Troubleshooting

- **`No commands matching "workbench:..."`**:
  - Check that Obsidian is open and Workbench plugin is enabled.
  - Run `obsidian plugin:reload id=workbench` (or restart Obsidian) to register newly added handlers.
- **`Board not found` or `Column not found`**:
  - Run `obsidian workbench:list-tasks` without arguments to see available board names and column titles.
  - Names are case-insensitive.
- **`Task not found`**:
  - Ensure the task ID (e.g. `t_...`) is correct. If the task is on an inactive board, pass `board="Board Name"` explicitly or omit `board` to allow automatic global search.
