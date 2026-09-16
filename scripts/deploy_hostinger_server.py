import os
import sys
import subprocess
from pathlib import Path
import paramiko
from _deploy_env import require


def safe_print(text):
    sys.stdout.buffer.write(str(text).encode('utf-8', errors='replace'))
    sys.stdout.buffer.write(b'\n')
    sys.stdout.buffer.flush()

CODE_ONLY = '--code-only' in sys.argv
env = require('HOSTINGER_HOST', 'HOSTINGER_USER', 'HOSTINGER_SSH_KEY_PATH') if CODE_ONLY else require(
    "HOSTINGER_HOST", "HOSTINGER_USER", "HOSTINGER_SSH_KEY_PATH",
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "VAULT_ENCRYPTION_KEY",
    "RUNPOD_API_KEY", "RUNPOD_POD_ID", "HOSTINGER_OLLAMA_URL", "CLIENT_ORIGINS",
)
brave_key = os.environ.get('BRAVE_SEARCH_API_KEY', '')

ENV_CONTENT = None if CODE_ONLY else f"""PORT=4000
CLIENT_ORIGINS={env['CLIENT_ORIGINS']}

SUPABASE_URL={env['SUPABASE_URL']}
SUPABASE_SERVICE_ROLE_KEY={env['SUPABASE_SERVICE_ROLE_KEY']}

VAULT_ENCRYPTION_KEY={env['VAULT_ENCRYPTION_KEY']}

RUNPOD_API_KEY={env['RUNPOD_API_KEY']}
RUNPOD_POD_ID={env['RUNPOD_POD_ID']}
HOSTINGER_OLLAMA_URL={env['HOSTINGER_OLLAMA_URL']}
BRAVE_SEARCH_API_KEY={brave_key}
"""

def run(ssh, cmd, check=True):
    """Run a command on the server.

    `check` matters more than it looks: this used to ignore exit codes
    entirely, so a `git pull` that refused (a dirty tree on the server) was
    printed as a warning while the deploy carried on to restart PM2 on the OLD
    code and report success. Three deploys in a row silently did nothing.
    """
    safe_print(f"\n[HOSTINGER] $ {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    status = stdout.channel.recv_exit_status()
    safe_print(out)
    if err:
        safe_print("[STDERR] " + err)
    if check and status != 0:
        raise SystemExit(f"FAILED (exit {status}): {cmd}\n{err or out}")
    return out

def main():
    safe_print("Connecting to Hostinger via SSH key...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(env["HOSTINGER_HOST"], username=env["HOSTINGER_USER"], key_filename=env["HOSTINGER_SSH_KEY_PATH"])
    safe_print("Connected!")

    if CODE_ONLY:
        # A code release must not overwrite the live vault key or drop provider
        # credentials added since the local deployment configuration was saved.
        run(ssh, "test -s /root/nerxux/server/.env")

    # 1. Clone or pull repo
    # fetch + reset, not pull: the server is a deploy target, not a place to
    # edit. Anything left in its working tree (a file hand-copied while
    # debugging, say) must not be able to block a deploy.
    run(ssh, "if [ -d /root/nerxux ]; then cd /root/nerxux && git fetch origin main && git reset --hard origin/main; "
             "else git clone https://github.com/fearlessgrowth300-coder/nerxux.git /root/nerxux; fi")

    # Prove the code about to run is the code that was pushed.
    expected = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True,
                              cwd=str(Path(__file__).resolve().parent.parent)).stdout.strip()
    landed = run(ssh, "cd /root/nerxux && git rev-parse HEAD").strip()
    if expected and landed and expected != landed:
        raise SystemExit(f"Deployed {landed[:8]} but local HEAD is {expected[:8]} — push first, then redeploy.")
    safe_print(f"Deployed commit: {landed[:8]}")

    # 2. Write server/.env
    if CODE_ONLY:
        safe_print("Preserving existing server/.env (code-only release).")
    else:
        # Rewrite only the keys this script manages. It used to replace the
        # whole file, which silently wiped every setting added on the server
        # (ALWAYS_ON_API, the llama-server URL, HOSTINGER_API_TOKEN, ...).
        safe_print("Writing server/.env (managed keys; others preserved)...")
        sftp = ssh.open_sftp()
        managed = {line.split('=', 1)[0] for line in ENV_CONTENT.splitlines() if '=' in line}
        try:
            with sftp.file("/root/nerxux/server/.env", "r") as f:
                existing = f.read().decode('utf-8', errors='replace').splitlines()
        except IOError:
            existing = []
        kept = [line for line in existing
                if '=' in line and not line.lstrip().startswith('#')
                and line.split('=', 1)[0].strip() not in managed]
        # Settings made on the server win over the local copy for the Always On
        # target, which the server itself decides (Ollama :11434 or llama-server).
        server_url = next((l for l in existing if l.startswith('HOSTINGER_OLLAMA_URL=')), None)
        content = ENV_CONTENT
        if server_url:
            content = '\n'.join(server_url if l.startswith('HOSTINGER_OLLAMA_URL=') else l for l in content.splitlines()) + '\n'
        if kept:
            content += '\n# preserved from the server\n' + '\n'.join(kept) + '\n'
            safe_print(f"Preserved {len(kept)} server-only setting(s): " + ', '.join(l.split('=', 1)[0] for l in kept))
        with sftp.file("/root/nerxux/server/.env", "w") as f:
            f.write(content)
        sftp.close()

    # 3. Install dependencies
    safe_print("Installing npm packages in server...")
    run(ssh, "cd /root/nerxux/server && npm install --omit=dev")

    # 4. Configure firewall for port 4000
    run(ssh, "ufw allow 4000/tcp 2>/dev/null || true; iptables -I INPUT -p tcp --dport 4000 -j ACCEPT 2>/dev/null || true")

    # 5. Start with PM2
    safe_print("Starting Nexus server via PM2...")
    run(ssh, "pm2 delete nexus-server 2>/dev/null || true")
    run(ssh, "cd /root/nerxux/server && pm2 start index.js --name nexus-server")
    run(ssh, "pm2 save")

    # 6. Verify health check
    out = run(ssh, "curl -s http://127.0.0.1:4000/api/health")
    safe_print("\nLocal server health check: " + out)

    ssh.close()
    safe_print("\nDeployment to Hostinger KVM 8 complete!")

if __name__ == "__main__":
    main()
