@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "qm_node=D:\LLMs\environments\qm-qwen35-baseline\runtime\node.exe"
if defined QM_QWEN_NODE set "qm_node=%QM_QWEN_NODE%"
if not exist "%qm_node%" (
    echo 找不到本任务的 Node 运行时。请查阅诊断说明。
    pause
    exit /b 1
)
:menu
echo.
echo Qwen3.5-2B 正式游戏基线诊断
echo 1. 只读预览与环境检查
echo 2. 模型加载和常驻短、中、长真实输入性能短测（最多9分钟）
echo 3. 运行30个固定局面
echo 4. 运行2局完整游戏冒烟
echo 5. 查看结果目录
echo 6. 导出三类完整提示词样例（无需模型）
echo 7. 常驻进程稳定性检查（两轮短、中、长、短）
echo 0. 退出
choice /C 12345670 /N /M "选择："
set "qm_option=%errorlevel%"
if "%qm_option%"=="8" exit /b
if "%qm_option%"=="255" exit /b 1
if "%qm_option%"=="0" exit /b 1
if "%qm_option%"=="1" "%qm_node%" scripts/qwen-baseline/run.mjs preview
if "%qm_option%"=="2" "%qm_node%" scripts/qwen-baseline/run.mjs bench
if "%qm_option%"=="3" "%qm_node%" scripts/qwen-baseline/run.mjs fixtures
if "%qm_option%"=="4" "%qm_node%" scripts/qwen-baseline/run.mjs games
if "%qm_option%"=="5" (
    if not exist "outputs\qwen-baseline\runs" mkdir "outputs\qwen-baseline\runs"
    explorer "%CD%\outputs\qwen-baseline\runs"
)
if "%qm_option%"=="6" "%qm_node%" scripts/qwen-baseline/run.mjs samples
if "%qm_option%"=="7" "%qm_node%" scripts/qwen-baseline/run.mjs stability
goto menu
