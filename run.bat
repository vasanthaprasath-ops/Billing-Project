@echo off
REM ============================================================
REM  Run script - builds (if needed) then launches the
REM  Grocery Store Billing System desktop application.
REM ============================================================
setlocal
cd /d "%~dp0"

call "%~dp0build.bat"
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo Starting Grocery Store Billing System...
echo Open http://localhost:8080 in your browser if it does not open automatically.
java -cp "bin;lib/*" grocery.Main %*
endlocal
