Option Explicit
Dim fso, shell, base, batchPath, logPath, command, arg, args, url, ready, attempt
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FileExists(base & "\node_modules\playwright\package.json") Then
  MsgBox "Primeiro abra 1_instalar_dependencias_e_Chromium.vbs.", vbInformation, "Organizador academico"
  WScript.Quit 1
End If
batchPath = base & "\scripts\windows\run.cmd"
logPath = base & "\organizador.log"
url = "http://127.0.0.1:8765/"
If ServerReady(url) Then
  shell.Run url, 1, False
  WScript.Quit 0
End If
args = ""
For Each arg In WScript.Arguments
  args = args & " " & Chr(34) & Replace(CStr(arg), Chr(34), Chr(34) & Chr(34)) & Chr(34)
Next
command = "cmd.exe /d /s /c " & Chr(34) & Chr(34) & batchPath & args & Chr(34) & " >> " & Chr(34) & logPath & Chr(34) & " 2>&1" & Chr(34)
shell.Environment("PROCESS")("ORGANIZER_NO_OPEN") = "1"
shell.Run command, 0, False
ready = False
For attempt = 1 To 24
  WScript.Sleep 500
  If ServerReady(url) Then
    ready = True
    Exit For
  End If
Next
If ready Then
  shell.Run url, 1, False
Else
  MsgBox "O organizador nao iniciou. Confira o arquivo organizador.log nesta pasta.", vbExclamation, "Organizador academico"
  shell.Run "notepad.exe " & Chr(34) & logPath & Chr(34), 1, False
End If
Function ServerReady(address)
  Dim request
  On Error Resume Next
  Set request = CreateObject("WinHttp.WinHttpRequest.5.1")
  request.SetTimeouts 400, 400, 400, 700
  request.Open "GET", address, False
  request.Send
  ServerReady = (Err.Number = 0 And request.Status = 200)
  Err.Clear
  On Error GoTo 0
End Function
