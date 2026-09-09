import paramiko
from _deploy_env import require

env = require(
    "HOSTINGER_HOST", "HOSTINGER_USER", "HOSTINGER_SSH_KEY_PATH",
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "VAULT_ENCRYPTION_KEY",
    "RUNPOD_API_KEY", "RUNPOD_POD_ID", "HOSTINGER_OLLAMA_URL", "CLIENT_ORIGINS",
)

ENV_CONTENT = f"""PORT=4000
CLIENT_ORIGINS={env['CLIENT_ORIGINS']}

SUPABASE_URL={env['SUPABASE_URL']}
SUPABASE_SERVICE_ROLE_KEY={env['SUPABASE_SERVICE_ROLE_KEY']}

VAULT_ENCRYPTION_KEY={env['VAULT_ENCRYPTION_KEY']}

RUNPOD_API_KEY={env['RUNPOD_API_KEY']}
RUNPOD_POD_ID={env['RUNPOD_POD_ID']}
HOSTINGER_OLLAMA_URL={env['HOSTINGER_OLLAMA_URL']}
"""

def run(ssh, cmd):
    print(f"\n[HOSTINGER] $ {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    print(out)
    if err:
        print("[STDERR]", err)
    return out

def main():
    print("Connecting to Hostinger via SSH key...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(env["HOSTINGER_HOST"], username=env["HOSTINGER_USER"], key_filename=env["HOSTINGER_SSH_KEY_PATH"])
    print("Connected!")

    # 1. Clone or pull repo
    run(ssh, "if [ -d /root/nerxux ]; then cd /root/nerxux && git pull; else git clone https://github.com/fearlessgrowth300-coder/nerxux.git /root/nerxux; fi")

    # 2. Write server/.env
    print("Writing server/.env...")
    sftp = ssh.open_sftp()
    with sftp.file("/root/nerxux/server/.env", "w") as f:
        f.write(ENV_CONTENT)
    sftp.close()

    # 3. Install dependencies
    print("Installing npm packages in server...")
    run(ssh, "cd /root/nerxux/server && npm install --omit=dev")

    # 4. Configure firewall for port 4000
    run(ssh, "ufw allow 4000/tcp 2>/dev/null || true; iptables -I INPUT -p tcp --dport 4000 -j ACCEPT 2>/dev/null || true")

    # 5. Start with PM2
    print("Starting Nexus server via PM2...")
    run(ssh, "pm2 delete nexus-server 2>/dev/null || true")
    run(ssh, "cd /root/nerxux/server && pm2 start index.js --name nexus-server")
    run(ssh, "pm2 save")

    # 6. Verify health check
    out = run(ssh, "curl -s http://127.0.0.1:4000/api/health")
    print("\nLocal server health check:", out)

    ssh.close()
    print("\nDeployment to Hostinger KVM 8 complete!")

if __name__ == "__main__":
    main()
