# Three-Agent Loop

This is the core workflow the bridge is built for.

## Goal

Start in one agent, continue in the second, continue in the third, then come back to the first without losing the thread.

## Example

Project folder:

```text
/Users/example/projects/demo-app
```

### 1. Start in Pi

Open Pi in the project and talk to it normally.

```bash
cd /Users/example/projects/demo-app
pi
```

### 2. Continue in Claude Code

Open Claude Code in the same folder and resume the imported conversation.

```bash
cd /Users/example/projects/demo-app
claude
```

### 3. Continue in Codex

Open Codex in the same folder and resume the same imported thread.

```bash
cd /Users/example/projects/demo-app
codex resume
```

### 4. Return to Pi

Open Pi again and resume the mirrored session.

```bash
cd /Users/example/projects/demo-app
pi --resume
```

## What To Check

- the session appears in the target tool for the same folder
- the latest messages are visible on the active branch
- the next turn succeeds without transcript-format errors
- the conversation can round-trip again

If not, run:

```bash
agent-session-bridge doctor
agent-session-bridge import --tool <target> --all
agent-session-bridge repair
```

Use `doctor` to confirm bridge setup, config, and hook health.
Use `import --all` to backfill missing foreign sessions into the target tool.
Use `repair` only if an already-imported Pi or Claude transcript needs cleanup afterward.
