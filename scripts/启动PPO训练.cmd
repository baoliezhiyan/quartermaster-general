@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
python -m scripts.ppo_rounds %*
set "PPO_EXIT=%ERRORLEVEL%"
echo.
if not "%PPO_EXIT%"=="0" echo Training stopped. See the error above; completed updates can be resumed.
pause
exit /b %PPO_EXIT%
