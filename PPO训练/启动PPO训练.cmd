@echo off
setlocal
chcp 65001 >nul
set "PPO_HOME=%~dp0"
set "RESULT_ROOT=%PPO_HOME%提交出牌实验"
for %%I in ("%PPO_HOME%..") do set "PROJECT_ROOT=%%~fI"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
echo Arguments: %*

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PPO_HOME%准备环境.ps1"
if errorlevel 1 goto :failed

set "PATH=%PPO_HOME%.runtime\node;%PATH%"
set "NODE_EXE=%PPO_HOME%.runtime\node\node.exe"
set "PNPM_ENTRY=%PPO_HOME%.runtime\pnpm\bin\pnpm.mjs"
set "PYTHON_EXE=%PPO_HOME%.runtime\python\Scripts\python.exe"
echo Project: %PROJECT_ROOT%
echo Node: %NODE_EXE%
cd /d "%PROJECT_ROOT%"

if not exist "node_modules\.bin\tsc.cmd" (
  echo Installing locked Node dependencies...
  "%NODE_EXE%" "%PNPM_ENTRY%" install --frozen-lockfile
  if errorlevel 1 goto :failed
)

echo Building matching game rules and replay validator...
"%NODE_EXE%" "%PNPM_ENTRY%" build
if errorlevel 1 goto :failed

"%PYTHON_EXE%" -m scripts.ppo_rounds --result-root "%RESULT_ROOT%" %*
set "PPO_EXIT=%ERRORLEVEL%"
goto :finish

:failed
set "PPO_EXIT=1"
echo Training did not start. Check the error above.

:finish
echo.
pause
exit /b %PPO_EXIT%
