@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-multiplayer.ps1" -Internet
if errorlevel 1 pause
