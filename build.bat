@echo off
REM ============================================================
REM  Build script - compiles all Java sources into the bin\ dir.
REM  Requires only a JDK (javac) on the PATH. No Maven/Gradle.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist bin mkdir bin

echo Compiling Java sources...
if exist sources.txt del sources.txt
REM Write each source path quoted and with forward slashes, because javac's
REM @argfile parser treats backslashes as escapes and splits on spaces.
for /r "src" %%f in (*.java) do (
    set "p=%%f"
    echo "!p:\=/!">>sources.txt
)

javac -cp "lib/*" -d bin @sources.txt
set ERR=%ERRORLEVEL%
del sources.txt

if %ERR% neq 0 (
    echo.
    echo *** BUILD FAILED ***
    exit /b %ERR%
)

echo Build OK. Compiled classes are in the bin\ folder.
endlocal
