@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0" || exit /b 1
set "qm_node=D:\LLMs\environments\qm-qwen35-baseline\runtime\node.exe"
if defined QM_QWEN_NODE set "qm_node=%QM_QWEN_NODE%"
if not exist "%qm_node%" (
    echo Qwen diagnostic Node runtime not found.
    exit /b 1
)
:menu
echo(
type "scripts\qwen-baseline\menu.txt" || exit /b 1
set "ERRORLEVEL="
"%SystemRoot%\System32\choice.exe" /C 12345670 /N /M "Select: "
set "qm_option=%errorlevel%"
if "%qm_option%"=="8" exit /b 0
if "%qm_option%"=="5" (
    if not exist "outputs\qwen-baseline\runs" (mkdir "outputs\qwen-baseline\runs" || exit /b 1)
    explorer "%CD%\outputs\qwen-baseline\runs"
    goto menu
)
set "qm_mode="
if "%qm_option%"=="1" set "qm_mode=preview"
if "%qm_option%"=="2" set "qm_mode=bench"
if "%qm_option%"=="3" set "qm_mode=fixtures"
if "%qm_option%"=="4" set "qm_mode=games"
if "%qm_option%"=="6" set "qm_mode=samples"
if "%qm_option%"=="7" set "qm_mode=stability"
if not defined qm_mode exit /b 1
"%qm_node%" scripts/qwen-baseline/run.mjs %qm_mode%
goto menu
