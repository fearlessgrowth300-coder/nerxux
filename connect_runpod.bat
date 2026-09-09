@echo off
REM Manual SSH tunnel to the RunPod pod's Ollama (local :11435 -> pod :11434).
REM The app does this itself when you click Turbo; this is only for poking at
REM the pod by hand. RunPod assigns a NEW public port every time a stopped pod
REM is started — check the pod's Connect tab and update HOST/PORT below.
set HOST=63.141.33.107
set PORT=22002
echo Connecting to RunPod pod wqdsdqehwz4jzb at %HOST%:%PORT% ...
ssh -p %PORT% -N -L 11435:127.0.0.1:11434 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -i "%USERPROFILE%\.ssh\id_ed25519" root@%HOST%
