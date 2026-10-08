@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHON_EXE=D:\Python\python.exe"
set "NODE_DIR=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
if not exist "%PYTHON_EXE%" (
  echo Python missing: %PYTHON_EXE%
  goto :failed
)
if not exist "%NODE_DIR%\node.exe" (
  echo Node missing: %NODE_DIR%\node.exe
  goto :failed
)
set "PATH=%NODE_DIR%;%PATH%"
cd /d "%~dp0.."
if errorlevel 1 goto :failed
if not exist "node_modules\vite\package.json" (
  echo Project dependencies missing in this training worktree.
  goto :failed
)
if not "%~1"=="" goto :arguments
"%PYTHON_EXE%" -m scripts.ppo_combo_c3_rounds interactive
goto :done
:arguments
"%PYTHON_EXE%" -m scripts.ppo_combo_c3_rounds %*
goto :done
:failed
set "RESULT=1"
goto :finish
:done
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo A2S1C3 stopped. Check the readable error above.
:finish
if "%~1"=="" pause
exit /b %RESULT%
