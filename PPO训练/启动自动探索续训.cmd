@echo off
setlocal
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
set "ROOT=%~dp0.."
set "PYTHON=D:\Python\python.exe"
set "PERF=--background-performance"
if not exist "%PYTHON%" (
  echo Python not found at D:\Python\python.exe.
  pause
  exit /b 1
)
pushd "%ROOT%" || exit /b 1
if not exist "%~dp0.state\A2AUTO\initial.pt" (
  echo Creating explicit C4-derived, new-reward A2AUTO initializer...
  "%PYTHON%" -m scripts.ppo_auto_experiment initialize A2AUTO
  if errorlevel 1 goto failed
)
:menu
echo.
echo A2AUTO - automatic exploration, A resources, entropy 0.01, 40 games/update.
echo 1. Show identity and progress without training
echo 2. Run bounded interface tests only
echo 3. Create a new plan and train explicitly
echo 4. Resume the saved unfinished plan
echo 5. Add rounds after a plan is complete
echo 6. Exit
echo 7. Toggle optional process-local background performance
set "CHOICE="
set /p "CHOICE=Choose 1-7: "
if "%CHOICE%"=="1" (
  "%PYTHON%" -m scripts.ppo_auto_rounds show --experiment A2AUTO
  goto menu
)
if "%CHOICE%"=="2" (
  "%PYTHON%" -m unittest tests.test_ppo_auto_archive tests.test_ppo_auto_imitate
  if errorlevel 1 goto failed
  "%PYTHON%" -m scripts.ppo_auto_short
  if errorlevel 1 goto failed
  echo Bounded tests complete; no PPO training started.
  goto menu
)
if "%CHOICE%"=="3" goto newplan
if "%CHOICE%"=="4" goto resume
if "%CHOICE%"=="5" goto add
if "%CHOICE%"=="6" goto finish
if "%CHOICE%"=="7" goto toggle
echo Invalid selection.
goto menu
:newplan
set "N="
set /p "N=New rounds (10 updates and 400 games per round): "
set "PAIRS="
set /p "PAIRS=Exploration branch pairs per update (explicit budget, 0-100): "
"%PYTHON%" -m scripts.ppo_auto_rounds plan --experiment A2AUTO --rounds "%N%" --exploration-pairs-per-update "%PAIRS%" %PERF%
if errorlevel 1 goto failed
goto menu
:resume
"%PYTHON%" -m scripts.ppo_auto_rounds resume --experiment A2AUTO %PERF%
if errorlevel 1 goto failed
goto menu
:add
set "N="
set /p "N=Additional rounds after current complete plan: "
"%PYTHON%" -m scripts.ppo_auto_rounds add --experiment A2AUTO --rounds "%N%" %PERF%
if errorlevel 1 goto failed
goto menu
:toggle
if "%PERF%"=="" (
  set "PERF=--background-performance"
  echo Process-local performance option ON.
) else (
  set "PERF="
  echo Process-local performance option OFF.
)
goto menu
:failed
echo Training or validation stopped. Previous completed updates remain intact.
pause
:finish
popd
endlocal
