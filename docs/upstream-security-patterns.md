# Upstream security pattern review

Reviewed 2026-09-14:

- https://github.com/anthropics/claude-code-action/blob/main/base-action/src/run-claude-sdk.ts
  filters ordinary SDK log output to selected fields and suppresses other message
  types by default. Nexus now uses an independently written metadata-only error
  logger at its central request, process, startup and reply-rescue boundaries.
  It does not print SDK error objects, request bodies, headers or prompts there.
- https://github.com/anthropics/claude-code-action/blob/main/base-action/src/validate-env.ts
  validates configuration before dependent work. Nexus now validates the complete
  hexadecimal format of its vault key before encryption or decryption, without
  including the key in an error. It does not rotate existing keys.

These are independently implemented pattern adaptations. No upstream source code
was copied and no Claude SDK or other agent framework was installed. The upstream
action's MIT license does not license the bundled Claude runtime or other repos.

Additional credential protection covers project/admin OpenAI key formats, common
authorization header dumps and nested credential fields. Central API errors and
failed chat-job messages redact recognized credentials and known secret-shaped
environment values before returning bounded text. Redaction is not a guarantee
that every possible secret encoding or free-form sensitive text will be detected.
Other logging sites and successful provider response paths are outside this patch.

The existing Hostinger deployment script accepts `--code-only` for releases that
preserve the VPS `.env`. This avoids replacing its vault key or dropping newer
provider credentials from an older local configuration. The default provisioning
mode still writes configuration as before. A code-only release still restarts the
API process, so it interrupts any running chat jobs.

Regression tests exercise log-field exclusion, key/header redaction, poll responses,
vault key validation, encryption round trips and ciphertext tamper detection.

Repository integration status: OpenAI Agents JS/Python, Codex, Grok Build, Claude
Agent SDKs, plugin catalogs, ADK and infrastructure projects remain unintegrated.
Existing Nexus context fitting, persistent project state, syntax checks and
verification controls predate this patch. This patch does not change Qwen's
weights, agent execution permissions, completion logic or deployment tools.
