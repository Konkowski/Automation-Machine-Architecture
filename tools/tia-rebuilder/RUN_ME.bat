@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo   AMA - TIA Portal project from the original blocks
echo ============================================================
echo.

:: Optional: RUN_ME.bat 20   to force a TIA Portal version
:: Optional second argument "nopause" for unattended runs
set "WANT=%~1"
set "NOPAUSE=%~2"

where dotnet >nul 2>nul
if errorlevel 1 (
    echo ERROR: 'dotnet' not found. Install the .NET SDK: https://dotnet.microsoft.com/download
    goto :fail
)

:: The blocks were exported by TIA Portal V__MINVER__: that version or a newer one is needed.
set "MINVER=__MINVER__"
set "SIEDIR="
set "VER="
for %%V in (22 21 20 19 18 17 16) do (
    if not defined SIEDIR if %%V GEQ %MINVER% if "%WANT%"=="" call :probe %%V
    if not defined SIEDIR if "%WANT%"=="%%V" call :probe %%V
)
if not defined SIEDIR (
    echo ERROR: TIA Portal V%MINVER% or newer, with the Openness option, was not found on this PC.
    goto :fail
)
echo [1/3] TIA Openness V%VER%: %SIEDIR%
set "SIEMENS_ENGINEERING_DIR=%SIEDIR%"

echo [2/3] Preparing the builder...
if exist "TiaRebuilder\bin" rmdir /s /q "TiaRebuilder\bin"
if exist "TiaRebuilder\obj" rmdir /s /q "TiaRebuilder\obj"
dotnet build "TiaRebuilder\TiaRebuilder.csproj" -c Release -v quiet -nologo "-p:SiemensEngineeringDir=%SIEDIR%"
if errorlevel 1 (
    echo ERROR: build failed. The .NET Framework 4.8 Developer Pack is required.
    goto :fail
)

echo [3/3] Starting TIA Portal and building the project. This takes several minutes.
echo       If TIA Portal asks whether to grant access to "TiaRebuilder", answer Yes.
echo.
"TiaRebuilder\bin\Release\net48\TiaRebuilder.exe" --package "%CD%" --out "%CD%\_TIA_Project"
set "RC=%ERRORLEVEL%"
echo.
echo Read BuildReport.txt: it lists what was created [OK], what to do by hand [MANUAL] and what failed [FAIL].
if not "%NOPAUSE%"=="nopause" (
    if exist BuildReport.txt start "" notepad BuildReport.txt
    pause
)
exit /b %RC%

:probe
set "B=C:\Program Files\Siemens\Automation\Portal V%1\PublicAPI\V%1"
if exist "%B%\net48\Siemens.Engineering.Base.dll" ( set "SIEDIR=%B%\net48" & set "VER=%1" & goto :eof )
if exist "%B%\Siemens.Engineering.dll" ( set "SIEDIR=%B%" & set "VER=%1" )
goto :eof

:fail
if not "%NOPAUSE%"=="nopause" pause
exit /b 1
