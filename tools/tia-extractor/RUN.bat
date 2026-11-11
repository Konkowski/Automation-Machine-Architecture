@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

:: AMA - reads a TIA Portal project (read-only) and writes the export folder AMA imports.
:: Usage: RUN.bat "C:\path\project.ap20" "C:\path\output folder" [--ui]

set "AMA_PRJ=%~1"
set "AMA_OUT=%~2"
set "UIFLAG=%~3"
if "%AMA_PRJ%"=="" (
    echo Usage: RUN.bat "C:\path\project.apXX" "C:\path\output folder"
    exit /b 1
)
if not exist "%AMA_PRJ%" (
    echo ERROR: project not found: %AMA_PRJ%
    exit /b 1
)
if "%AMA_OUT%"=="" set "AMA_OUT=%~dpn1_AMA_export"

where dotnet >nul 2>nul
if errorlevel 1 (
    echo ERROR: 'dotnet' not found. Install the .NET SDK: https://dotnet.microsoft.com/download
    exit /b 1
)

:: The TIA version comes from the project file extension: .ap20 = V20
set "EXT=%~x1"
set "VER=%EXT:~3%"
set "BASE=C:\Program Files\Siemens\Automation\Portal V%VER%\PublicAPI\V%VER%"
set "SIEDIR="
if exist "%BASE%\net48\Siemens.Engineering.Base.dll" set "SIEDIR=%BASE%\net48"
if not defined SIEDIR if exist "%BASE%\Siemens.Engineering.dll" set "SIEDIR=%BASE%"
if not defined SIEDIR (
    echo ERROR: TIA Portal V%VER% with the Openness option was not found on this PC.
    echo        Looked in: %BASE%
    echo        The project must be opened with the same TIA version it was saved with.
    exit /b 1
)
echo TIA Openness V%VER%: %SIEDIR%
set "SIEMENS_ENGINEERING_DIR=%SIEDIR%"

echo Building the extractor...
if exist bin rmdir /s /q bin
if exist obj rmdir /s /q obj
dotnet build "TiaExtractor.csproj" -c Release -v quiet -nologo "-p:SiemensEngineeringDir=%SIEDIR%"
if errorlevel 1 (
    echo ERROR: build failed. The .NET Framework 4.8 Developer Pack is required.
    exit /b 1
)

"bin\Release\net48\TiaExtractor.exe" --project "%AMA_PRJ%" --out "%AMA_OUT%" %UIFLAG%
if errorlevel 1 (
    echo ERROR: the export failed. Check that your Windows user is in the group
    echo        "Siemens TIA Openness" and that the project is not open in TIA Portal.
    exit /b 1
)
echo Export folder: %AMA_OUT%
exit /b 0
