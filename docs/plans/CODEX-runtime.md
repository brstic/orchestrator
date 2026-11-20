# Codex runtime

Contributed as a pull request (merged 2026-11-20, with the hardening below). Model calls are excluded from automated tests: they use `tests/fixtures/fake-codex.mjs`.

- [x] Runner agent. Start the installed Codex App Server over stdio. Translate thread and turn events, reconnect to a saved thread, and authenticate office MCP.
- [x] Host agent. Detect the local binary and route the session, prompt, interrupt and transcript through the existing host protocol.
- [x] Team agent. Add runtime selection to hire and edit, display host support, and allow the team lead to hire Codex workers on eligible machines.
- [x] Main agent. Persist the provider thread ID, enforce task and tool scope, and wire shared and joined-user sessions into the existing lifecycle.
- [x] Main agent. Add deterministic coverage for provider selection, delivery, resumption, joined users, and a mixed-provider review.
- [ ] Verify a real turn on a shared host and a joined user's host when authorized to spend model usage.
- [x] Add workspace-scoped text-file listing, reading and writing.
- [x] At the merge: the runner stops a worker that starts a command, a web search, an image from the disk or a file change outside its scratch folder; the file tools fence off the office's own files; unit tests for the file tools and the runner's stop, and an end-to-end test that calls the file tools.
- [ ] Add shell and Git support with structured approvals and project policy enforcement.
- [ ] Add Codex model and effort selection and measured usage.
