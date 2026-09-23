"""Deploy only reviewed Nexus server source files, preserving the VPS worktree.

Unlike deploy_hostinger_server.py this does not reset Git or rewrite .env.
Run after committing and pushing the exact local source being deployed.
"""
import hashlib
import os
import posixpath
import subprocess
import sys
from pathlib import Path

import paramiko
from _deploy_env import require


ROOT = Path(__file__).resolve().parent.parent
REMOTE = '/root/nerxux'
FILES = (
    'server/adapters/ollama.js',
    'server/lib/agentCompletion.js',
    'server/lib/agentControl.js',
    'server/lib/agentLoop.js',
    'server/lib/agentState.js',
    'server/lib/agentTools.js',
    'server/routes/chat.js',
)


def run(ssh, command):
    _, stdout, stderr = ssh.exec_command(command)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    status = stdout.channel.recv_exit_status()
    if status:
        raise RuntimeError(f'Remote check failed ({status}): {command}\n{err[:500]}')
    return out.strip()


def main():
    env = require('HOSTINGER_HOST', 'HOSTINGER_USER', 'HOSTINGER_SSH_KEY_PATH')
    commit = subprocess.check_output(['git', 'rev-parse', '--short=12', 'HEAD'], cwd=ROOT, text=True).strip()
    changed = subprocess.check_output(['git', 'status', '--porcelain', '--', *FILES], cwd=ROOT, text=True).strip()
    if changed:
        raise SystemExit('Commit the server files before deploying; uncommitted source would not match the release.')
    ssh = paramiko.SSHClient()
    ssh.load_system_host_keys()
    ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
    ssh.connect(env['HOSTINGER_HOST'], username=env['HOSTINGER_USER'], key_filename=env['HOSTINGER_SSH_KEY_PATH'])
    try:
        targets = ' '.join(FILES)
        remote_dirty = run(ssh, f'cd {REMOTE} && git status --porcelain -- {targets}')
        if remote_dirty:
            raise SystemExit('The VPS has edits in a target server file. Nothing was deployed; inspect those edits first.')
        run(ssh, f'test -s {REMOTE}/server/.env && pm2 describe nexus-server >/dev/null')
        backup = f'{REMOTE}/.deploy-backups/{commit}'
        run(ssh, f'mkdir -p {backup}/server/adapters {backup}/server/lib {backup}/server/routes')
        sftp = ssh.open_sftp()
        installed = []
        try:
            for rel in FILES:
                local = ROOT / rel
                remote = posixpath.join(REMOTE, rel)
                old = posixpath.join(backup, rel)
                run(ssh, f'cp -- {remote} {old}')
                staged = f'{remote}.nexus-release-{commit}'
                sftp.put(str(local), staged)
                with sftp.file(staged, 'rb') as uploaded:
                    actual = hashlib.sha256(uploaded.read()).digest()
                expected = hashlib.sha256(local.read_bytes()).digest()
                if actual != expected:
                    raise RuntimeError(f'Upload hash mismatch: {rel}')
                sftp.posix_rename(staged, remote)
                installed.append(rel)
            run(ssh, 'pm2 restart nexus-server --update-env >/dev/null')
            health = run(ssh, 'curl -fsS --max-time 15 http://127.0.0.1:4000/api/health')
            print(f'Released {commit}: {len(installed)} server files; health={health[:250]}')
            print(f'Previous files preserved at {backup}')
        except Exception:
            for rel in installed:
                remote = posixpath.join(REMOTE, rel)
                old = posixpath.join(backup, rel)
                run(ssh, f'cp -- {old} {remote}')
            if installed:
                run(ssh, 'pm2 restart nexus-server --update-env >/dev/null')
            raise
        finally:
            sftp.close()
    finally:
        ssh.close()


if __name__ == '__main__':
    main()
