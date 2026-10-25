; versum-node — Windows installer (Inno Setup 6). Built by .github/workflows/release.yml on a tag.
; What the .exe does: copies the node program under %LOCALAPPDATA%\versum-node (no administrator rights),
; then runs setup.ps1, which is the same install.ps1 the one-liner uses: WSL2 + Docker Desktop checks,
; the node inside Ubuntu (WSL), a scheduled task at logon, and the local page http://127.0.0.1:3311/.
; The pairing key travels in the installer's FILE NAME (versum-node-setup-llk_….exe) — see setup.ps1.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\dist\win\app"
#endif
#ifndef OutDir
  #define OutDir "..\..\dist"
#endif

[Setup]
AppId={{7C1C7B6E-2B9A-4E1D-9D5C-0A1B2C3D4E5F}
AppName=Versum node
AppVersion={#AppVersion}
AppPublisher=SuVerse
AppPublisherURL=https://versum.suverse.io
AppSupportURL=https://github.com/sudzikcoin/versum-node
DefaultDirName={localappdata}\versum-node
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=versum-node-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=Versum node
SetupLogging=yes

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}\app"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#SourceDir}\packaging\windows\setup.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Versum node\Versum node page"; Filename: "http://127.0.0.1:3311/"
Name: "{userprograms}\Versum node\Versum node setup (run again)"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\setup.ps1"""; WorkingDir: "{app}"

[Run]
; Not `postinstall`: the setup step is the installation. A PowerShell window shows the progress
; (WSL, Docker, the node) and closes itself; the browser opens on the node page at the end.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\setup.ps1"" -Source ""{srcexe}"""; WorkingDir: "{app}"; Flags: nowait

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\setup.ps1"" -Uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "VersumNodeUninstall"
