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
if not "%~1"=="" (
  "%PYTHON_EXE%" -m scripts.ppo_a1s2_train %*
  goto :done
)
echo A1S2 adapted PPO only. S2FLAT, A2 and B are not launched here.
echo 1 Verify model and progress (no training)
echo 2 Preview rounds (no training)
echo 3 Add training rounds (explicit launch)
echo 4 Resume unfinished plan
set /p "CHOICE=Select 1-4: "
if "%CHOICE%"=="1" (
  "%PYTHON_EXE%" -m scripts.ppo_a1s2_train verify
  goto :done
)
if "%CHOICE%"=="2" (
  set /p "ROUNDS=Rounds to preview: "
  goto :preview
)
if "%CHOICE%"=="3" (
  set /p "ROUNDS=Additional rounds: "
  goto :train
)
if "%CHOICE%"=="4" (
  "%PYTHON_EXE%" -m scripts.ppo_a1s2_train train --continue-plan
  goto :done
)
goto :failed
:preview
"%PYTHON_EXE%" -m scripts.ppo_a1s2_train train --rounds "%ROUNDS%" --dry-run
goto :done
:train
"%PYTHON_EXE%" -m scripts.ppo_a1s2_train train --rounds "%ROUNDS%"
goto :done
:failed
echo A1S2 did not start or finish. Check the error above.
exit /b 1
:done
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
