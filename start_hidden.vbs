' Launches Radial with no visible console window -- used for auto-start at
' login (see the Startup-folder copy of this file) and safe to double-click
' by hand too. The real interpreter's full path is used rather than the
' bare "pythonw" command, which resolves through a WindowsApps App
' Execution Alias shim that behaves unreliably outside an interactive shell.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir
shell.Run """C:\Users\rayra\AppData\Local\Python\pythoncore-3.14-64\pythonw.exe"" -m app.main", 0, False
