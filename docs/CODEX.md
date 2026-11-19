# Codex workers

Codex is a runtime for individual employees and team leads. Codex and Claude employees on the same team use the same conversations, task board, and review workflow.

## Set up a host

1. Install Codex on the machine running the Orchestrator host agent. Check that `codex --version` and `codex app-server --help` work as the account that runs the agent. If Codex lives outside that account's PATH, set `codexBin` to its absolute path in the host agent's configuration.
2. Sign in to Codex on that machine. The managed runtime can reuse a file-backed Codex login from the host account's `CODEX_HOME/auth.json` or `~/.codex/auth.json`. For a keyring-only login, sign in using a file-backed store with `codex -c 'cli_auth_credentials_store="file"' login`.
3. Restart the host agent and look for **Codex-managed workers** under **Machines**. In **Team → Hire**, choose that machine and select **Codex-managed** under **More options**. A joined colleague can do this for their own enrolled computer. Their employee uses the login on the machine selected for the hire. Any use of a shared machine uses that machine's login.
4. Talk to the employee in the office. Its workstation shows a transcript. Pause interrupts the active turn. Stop and Start resume the existing Codex thread when its history is available.

Team leads can request `executionMode: "codex_managed"` in `team_hire` on their eligible machines. An unavailable Codex runtime produces a start error. Installations with existing Claude employees keep their Claude runtime selections.

## First release scope

Codex can list, read and write text files in the selected folder or assigned task worktree through its workspace tools. Files are limited to 256 KiB and their parent directories must already exist. The tools reject hidden paths, likely credential names and linked paths. A project or employee deny rule for reading or editing disables the corresponding Codex tools. A lead’s edit restrictions apply.

The native Codex sandbox can write only to private scratch space. Shell, browser and permission elevation are disabled. Git commits and commands need a separate workflow. The office’s existing task verification rules still apply. Set `codexModel` and optionally `codexEffort` in the host agent’s `config.json` to choose a model and effort available to that host’s account.

The installed Codex CLI was checked through App Server startup without model calls. Automated checks use a fake App Server and validate turn acceptance, thread resumption, host isolation, and office tool authentication. See the [implementation plan](plans/CODEX-runtime.md).
