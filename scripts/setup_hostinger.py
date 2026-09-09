import sys
import time
import paramiko
from _deploy_env import require

env = require(
    "HOSTINGER_HOST", "HOSTINGER_USER", "HOSTINGER_ROOT_PASSWORD", "HOSTINGER_AUTHORIZED_PUBKEY",
)

def safe_print(text):
    sys.stdout.buffer.write(text.encode('utf-8', errors='replace'))
    sys.stdout.buffer.flush()

def run_cmd(ssh, cmd):
    safe_print(f"\n[HOSTINGER] >>> {cmd}\n")
    stdin, stdout, stderr = ssh.exec_command(cmd, get_pty=True)
    for line in iter(stdout.readline, ""):
        safe_print(line)
    exit_status = stdout.channel.recv_exit_status()
    safe_print(f"\n[HOSTINGER] Exit code: {exit_status}\n")
    return exit_status

def main():
    safe_print(f"Connecting to Hostinger KVM 8 ({env['HOSTINGER_HOST']})...\n")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(env["HOSTINGER_HOST"], username=env["HOSTINGER_USER"], password=env["HOSTINGER_ROOT_PASSWORD"], timeout=15)
    safe_print("Connected successfully via SSH!\n")

    # 1. Authorize local public SSH key
    pubkey = env["HOSTINGER_AUTHORIZED_PUBKEY"]
    safe_print("Authorizing local SSH key...\n")
    run_cmd(ssh, f"""
mkdir -p /root/.ssh && chmod 700 /root/.ssh
grep -qF "{pubkey}" /root/.ssh/authorized_keys 2>/dev/null || echo "{pubkey}" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
""")

    # 2. Configure Ollama to listen on 0.0.0.0:11434 (all interfaces)
    safe_print("Configuring OLLAMA_HOST=0.0.0.0:11434 in systemd...\n")
    run_cmd(ssh, """
mkdir -p /etc/systemd/system/ollama.service.d
cat << 'EOF' > /etc/systemd/system/ollama.service.d/environment.conf
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
EOF
systemctl daemon-reload
systemctl restart ollama
ufw allow 11434/tcp 2>/dev/null || true
iptables -I INPUT -p tcp --dport 11434 -j ACCEPT 2>/dev/null || true
""")

    # 3. Check status and listen ports
    safe_print("Checking Ollama port...\n")
    time.sleep(2)
    run_cmd(ssh, "ss -tlpn | grep 11434")

    # 4. Pull the Qwen 3.8 27B model
    safe_print("Pulling Qwen 3.8 27B model on Hostinger KVM 8...\n")
    run_cmd(ssh, "ollama pull orcarouter/Qwen3.8-27B-Uncensored")
    run_cmd(ssh, "ollama cp orcarouter/Qwen3.8-27B-Uncensored qwen3.8-27b 2>/dev/null || true")
    run_cmd(ssh, "ollama cp orcarouter/Qwen3.8-27B-Uncensored nexus-mine 2>/dev/null || true")
    run_cmd(ssh, "ollama list")

    ssh.close()
    safe_print("\n[HOSTINGER SETUP COMPLETE]\n")

if __name__ == "__main__":
    main()
