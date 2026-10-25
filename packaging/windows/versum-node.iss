; versum-node — Windows installer (Inno Setup 6), v0.4.0: ONE CLICK, NOTHING ELSE.
; Built by .github/workflows/release.yml on a tag. What the .exe does:
;   copies versum-node.exe (a single Node.js binary), versum-sandbox.exe (the AppContainer helper) and the
;   embedded Python under %LOCALAPPDATA%\versum-node — per user, no administrator prompt, no WSL, no Docker,
;   no reboot; puts a Startup-folder shortcut (the node starts hidden at every sign-in); starts the node now
;   and opens http://127.0.0.1:3311/ already paired — the key travels in the installer's FILE NAME
;   (versum-node-setup-llk_….exe, read by launch.vbs). Settings → Apps → Uninstall removes everything.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\dist\win\stage"
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
DisableReadyPage=yes
DisableFinishedPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=versum-node-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=Versum node
SetupLogging=yes
CloseApplications=no

[Files]
Source: "{#SourceDir}\versum-node.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\versum-sandbox.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\launch.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\version.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\pylib-lock.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\pylib-gpu-lock.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\probe\*"; DestDir: "{app}\probe"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\python\*"; DestDir: "{app}\python"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userstartup}\Versum node"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch.vbs"""; WorkingDir: "{app}"; Comment: "Starts the Versum node hidden at sign-in"
Name: "{userprograms}\Versum node\Versum node page"; Filename: "http://127.0.0.1:3311/"
Name: "{userprograms}\Versum node\Start Versum node"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch.vbs"" --open"; WorkingDir: "{app}"
Name: "{userprograms}\Versum node\Versum node log"; Filename: "notepad.exe"; Parameters: """{app}\home\state\node.log"""
Name: "{userprograms}\Versum node\Uninstall Versum node"; Filename: "{uninstallexe}"

[Run]
; the installer's own path is passed so the key and hub can be read from the file name; the node starts hidden
; and the browser opens the page once it answers (launch.vbs waits up to a minute and says so if it does not)
Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch.vbs"" --open --source ""{srcexe}"""; WorkingDir: "{app}"; Flags: nowait

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM versum-node.exe"; Flags: runhidden waituntilterminated; RunOnceId: "VersumNodeStop"
Filename: "{app}\versum-sandbox.exe"; Parameters: "cleanup --list ""{app}\home\state\appcontainers.txt"""; Flags: runhidden waituntilterminated; RunOnceId: "VersumNodeProfiles"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
// an older node may be running (an upgrade): stop it before the files are replaced
function PrepareToInstall(var NeedsRestart: Boolean): String;
var rc: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM versum-node.exe', '', SW_HIDE, ewWaitUntilTerminated, rc);
  Result := '';
end;
