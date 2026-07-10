@echo off
REM ============================================================
REM  Headless self-test - seeds data, rings up a sample bill
REM  and writes a sample invoice PDF (no GUI / display needed).
REM  Useful to confirm the engine works on a server or in CI.
REM ============================================================
setlocal
cd /d "%~dp0"

call "%~dp0build.bat"
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

java -cp "bin;lib/*" grocery.Main --demo
endlocal
