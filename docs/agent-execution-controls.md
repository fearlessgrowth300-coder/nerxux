# Agent execution controls

All Nexus coding providers use `executeAgentTool` and the same persistent controller.
Turbo selects model inference, independently of the project execution environment.

- `inspect_execution` shows the current machine, initial cwd, mounted project,
  changed files, recent evidence IDs, current checks, interrupted action and next step.
- A mounted project stays selected across turns and server restarts. An established
  project or a workspace with changes can only be changed through
  `set_execution_context`, with an explicit environment, path and reason. The tool
  probes the destination directory; it never moves files or starts a pod.
- Every observation and tool-log entry carries execution context and an evidence ID.
- `write_file` and `edit_file` validate Python, JavaScript, shell and JSON syntax
  before atomic replacement. Failed validation preserves the previous file.
  TypeScript, JSX and other formats explicitly remain unchecked until the project
  checker/build runs. This checks syntax, not program correctness.
- `transfer_file` copies a regular source file up to 256 KiB from the current Linux
  host project to a running pod. It checks source containment, remote byte count,
  SHA-256 and supported syntax, then returns a destination receipt. Secret files
  need dedicated provisioning. SSH uses stdin rather than command-line payloads,
  preserves pipeline errors and resolves the current pod endpoint.
- Two execution/edit/transfer failures pause further changes. Resume requires a
  fresh `read_file`, a diagnostic command and `diagnose_failure` citing their IDs,
  a cause and next check. Failed minimal reproductions count as diagnostic evidence.
- `verify_work` requires exit zero plus output assertions: `contains` for a specific
  expected result or `json_number` for a numeric field in the final JSON stdout
  line. For example, `{"type":"json_number","field":"items_processed","min":1}`
  fails when a script prints zero but exits successfully. Use real acceptance checks,
  not invented success text. Test, build and deployment checks have separate scopes.
- Further ordinary commands or edits invalidate prior checks conservatively.
  Replies include a server-generated verification record. Unchecked deployment
  stays explicitly unverified. `record_progress` saves the next step, not a claim
  of completion.

State is bounded JSON stored under `~/.local/state/nexus-agent` (override with
`NEXUS_AGENT_STATE_DIR`), outside the conversation sandbox and production git reset.
Files are keyed by a hash of user ID and conversation ID, written atomically with
mode 0600, and tool executions are serialized within each conversation. Recognized
credentials are redacted. An interrupted action is recorded before execution and
survives restart. Back up this directory with other VPS application state.

These are reliability controls, not a security boundary or proof of overall project
completion. Arbitrary shell commands can change files; diagnostic/verification
commands must be scoped honestly. External edits and another conversation's changes
are not automatically detected by the revision counter. Assertions prove only what
they actually measure. The controller does not certify a model's diagnosis, rewrite
every project's tests, or automatically resume unlimited work after a budget stop.

Validation: server tests include controller persistence/isolation, context switches,
diagnostic gates, zero-work assertions, atomic syntax rejection, verified transfer
recipes, and an opt-in real bubblewrap agent loop with a fake model. Enable that last
test on Linux with `NEXUS_SANDBOX_TESTS=1`; it does not call a model or run user projects.
