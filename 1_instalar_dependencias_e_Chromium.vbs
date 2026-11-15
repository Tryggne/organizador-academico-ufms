Option Explicit
Dim fso, shell, base, batchPath, logPath, command, result
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
batchPath = base & "\scripts\windows\install.cmd"
logPath = base & "\instalacao.log"
command = "cmd.exe /d /s /c " & Chr(34) & Chr(34) & batchPath & Chr(34) & " > " & Chr(34) & logPath & Chr(34) & " 2>&1" & Chr(34)
result = shell.Run(command, 0, True)
If result = 0 Then
  MsgBox "Dependencias e Chromium instalados. Agora abra 2_abrir_organizador.vbs.", vbInformation, "Organizador academico"
Else
  MsgBox "Nao foi possivel concluir a instalacao (codigo " & result & "). Instale o Node.js LTS e consulte instalacao.log.", vbExclamation, "Organizador academico"
  shell.Run "notepad.exe " & Chr(34) & logPath & Chr(34), 1, False
End If
