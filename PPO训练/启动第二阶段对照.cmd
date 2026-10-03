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
echo 第二阶段独立流程。源模型：A1S1 第003轮；资源A；熵0.01。
echo 1 核验源模型
echo 2 生成32局固定种子示范
echo 3 仅用脚本标签执行小规模行为克隆
echo 4 从共同起点准备平面/地图模型
echo 5 顺序训练平面组、地图组
set /p "CHOICE=选择步骤(1-5): "
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
echo 第二阶段未启动或未完成。请检查上面的错误；已有模型不会被覆盖。
exit /b 1

:done
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
