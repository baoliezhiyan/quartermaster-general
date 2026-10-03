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
if not exist "node_modules\.bin\tsc.cmd" (
  "%NODE_EXE%" "%PNPM_ENTRY%" install --frozen-lockfile
  if errorlevel 1 goto :failed
)
"%NODE_EXE%" "%PNPM_ENTRY%" build
if errorlevel 1 goto :failed

if not "%~1"=="" goto :arguments
echo Stage 2: A1S1 round 003; resource mode A; entropy 0.01.
echo 1 Verify the source model
echo 2 Generate 32 scripted games
echo 3 Adapt with scripted decisions only
echo 4 Prepare the flat and map models
echo 5 Train the flat group, then the map group
set /p "CHOICE=Select step (1-5): "
if "%CHOICE%"=="1" set "STAGE=verify"
if "%CHOICE%"=="2" set "STAGE=generate"
if "%CHOICE%"=="3" set "STAGE=adapt"
if "%CHOICE%"=="4" set "STAGE=prepare"
if "%CHOICE%"=="5" set "STAGE=train"
if not defined STAGE goto :failed
"%PYTHON_EXE%" -m scripts.ppo_stage2 %STAGE%
goto :done

:arguments
"%PYTHON_EXE%" -m scripts.ppo_stage2 %*
goto :done

:failed
echo Stage 2 did not start or finish. Check the error above.
exit /b 1

:done
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
