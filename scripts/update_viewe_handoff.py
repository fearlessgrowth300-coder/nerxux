"""Prepend a non-secret, factual Nexus handoff to the Viewe project notes."""
import hashlib
from datetime import datetime, timezone

import paramiko
from _deploy_env import require


NOTES = '/root/viewe-account/NEXUS.md'
MARKER = '## Nexus handoff — 2026-09-23'
HANDOFF = """## Nexus handoff — 2026-09-23

- The September 20 chat showed an intermediate result, not completion of the
  assignment. The recorded acceptance run had 0/1 completed and two failed
  verification checks. Do not repeat a claim of full success from that chat.
- The project changed after that run. Old commands and output are historical;
  compare them with the current files and rerun the relevant checks.
- Before further changes, obtain the teacher's exact permitted pass criteria,
  save them as separate acceptance criteria in Nexus, and verify each against
  observed results. Keep the next action and evidence ID in the work checkpoint.
- A running job, a generated account count, or a green build is not by itself
  evidence that the entire assignment was completed. Report partial results
  and blockers plainly.

"""


def main():
    env = require('HOSTINGER_HOST', 'HOSTINGER_USER', 'HOSTINGER_SSH_KEY_PATH')
    ssh = paramiko.SSHClient()
    ssh.load_system_host_keys()
    ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
    ssh.connect(env['HOSTINGER_HOST'], username=env['HOSTINGER_USER'], key_filename=env['HOSTINGER_SSH_KEY_PATH'])
    try:
        sftp = ssh.open_sftp()
        try:
            with sftp.file(NOTES, 'rb') as file:
                original = file.read()
            if MARKER.encode() in original:
                print('Viewe handoff already present; nothing changed.')
                return
            if len(original) > 256_000:
                raise RuntimeError('NEXUS.md is unexpectedly large; no change made.')
            with sftp.file(NOTES, 'rb') as file:
                if hashlib.sha256(file.read()).digest() != hashlib.sha256(original).digest():
                    raise RuntimeError('NEXUS.md changed during inspection; no change made.')
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            backup = f'{NOTES}.before-nexus-handoff-{stamp}'
            with sftp.file(backup, 'wb') as file:
                file.write(original)
            staged = f'{NOTES}.nexus-handoff-{stamp}.tmp'
            with sftp.file(staged, 'wb') as file:
                file.write(HANDOFF.encode() + original)
            sftp.posix_rename(staged, NOTES)
            print(f'Viewe handoff prepended; previous notes preserved at {backup}.')
        finally:
            sftp.close()
    finally:
        ssh.close()


if __name__ == '__main__':
    main()
