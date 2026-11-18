@echo off
setlocal
title HygroPoint - serveur de developpement
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js est introuvable. Installez Node 20.19 ou plus recent : https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installation des dependances...
  call npm install
  if errorlevel 1 (
    echo [ERREUR] L'installation a echoue.
    pause
    exit /b 1
  )
)

echo Demarrage de HygroPoint sur http://localhost:5173
start "" http://localhost:5173
call npm run dev
pause
