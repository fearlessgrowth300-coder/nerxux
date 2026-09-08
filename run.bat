@echo off
title Nexus AI Launcher
echo ========================================================
echo Starting Nexus AI + Runpod GPU Integration
echo ========================================================

cd /d "%~dp0"

echo [1/3] Starting Backend Server on http://localhost:4000...
start "Nexus AI - Server" cmd /k "cd server && node index.js"

echo [2/3] Starting Frontend Client on http://localhost:5173...
start "Nexus AI - Client" cmd /k "cd client && npx vite"

echo [3/3] Starting Runpod GPU Tunnel (Qwen 3.8 27B)...
start "Nexus AI - Runpod GPU Tunnel" cmd /k "connect_runpod.bat"

echo.
echo Waiting for servers to initialize...
timeout /t 3 /nobreak >nul

echo Opening browser at http://localhost:5173...
start http://localhost:5173

echo.
echo Nexus AI is running with your Runpod GPU!
echo Keep the terminal windows open while using the app.
