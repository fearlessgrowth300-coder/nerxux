@echo off
title Nexus AI - Runpod GPU Tunnel (Qwen 3.8 27B)
echo ========================================================
echo Connecting to Runpod GPU (rigdm6buq51pnu) ...
echo Forwarding remote Ollama to http://127.0.0.1:11435
echo ========================================================

ssh -p 40072 -N -L 11435:127.0.0.1:11434 -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -i "%USERPROFILE%\.ssh\id_ed25519" root@213.192.2.75
