@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
python -m scripts.ppo_rounds %*
set "PPO_EXIT=%ERRORLEVEL%"
echo.
if not "%PPO_EXIT%"=="0" echo 训练未完成。请查看上方错误信息；已完成的更新可在下次启动时续训。
pause
exit /b %PPO_EXIT%
