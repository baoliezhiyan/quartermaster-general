@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm not found. Install the Node.js and pnpm versions listed in README.md.
  set "PPO_EXIT=1"
  goto :finish
)
where python >nul 2>nul
if errorlevel 1 (
  echo Python not found. Install the project training environment.
  set "PPO_EXIT=1"
  goto :finish
)
echo Building the v1.7.6 client and matching replay validator...
call pnpm build
if errorlevel 1 (
  echo Build failed. Training was not started.
  set "PPO_EXIT=1"
  goto :finish
)
python -m scripts.ppo_rounds %*
set "PPO_EXIT=%ERRORLEVEL%"
:finish
echo.
if not "%PPO_EXIT%"=="0" echo Training stopped. See the error above; completed updates can be resumed.
pause
exit /b %PPO_EXIT%
