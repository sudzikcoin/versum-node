@echo off
rem versum-node -- the window the .exe installer opens. It exists so that a failure can never be silent:
rem   - the first line of %LOCALAPPDATA%\versum-node\install.log is written here, before PowerShell starts;
rem   - PowerShell runs with -ExecutionPolicy Bypass (a user's policy cannot block the bundled script);
rem   - if PowerShell cannot even parse or start setup.ps1, its error stays on screen and in the log,
rem     a message box says where the log is, and the window waits for a key.
rem Arguments pass straight through to setup.ps1 (-Source "<installer path>", -DryRun, -Uninstall).
setlocal
set "VN_LOGDIR=%LOCALAPPDATA%\versum-node"
if "%LOCALAPPDATA%"=="" set "VN_LOGDIR=%USERPROFILE%\versum-node"
if not exist "%VN_LOGDIR%" mkdir "%VN_LOGDIR%" >nul 2>&1
set "VN_LOG=%VN_LOGDIR%\install.log"
echo [%date% %time%] setup.cmd start  args: %* >> "%VN_LOG%" 2>nul
echo [%date% %time%] setup.cmd dir: %~dp0 >> "%VN_LOG%" 2>nul
title Versum node - setup
echo Versum node setup. Log: %VN_LOG%
echo.
where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] powershell.exe not found >> "%VN_LOG%" 2>nul
  echo PowerShell was not found on this machine, so the node cannot be installed this way.
  echo Please send the log file above to support.
  pause
  exit /b 2
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
set "VN_RC=%ERRORLEVEL%"
echo [%date% %time%] setup.ps1 exit %VN_RC% >> "%VN_LOG%" 2>nul
if "%VN_RC%"=="0" exit /b 0
if "%VN_RC%"=="3" exit /b 3
rem Any other code means PowerShell itself failed (parse error, blocked script, missing file): setup.ps1
rem never got to show its own message. Put the parse result in the log and show one here.
echo.
echo Setup could not start (PowerShell exit code %VN_RC%). The error is shown above and kept in the log:
echo   %VN_LOG%
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('%~dp0setup.ps1',[ref]$t,[ref]$e);'parse setup.ps1: ' + $(if($e){($e|Out-String)}else{'ok'});'policy: ' + (Get-ExecutionPolicy -List|Out-String)" >> "%VN_LOG%" 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('Versum node setup could not start (PowerShell exit code %VN_RC%).' + [char]10 + [char]10 + 'The error is in the log:' + [char]10 + '%VN_LOG%' + [char]10 + [char]10 + 'Please send that file to support, with the output of  wsl --status  and  docker version.', 'Versum node setup', 'OK', 'Error')" >nul 2>&1
echo Press any key to close this window.
pause >nul
exit /b %VN_RC%
