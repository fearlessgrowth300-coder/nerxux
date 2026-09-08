import { executeInSandbox } from './sandbox.js'
import { runOnPod } from './pod.js'

// System instructions that inform models how to use their execution "hands"
export const AGENT_SYSTEM_PROMPT = `
You are Nexus AI with direct execution capabilities ("hands").
You have access to:
1. An isolated OS-level Linux sandbox (with Python, JS, TS, C++, Bash, Git, and persistent /workspace).
2. Direct terminal execution on the remote Runpod GPU pod (via SSH).

When the user asks you to write, test, run, clone, build, inspect, or execute code or terminal commands, DO NOT just describe what to do. ACTUALLY EXECUTE IT by calling a tool or outputting a tool call block.

Available Tools:
- run_code(language, code, profile, projectPath): Runs code in the isolated local sandbox.
- execute_command(command, target, profile, projectPath): Runs a shell/git command. target can be "sandbox" (default) or "pod".
- run_on_pod(command): Runs a shell command directly on the Runpod GPU pod.

Format:
If your runtime supports function calling, use the function calling schema.
Otherwise, you can output an execution block:
{"tool": "execute_command", "command": "git clone https://github.com/user/repo", "target": "sandbox"}
or
{"tool": "run_code", "language": "python", "code": "print('hello from sandbox')"}
or
run: git clone https://github.com/user/repo

Once executed, you will receive the actual output, exit code, and files, and you can inspect results and decide the next step.
`.trim()

// Ollama / OpenAI compatible tool definitions
export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_code',
      description: 'Execute code in the local OS-level isolated sandbox (supports python, javascript, typescript, c++, bash) with persistent /workspace.',
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: ['python', 'javascript', 'typescript', 'c++', 'bash'],
            description: 'Programming language to execute',
          },
          code: {
            type: 'string',
            description: 'The complete code snippet to execute',
          },
          profile: {
            type: 'string',
            enum: ['none', 'full'],
            description: 'Network profile: "none" for airgapped, "full" for internet access (required for network/packages)',
          },
          projectPath: {
            type: 'string',
            description: 'Optional path on host to bind-mount into /workspace/project',
          },
        },
        required: ['language', 'code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Execute a bash or git command (e.g. git clone, git add, git commit, git push, ls, npm install) in the sandbox or on the Runpod GPU pod.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command line to run',
          },
          target: {
            type: 'string',
            enum: ['sandbox', 'pod'],
            description: 'Where to execute: "sandbox" (local isolated environment) or "pod" (remote Runpod GPU pod)',
          },
          profile: {
            type: 'string',
            enum: ['none', 'full'],
            description: 'Network profile for sandbox: "none" or "full"',
          },
          projectPath: {
            type: 'string',
            description: 'Optional host project directory to mount into /workspace/project',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_on_pod',
      description: 'Execute a shell command directly on the remote Runpod GPU pod via SSH.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Command to run on the Runpod pod',
          },
        },
        required: ['command'],
      },
    },
  },
]

// Executes a single tool call against the local sandbox or Runpod pod
export async function executeAgentTool({ name, args = {}, sessionId = 'default', projectPath = null }) {
  const cleanSession = sessionId || 'default'
  const targetProj = args.projectPath || projectPath || null

  if (name === 'run_code') {
    return executeInSandbox({
      code: args.code || '',
      language: args.language || 'python',
      sessionId: cleanSession,
      profile: args.profile || 'none',
      projectPath: targetProj,
    })
  }

  if (name === 'run_on_pod' || (name === 'execute_command' && args.target === 'pod')) {
    return runOnPod(args.command || '')
  }

  if (name === 'execute_command') {
    // Default to sandbox bash execution
    return executeInSandbox({
      code: args.command || '',
      language: 'bash',
      sessionId: cleanSession,
      profile: args.profile || 'full',
      projectPath: targetProj,
    })
  }

  throw new Error(`Unknown agent tool: "${name}"`)
}

// Parses freeform model text for JSON tool calls or "run: <command>" patterns
export function extractToolCallsFromText(text) {
  if (!text || typeof text !== 'string') return []
  const calls = []

  // 1. Check for JSON blocks: {"tool": "...", ...}
  const jsonRegex = /\{[\s\r\n]*"tool"[\s\r\n]*:[\s\r\n]*"([^"]+)"[\s\S]*?\}/g
  let match
  while ((match = jsonRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0])
      if (parsed.tool) {
        if (parsed.tool === 'run_code') {
          calls.push({
            name: 'run_code',
            args: {
              language: parsed.language || 'python',
              code: parsed.code || '',
              profile: parsed.profile || 'none',
              projectPath: parsed.projectPath,
            },
          })
        } else if (parsed.tool === 'execute_command' || parsed.tool === 'run_on_pod') {
          calls.push({
            name: parsed.tool === 'run_on_pod' ? 'run_on_pod' : 'execute_command',
            args: {
              command: parsed.command || parsed.code || '',
              target: parsed.target || (parsed.tool === 'run_on_pod' ? 'pod' : 'sandbox'),
              profile: parsed.profile || 'full',
              projectPath: parsed.projectPath,
            },
          })
        }
      }
    } catch {}
  }

  if (calls.length > 0) return calls

  // 2. Check for "run: <command>" or "run_on_pod: <command>"
  const runLines = text.split('\n')
  for (const line of runLines) {
    const trimmed = line.trim()
    const podMatch = /^run_on_pod:\s*(.+)$/i.exec(trimmed)
    if (podMatch) {
      calls.push({
        name: 'run_on_pod',
        args: { command: podMatch[1].trim() },
      })
      continue
    }
    const runMatch = /^run:\s*(.+)$/i.exec(trimmed)
    if (runMatch) {
      calls.push({
        name: 'execute_command',
        args: { command: runMatch[1].trim(), target: 'sandbox', profile: 'full' },
      })
    }
  }

  return calls
}
