' 皮皮虾 PPXANS-Harness · 桌面静默启动
' 桌面快捷入口: 把项目里的「启动皮皮虾.bat」藏到后台跑, 不闪控制台窗口。
' 停止服务: 双击项目目录下的「停止皮皮虾.bat」。
Option Explicit

Dim fso, sh, root, bat, code
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

root = "C:\Users\chen\Desktop\智能体项目\PPXANS-Harness"
bat = root & "\启动皮皮虾.bat"

If Not fso.FileExists(bat) Then
  MsgBox "找不到启动脚本:" & vbCrLf & bat, 16, "皮皮虾 PPXANS-Harness"
  WScript.Quit 1
End If

sh.CurrentDirectory = root

On Error Resume Next
code = sh.Run("""" & bat & """ q", 0, True)
If Err.Number <> 0 Then code = -1
On Error GoTo 0

If code <> 0 Then
  MsgBox "皮皮虾启动失败, 退出码 " & code & "。" & vbCrLf & vbCrLf & _
         "请双击项目目录下的「启动皮皮虾.bat」查看完整日志。", 16, "皮皮虾 PPXANS-Harness"
End If
