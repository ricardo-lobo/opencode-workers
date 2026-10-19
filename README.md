# opencode-workers

A [Claude Code](https://claude.com/claude-code) plugin that lets Claude delegate well-scoped tasks to [opencode](https://opencode.ai) workers running a cheaper model, and follow their progress live in a side pane.

Claude keeps the planning and the review; the worker does the mechanical part. Each worker reports its activity, the files it changed with their diffs, its token usage and its cost, and can be sent follow-up instructions in the same session.

## Features

- **Background delegation.** Claude starts a worker with a self-contained brief and keeps working while it runs.
- **Live pane.** One card per worker with status, model, duration, steps, lines changed and cost; a detail view with the brief, activity log, per-file diffs and final answer.
- **Follow-ups.** A finished worker can be sent another instruction from Claude or from the pane, and keeps its context.
- **Guard rails.** Workers run under deny rules and are confined to the session's folder and its git worktrees (see [Security](#security)).
- **Session handoff.** Copy the `opencode -s` command to resume any worker's session in your own terminal.

## Requirements

- Claude Code with plugin support
- [opencode](https://opencode.ai) 2.x on your `PATH`
- A signed-in opencode provider for the model you use (default: `opencode-go/deepseek-v4.1-flash`)

## Installation

```
/plugin marketplace add ricardo-lobo/opencode-workers
/plugin install opencode-workers@lobo-mods
```

Restart Claude Code, or run `/reload-plugins`, to load it.

## Usage

Ask Claude to delegate something, for example *"delegate converting these five test files to Pest to opencode"*. Claude writes the brief, starts the worker, then collects and verifies the result.

The plugin adds four tools that Claude calls:

| Tool | Purpose |
| --- | --- |
| `delegate` | Start a worker. Takes `prompt` (required), and optionally `title`, `cwd`, `model` and `agent` (for example `plan` for a read-only worker). |
| `status` | Report on one worker in full, or list all of them. `wait_seconds` (up to 600) blocks until the worker finishes. |
| `follow_up` | Send another instruction to a finished worker's session. |
| `stop` | Stop a running worker. |

Run `/opencode` to open the pane. While the pane is closed, a band above the prompt shows how many workers are running or failed and reopens it.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `defaultModel` | `opencode-go/deepseek-v4.1-flash` | Model used when `delegate` names none, as `provider/model`. |
| `extraDeniedCommands` | *(empty)* | More shell command patterns workers may never run, comma-separated. See [Stack-specific rules](#stack-specific-rules). |

Set them from the `/plugin` menu, or with `claude plugin configure opencode-workers@lobo-mods`.

## Security

Workers run `opencode run --standalone --auto`, so opencode approves every action that is not explicitly denied. The plugin passes its own deny rules through `OPENCODE_CONFIG_CONTENT`, and these take precedence over your global and project opencode configuration. `--standalone` gives each run a private opencode server, since the shared background service would not receive them.

| Area | Rule |
| --- | --- |
| Files | No reading or editing `.env` files (`.env.example` is allowed); no access outside the worker's folder. |
| Code that runs later | No writing to `.git` (the folder, or the file a worktree has in its place), `.claude/`, `.opencode/`, `.husky/`, `.vscode/`, `.idea/`, `.github/workflows/`, `.gitmodules`, `opencode.json`, `.envrc`, `.pre-commit-config.yaml` or `lefthook.yml`, through file tools or the shell. |
| Agent instructions | No writing to `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.mcp.json` or `.claude.json`. |
| Git | No commit, push, reset, checkout, switch, restore, stash, rebase, merge, clean, branch deletion, tag, remote or config changes. |
| Hosting CLIs | No `gh` or `glab`. |
| System | No `rm`, `sudo`, `ssh`, `scp`, `rsync`, `kill`, `pkill` or `killall`. |
| Packages | No installs, updates, removals or publishing through `npm`, `pnpm`, `yarn`, `bun`, `composer`, `pip`, `uv`, `poetry`, `cargo`, `go`, `gem`, `bundle` or `brew`. |

The full list is `DENIED_COMMANDS` in [`hooks/register.tsx`](hooks/register.tsx). Patterns use `*` as a wildcard, and opencode checks each command of a `&&` chain separately.

An agent's own permissions take precedence over the top-level ones in opencode, so the rules are repeated on every built-in agent (`build`, `plan`, `general`, `explore`) and on the agent `delegate` names. A project's `opencode.json` cannot loosen them, and subagents a project defines are refused.

### Stack-specific rules

The defaults hold no framework commands. Add your stack's destructive ones, such as migrations and database resets, to `extraDeniedCommands`:

| Stack | Example value |
| --- | --- |
| Laravel | `*artisan migrate*, *artisan db:*` |
| Rails | `*rails db:*, *rake db:*` |
| Django | `*manage.py migrate*, *manage.py flush*` |
| Prisma | `*prisma migrate*, *prisma db push*` |

A worker may only run in the session folder or in one of its repository's git worktrees. Folders are compared by physical path, so a symlink cannot lead outside them.

### Limitations

The rules match command patterns. They are a guard rail, not a sandbox:

- a worker can still change any file in its folder;
- network tools such as `curl` are allowed;
- an unusual command (`find -delete`, `mv`) can get around a pattern;
- the `.env` rules cover reading and editing the file itself; search tools such as `grep` skip it only when it is in `.gitignore`.

Review a worker's diffs before keeping them. Setting `OPENCODE_CONFIG_CONTENT` yourself has no effect on workers, since the plugin replaces it.

### Data handling

A worker sends everything it reads to its model provider: with the default model, DeepSeek through opencode-go. Do not run workers on folders holding data you would not share with that provider.

## Development

```
claude plugin validate .
claude plugin test .
```

## License

[MIT](LICENSE)
