@echo off
setlocal
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
set "ROOT=%~dp0.."
set "PYTHON=D:\Python\python.exe"
set "PERF=--background-performance"
if not exist "%PYTHON%" (
  echo Python missing at D:\Python\python.exe
  pause
  exit /b 1
)
pushd "%ROOT%" || exit /b 1
:menu
echo.
echo A2AUTO2 potential-signal exploration. A resources, entropy 0.01.
echo 1. Show identity and completed progress only
echo 2. Explicitly migrate C4 model and legally replay the course pool
echo 3. Run bounded interface tests only
echo 4. Create a new plan; enter rounds and exploration pairs
echo 5. Resume an unfinished plan
echo 6. Add rounds after a completed plan
echo 7. Toggle process-local background performance
echo 8. Exit
set "CHOICE="
set /p "CHOICE=Choose 1-8: "
if "%CHOICE%"=="1" (
  "%PYTHON%" -m scripts.ppo_auto_rounds show --experiment A2AUTO2
  goto menu
)
if "%CHOICE%"=="2" (
  "%PYTHON%" -m scripts.ppo_auto_experiment initialize A2AUTO2
  if errorlevel 1 goto failed
  goto menu
)
if "%CHOICE%"=="3" (
  "%PYTHON%" -m unittest tests.test_ppo_auto_archive tests.test_ppo_auto_review tests.test_ppo_auto_imitate
  if errorlevel 1 goto failed
  "%PYTHON%" -m scripts.ppo_auto_short
  if errorlevel 1 goto failed
  goto menu
)
if "%CHOICE%"=="4" goto newplan
if "%CHOICE%"=="5" goto resume
if "%CHOICE%"=="6" goto add
if "%CHOICE%"=="7" goto toggle
if "%CHOICE%"=="8" goto finish
echo Invalid selection.
goto menu
:newplan
set "N="
set /p "N=New rounds (10 updates and 400 games per round): "
set "PAIRS="
set /p "PAIRS=Exploration pairs per update (explicit budget): "
"%PYTHON%" -m scripts.ppo_auto_rounds plan --experiment A2AUTO2 --rounds "%N%" --exploration-pairs-per-update "%PAIRS%" %PERF%
if errorlevel 1 goto failed
goto menu
:resume
"%PYTHON%" -m scripts.ppo_auto_rounds resume --experiment A2AUTO2 %PERF%
if errorlevel 1 goto failed
goto menu
:add
set "N="
set /p "N=Additional rounds: "
"%PYTHON%" -m scripts.ppo_auto_rounds add --experiment A2AUTO2 --rounds "%N%" %PERF%
if errorlevel 1 goto failed
goto menu
:toggle
if "%PERF%"=="" (
  set "PERF=--background-performance"
  echo Process-local performance ON.
) else (
  set "PERF="
  echo Process-local performance OFF.
)
goto menu
:failed
echo Validation or training stopped. Completed updates remain intact.
pause
:finish
popd
endlocal
