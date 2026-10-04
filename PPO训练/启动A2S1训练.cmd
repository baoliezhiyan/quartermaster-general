@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
set "PYTHON=python"
if exist "PPO训练\.runtime\python\Scripts\python.exe" set "PYTHON=PPO训练\.runtime\python\Scripts\python.exe"
"%PYTHON%" -m scripts.ppo_a2s1 interactive
if errorlevel 1 echo A2S1 stopped. Check the error and use the same launcher to continue the saved plan.
pause
