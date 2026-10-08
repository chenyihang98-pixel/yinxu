@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem Starts the portable build of the version named in package.json. If that
rem file is not there (or package.json cannot be read), the newest portable
rem build in release\ is started instead.
set "VER="
if exist package.json for /f "tokens=2 delims=:, " %%v in ('findstr /r /c:"^ *\"version\" *:" package.json') do if not defined VER set "VER=%%~v"

set "EXE="
if defined VER if exist "release\Muse-BGM-Portable-%VER%-x64.exe" set "EXE=release\Muse-BGM-Portable-%VER%-x64.exe"
if not defined EXE for /f "delims=" %%f in ('dir /b /a-d /o-d "release\Muse-BGM-Portable-*-x64.exe" 2^>nul') do if not defined EXE set "EXE=release\%%f"
if not defined EXE goto missing

rem MUSE_LAUNCHER_DRY_RUN=1 only prints which program would be started.
if defined MUSE_LAUNCHER_DRY_RUN goto dryrun
start "" "%EXE%"
exit /b 0

:dryrun
echo %EXE%
exit /b 0

:missing
echo.
echo 没有找到音序 Muse 的便携版程序。
if defined VER echo 需要的文件：release\Muse-BGM-Portable-%VER%-x64.exe
echo.
echo 可以这样得到它：
echo   1. 在这个文件夹里运行  npm run dist  ，几分钟后程序会生成到 release 文件夹；
echo   2. 或者不打包，直接从源码启动：  npm run desktop
echo.
echo The portable build was not found. Run "npm run dist" first, or start from source with "npm run desktop".
echo.
if not defined MUSE_LAUNCHER_DRY_RUN pause
exit /b 1
