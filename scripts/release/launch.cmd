@echo off
setlocal
cd /d "%~dp0"
title Quartermaster General - Local Game
if not exist "%~dp0runtime\node.exe" (
  echo Missing runtime. Extract the entire ZIP to a folder before starting.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0server.mjs" %*
if errorlevel 1 pause
