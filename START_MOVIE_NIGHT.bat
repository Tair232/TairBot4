\
@echo off
cd /d "%~dp0"
title Movie Night V9

echo ===================================================
echo   MOVIE NIGHT V9 - CLEAN REBUILD
echo ===================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js not found.
  pause
  exit /b 1
)

echo Node:
node --version
echo.

findstr /C:"PASTE_NEW_ROTATED_BOT_TOKEN_HERE" ".env" >nul
if not errorlevel 1 (
  echo ===================================================
  echo STOP: First open .env and insert NEW bot token.
  echo The old token shared in chat must be RESET.
  echo ===================================================
  echo.
  pause
  exit /b 1
)

findstr /C:"PASTE_CLIENT_SECRET_HERE" ".env" >nul
if not errorlevel 1 (
  echo ===================================================
  echo STOP: Open .env and insert Discord Client Secret.
  echo Do NOT send Client Secret to anyone.
  echo ===================================================
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing packages...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting bot/backend + Activity...
call npm run dev
pause
