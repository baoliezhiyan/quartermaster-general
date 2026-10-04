@echo off
setlocal
chcp 65001 >nul
set "PPO_HOME=%~dp0"
for %%I in ("%PPO_HOME%..") do set "PROJECT_ROOT=%%~fI"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PPO_HOME%准备环境.ps1"
if errorlevel 1 goto :failed
set "PATH=%PPO_HOME%.runtime\node;%PATH%"
set "NODE_EXE=%PPO_HOME%.runtime\node\node.exe"
set "PNPM_ENTRY=%PPO_HOME%.runtime\pnpm\bin\pnpm.mjs"
set "PYTHON_EXE=%PPO_HOME%.runtime\python\Scripts\python.exe"
cd /d "%PROJECT_ROOT%"
if errorlevel 1 goto :failed
if not exist "node_modules\vite\package.json" (
  "%NODE_EXE%" "%PNPM_ENTRY%" install --frozen-lockfile
  if errorlevel 1 goto :failed
)
if not "%~1"=="" goto :arguments
"%PYTHON_EXE%" -m scripts.ppo_combo_rounds interactive
goto :done
:arguments
"%PYTHON_EXE%" -m scripts.ppo_combo_rounds %*
goto :done
:failed
echo A2S1C1 combo course did not start. Existing checkpoints were not changed.
set "RESULT=1"
goto :finish
:done
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo A2S1C1 stopped. Continue the saved plan with this launcher.
:finish
if "%~1"=="" pause
exit /b %RESULT%
