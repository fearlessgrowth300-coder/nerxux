import { spawn } from 'node:child_process'
import { redactSecrets } from './redact.js'

// OS-Level Isolation Sandbox using Linux Landlock / Namespaces via Bubblewrap (bwrap).
// - Filesystem isolation: read-only system binds, host Windows drive (/mnt/c) completely unmapped.
// - Network isolation: configurable profiles ('none' airgapped vs 'full' internet access).
// - Session persistence: /workspace maps to /tmp/nexus_sandbox/<sessionId> across runs.
// - Multi-language: Python, JavaScript, TypeScript, C++, Bash.
//
// The bash script below (which invokes `bwrap` directly) is the same on every
// platform. Only the process that runs it differs: on the Windows dev machine
// there's no native bwrap, so it's piped through WSL's Ubuntu; in production
// (Linux) bash + bwrap run directly on the host. Don't reintroduce a bare
// `spawn('wsl', ...)` here — it silently fails with ENOENT on every Linux
// deployment (bwrap must be installed there: `apt install bubblewrap`).
const IS_WINDOWS = process.platform === 'win32'

// Real project work (npm install, create-next-app, a build) routinely runs
// well past 30s; killing it there left half-scaffolded projects and made the
// agent think a step "failed".
// Installed as GIT_TEMPLATE_DIR's hooks/pre-commit — git copies template
// files into .git/ on EVERY `git init` and `git clone`, including ones run
// as part of the same tool call that then commits, so there's no timing gap
// for the after-the-fact scrub below to miss. Real secrets (the user's own
// Supabase/DB credentials, pasted to be used) belong in this workspace;
// this only stops them from being committed.
const PRE_COMMIT_HOOK = `#!/bin/sh
staged=$(git diff --cached --name-only | grep -E '(^|/)\\.env(\\..+)?$|\\.(pem|key|p12|pfx)$|(^|/)id_(rsa|ed25519|ecdsa)$')
if [ -n "$staged" ]; then
  echo "BLOCKED: refusing to commit secret-shaped file(s):" >&2
  echo "$staged" >&2
  echo "These belong in an ignored env file, not a commit. To force anyway: git commit --no-verify" >&2
  exit 1
fi
`
const PRE_COMMIT_HOOK_B64 = Buffer.from(PRE_COMMIT_HOOK, 'utf8').toString('base64')

const TIMEOUT_MS = 5 * 60 * 1000

export async function executeInSandbox({
  code = '',
  language = 'python',
  sessionId = 'default',
  profile = 'none', // 'none' (airgapped) or 'full' (outbound internet)
  stdin = '',
  projectPath = null, // Path to local project directory on host to bind-mount into /workspace/project
  workingDir = null,  // Directory inside sandbox to run in (/workspace or /workspace/project)
  gitToken = null,    // Optional GitHub token for authenticated git push/clone
  gitUser = 'Nexus AI',
  gitEmail = 'nexus@local.dev',
}) {
  const startTime = Date.now()
  const cleanSession = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
  const cleanLang = String(language || 'python').toLowerCase().trim()

  // Auto-detect network requirement if git clone/push or curl/wget is in bash code
  let effectiveProfile = profile
  if (effectiveProfile === 'none' && (code.includes('git clone') || code.includes('git push') || code.includes('curl ') || code.includes('wget '))) {
    effectiveProfile = 'full'
  }

  let fileName = 'script.sh'
  let runCommand = ''

  switch (cleanLang) {
    case 'python':
    case 'py':
      fileName = 'main.py'
      runCommand = 'python3 -u /nexus/main.py'
      break
    case 'javascript':
    case 'js':
      fileName = 'main.js'
      runCommand = 'node /nexus/main.js'
      break
    case 'typescript':
    case 'ts':
      fileName = 'main.ts'
      runCommand = 'tsx /nexus/main.ts'
      break
    case 'c++':
    case 'cpp':
    case 'c':
      fileName = 'main.cpp'
      runCommand = 'g++ -O2 -std=c++17 /nexus/main.cpp -o /tmp/main && /tmp/main'
      break
    case 'bash':
    case 'sh':
    default:
      fileName = 'script.sh'
      // A failing program piped to tail/tee must not look like a passing test.
      runCommand = 'bash -o pipefail /nexus/script.sh'
      break
  }

  // Convert host Windows path (e.g. C:\Users\... or C:/Users/...) to WSL (/mnt/c/Users/...)
  let wslProjectPath = ''
  let projectBindMount = ''
  // A model can put anything in a tool argument — true, {}, {path: "..."}, a
  // number. Any truthy non-string used to skip the mount below while still
  // sending --chdir /workspace/project, so bwrap died with "Can't chdir to
  // /workspace/project" before running a single command. And because the value
  // is remembered for the session, one bad argument broke every later command
  // too. Normalise first, and let the mount decide the working directory.
  const projectDir = typeof projectPath === 'string' ? projectPath.trim()
    : projectPath && typeof projectPath === 'object' && typeof projectPath.path === 'string' ? projectPath.path.trim()
    : ''
  if (projectDir) {
    const trimmed = projectDir
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
      const drive = trimmed[0].toLowerCase()
      const rest = trimmed.slice(2).replace(/\\/g, '/')
      wslProjectPath = `/mnt/${drive}${rest}`
    } else {
      wslProjectPath = trimmed.replace(/\\/g, '/')
    }
    projectBindMount = `--bind "${wslProjectPath}" /workspace/project`
    // Also expose the project at its REAL path. The user names the folder by
    // its host path ("work on /root/viewe-account"), the model repeats that
    // path, and inside the sandbox it did not exist — so a perfectly correct
    // instruction came back as "No such folder". Mounting it at both places
    // means an absolute host path works in shell commands too, not just in
    // the file tools. Skipped for system directories, which are already bound.
    if (/^\/(root|home|srv|opt|data|mnt|var\/www|workspace)\//.test(wslProjectPath + '/')) {
      projectBindMount += ` --bind "${wslProjectPath}" "${wslProjectPath}"`
    }
  }

  const b64Code = Buffer.from(code, 'utf-8').toString('base64')
  const netFlag = effectiveProfile === 'full' ? '' : '--unshare-net'
  // Keyed off the mount that actually happened, never off the raw argument.
  const targetDir = workingDir || (projectBindMount ? '/workspace/project' : '/workspace')

  // Git auth must travel as ENVIRONMENT into bwrap: the host's ~/.gitconfig
  // isn't mounted inside the sandbox, so a `git config --global` set out here
  // was invisible in there and every push died with "could not read
  // Username". GIT_CONFIG_* (git >= 2.31) injects the token rewrite directly.
  // GIT_TERMINAL_PROMPT=0 makes a missing credential fail fast instead of
  // hanging on a username prompt that nobody can answer.
  const gitConfigSetup = [
    'export GIT_TERMINAL_PROMPT=0',
    // Chromium lives under /usr (bind-mounted read-only into the sandbox);
    // without this Playwright looks in a home cache that does not exist in
    // here and reports the browser as not installed.
    'export PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright',
    ...(gitToken
      ? [
          // insteadOf is multi-valued, so the same key is set three times: an
          // existing clone may use ANY of GitHub's URL forms, and a repo with
          // an SSH remote (git@github.com:owner/repo) would otherwise ignore
          // the token entirely and fail on a key the sandbox does not have.
          'export GIT_CONFIG_COUNT=3',
          `export GIT_CONFIG_KEY_0="url.https://x-access-token:${gitToken}@github.com/.insteadOf"`,
          'export GIT_CONFIG_VALUE_0="https://github.com/"',
          `export GIT_CONFIG_KEY_1="url.https://x-access-token:${gitToken}@github.com/.insteadOf"`,
          'export GIT_CONFIG_VALUE_1="git@github.com:"',
          `export GIT_CONFIG_KEY_2="url.https://x-access-token:${gitToken}@github.com/.insteadOf"`,
          'export GIT_CONFIG_VALUE_2="ssh://git@github.com/"',
        ]
      : []),
  ].join('\n')

  // The harness used to keep its own files INSIDE the workspace: the command
  // being executed was written to /workspace/script.sh and the git hook
  // template to /workspace/.nexus-git-template. The model saw both as project
  // content — and since script.sh holds the current command, `cat script.sh`
  // echoed whatever it had just run, changing every call. It burned dozens of
  // tool calls investigating the harness instead of doing the work. Keep them
  // outside /workspace, mounted read-only at /nexus.
  const bashScript = `
set -e
SESSION_DIR="/tmp/nexus_sandbox/${cleanSession}"
WORK_DIR="$SESSION_DIR/work"
HARNESS_DIR="$SESSION_DIR/.harness"
mkdir -p "$WORK_DIR" "$HARNESS_DIR/hooks"
${wslProjectPath ? `mkdir -p "${wslProjectPath}"` : ''}

# Sessions that predate the split kept their files at the session root; move
# them into work/ so nobody loses what they were in the middle of.
for leftover in "$SESSION_DIR"/* "$SESSION_DIR"/.[!.]*; do
  [ -e "$leftover" ] || continue
  case "$leftover" in
    "$WORK_DIR"|"$HARNESS_DIR") continue ;;
  esac
  mv "$leftover" "$WORK_DIR"/ 2>/dev/null || true
done

cd "$HARNESS_DIR"
echo "${b64Code}" | base64 -d > "${fileName}"

export GIT_AUTHOR_NAME="${gitUser}"
export GIT_AUTHOR_EMAIL="${gitEmail}"
export GIT_COMMITTER_NAME="${gitUser}"
export GIT_COMMITTER_EMAIL="${gitEmail}"
export GIT_DISCOVERY_ACROSS_FILESYSTEM=1
${gitToken ? `export GITHUB_TOKEN="${gitToken}"` : ''}
${gitConfigSetup}

echo "${PRE_COMMIT_HOOK_B64}" | base64 -d > "$HARNESS_DIR/hooks/pre-commit"
chmod +x "$HARNESS_DIR/hooks/pre-commit"
export GIT_TEMPLATE_DIR=/nexus

set +e
bwrap \\
  --ro-bind /usr /usr \\
  --ro-bind /lib /lib \\
  --ro-bind /lib64 /lib64 \\
  --ro-bind /bin /bin \\
  --ro-bind /sbin /sbin \\
  --ro-bind-try /etc/alternatives /etc/alternatives \\
  --ro-bind-try /etc/resolv.conf /etc/resolv.conf \\
  --ro-bind-try /etc/ssl /etc/ssl \\
  --ro-bind-try /etc/ca-certificates /etc/ca-certificates \\
  --ro-bind-try /usr/share/ca-certificates /usr/share/ca-certificates \\
  --ro-bind-try /etc/gitconfig /etc/gitconfig \\
  --ro-bind-try /etc/ssh /etc/ssh \\
  --ro-bind-try /etc/passwd /etc/passwd \\
  --ro-bind-try /etc/group /etc/group \\
  --proc /proc \\
  --dev /dev \\
  --tmpfs /tmp \\
  --bind "$WORK_DIR" /workspace \
  --ro-bind "$HARNESS_DIR" /nexus \\
  ${projectBindMount} \\
  --chdir "${targetDir}" \\
  --unshare-pid \\
  --unshare-ipc \\
  --unshare-uts \\
  ${netFlag} \\
  --die-with-parent \\
  bash -c "${runCommand}"
BWRAP_EXIT=$?
set -e

# Defense in depth: auth is meant to travel only as GIT_CONFIG_* env (applied
# fresh on every call, so nothing needs to be written to disk to keep working)
# — but a model can still run e.g. "git remote set-url ...TOKEN@..." on its
# own, which git happily writes into .git/config. Scrub any such userinfo
# unconditionally, regardless of what the command did or how it exited.
find "$WORK_DIR" -path '*/.git/config' -exec \\
  sed -i -E 's#(https://)[^/@[:space:]]+@#\\1#g' {} + 2>/dev/null || true

# Same idea for the files themselves: real credentials belong in this
# workspace (the user pastes them to be used), but never in a git commit.
# write_file adds a .gitignore for env-shaped files as it writes them; this
# is the backstop for whatever gets staged anyway (a hand-written
# .gitignore, execute_command writing a file directly, an already-tracked
# file later turned into an env file). Unstage, never delete — the model's
# work stays on disk either way.
for gitdir in $(find "$WORK_DIR" -maxdepth 6 -name .git -type d 2>/dev/null); do
  repo="$(dirname "$gitdir")"
  staged=$(cd "$repo" && git diff --cached --name-only 2>/dev/null | grep -E '(^|/)\\.env(\\..+)?$|\\.(pem|key|p12|pfx)$|(^|/)id_(rsa|ed25519|ecdsa)$' || true)
  if [ -n "$staged" ]; then
    (cd "$repo" && echo "$staged" | xargs -r git reset -q HEAD --) 2>/dev/null || true
    echo "[safety] unstaged (never committed): $staged" | tr '\\n' ' '; echo
  fi
done

exit $BWRAP_EXIT
`

  // Tool output is stored in the conversation and rendered in the chat, so a
  // credential printed here is published, not just displayed. The live git
  // token is passed explicitly because it will not always match a pattern.
  // Postgres cannot store U+0000, and a command that prints a binary file puts
  // NULs in its output — which then failed the save of the whole reply.
  const clean = (text) => redactSecrets(text, gitToken ? [gitToken] : [])?.split('\u0000').join('')

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const proc = IS_WINDOWS
      ? spawn('wsl', ['bash', '-s'], { windowsHide: true })
      : spawn('bash', ['-s'], { windowsHide: true })

    proc.stdin.write(bashScript)
    proc.stdin.end()

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, TIMEOUT_MS)

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
      if (stdout.length > 500000) {
        stdout = stdout.slice(0, 500000) + '\n... [Output truncated]'
        proc.kill('SIGKILL')
      }
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
      if (stderr.length > 500000) {
        stderr = stderr.slice(0, 500000) + '\n... [Error truncated]'
        proc.kill('SIGKILL')
      }
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      const durationMs = Date.now() - startTime
      if (timedOut) {
        resolve({
          ok: false,
          stdout: clean(stdout),
          stderr: clean((stderr ? stderr + '\n' : '') + `Execution timed out after ${TIMEOUT_MS / 1000}s`),
          exitCode: 124,
          durationMs,
          isolation: 'OS-level (Landlock/Bubblewrap namespaces)',
          profile,
        })
      } else {
        resolve({
          ok: code === 0,
          stdout: clean(stdout),
          stderr: clean(stderr),
          exitCode: code ?? 1,
          durationMs,
          isolation: 'OS-level (Landlock/Bubblewrap namespaces)',
          profile,
        })
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      const hint = err.code === 'ENOENT'
        ? IS_WINDOWS
          ? ' Install WSL (wsl --install) for the sandbox to run.'
          : ' Install bubblewrap on this host: apt install bubblewrap (or apk/dnf equivalent).'
        : ''
      resolve({
        ok: false,
        stdout: clean(stdout),
        stderr: clean(err.message + hint),
        exitCode: 1,
        durationMs: Date.now() - startTime,
        isolation: 'OS-level (Landlock/Bubblewrap namespaces)',
        profile,
      })
    })
  })
}
