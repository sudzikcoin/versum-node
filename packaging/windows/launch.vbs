' versum-node -- the Windows launcher (v0.4.0). Runs with no window (wscript.exe), from the Startup folder at
' every sign-in and from the installer once:
'   launch.vbs                       start the node hidden if it is not already answering on 127.0.0.1:3311
'   launch.vbs --open                ... and open the node page in the browser once it answers
'   launch.vbs --source "<path>"     the installer's own path: the pairing key and the hub live in its FILE NAME
'       versum-node-setup-llk_<32 chars>.exe                         key, hub = default (prod)
'       versum-node-setup-llk_<32>-hub-api.example.io~dev.exe        key + hub https://api.example.io/dev  (~ stands for /)
'       versum-node-setup-llk_<32>-hub-... (1).exe                   a browser's duplicate-download suffix is ignored
' The node reads VERSUM_NODE_KEY / VERSUM_HUB once, at its first start, and never needs them again.
' Pure ASCII on purpose (see the v0.3.0 story in docs/installers.md).
Option Explicit
Dim sh, fso, env, here, home, logFile, openPage, src, i, a, name, re, m, exe, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
home = here & "\home"
Set env = sh.Environment("PROCESS")
env("VERSUM_NODE_HOME") = home
env("VERSUM_APP_ROOT") = here

openPage = False: src = ""
For i = 0 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  If LCase(a) = "--open" Then openPage = True
  If LCase(a) = "--source" And i < WScript.Arguments.Count - 1 Then src = WScript.Arguments(i + 1)
Next

If Not fso.FolderExists(home) Then fso.CreateFolder home
If Not fso.FolderExists(home & "\state") Then fso.CreateFolder home & "\state"
logFile = home & "\state\launch.log"
Log "launch.vbs open=" & openPage & " source=" & src

If src <> "" Then
  name = fso.GetBaseName(src)
  Set re = New RegExp: re.Pattern = "\s*\(\d+\)$": name = re.Replace(name, "")
  Set re = New RegExp: re.Pattern = "llk_[0-9A-Za-z]{32}"
  Set m = re.Execute(name)
  If m.Count > 0 Then
    env("VERSUM_NODE_KEY") = m(0).Value
    Log "key found in the installer name"
    Set re = New RegExp: re.Pattern = "-hub-([A-Za-z0-9._~-]+)$"
    Set m = re.Execute(name)
    If m.Count > 0 Then
      env("VERSUM_HUB") = "https://" & Replace(m(0).SubMatches(0), "~", "/")
      Log "hub " & env("VERSUM_HUB")
    End If
  Else
    Log "no key in the installer name; the node page will ask for it"
  End If
End If

exe = here & "\versum-node.exe"
If Not fso.FileExists(exe) Then
  Log "versum-node.exe is missing at " & exe
  MsgBox "Versum node: versum-node.exe is missing at " & exe & vbCrLf & "Please reinstall from the site.", 48, "Versum node"
  WScript.Quit 2
End If

If Not PageUp() Then
  cmd = "cmd.exe /c """"" & exe & """ start >> """ & home & "\state\node.log"" 2>&1"""
  sh.Run cmd, 0, False
  Log "started the node"
Else
  Log "the node is already running"
End If

If openPage Then
  For i = 1 To 120
    If PageUp() Then Exit For
    WScript.Sleep 500
  Next
  If PageUp() Then
    sh.Run "http://127.0.0.1:3311/", 1, False
    Log "opened the page"
  Else
    Log "the node did not answer within 60 s; see " & home & "\state\node.log"
    MsgBox "Versum node did not start within a minute." & vbCrLf & "The log is at " & home & "\state\node.log" & vbCrLf & "Please send it to support.", 48, "Versum node"
    WScript.Quit 3
  End If
End If

Function PageUp()
  Dim x
  PageUp = False
  On Error Resume Next
  Set x = CreateObject("MSXML2.XMLHTTP")
  x.Open "GET", "http://127.0.0.1:3311/api/state", False
  x.Send
  If Err.Number = 0 Then If x.Status = 200 Then PageUp = True
  On Error GoTo 0
End Function

Sub Log(s)
  On Error Resume Next
  Dim f
  Set f = fso.OpenTextFile(logFile, 8, True)
  f.WriteLine Now & " " & s
  f.Close
  On Error GoTo 0
End Sub
