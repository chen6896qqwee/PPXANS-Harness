' 皮皮虾 PPXANS-Harness · 静默启动
' 作用: 把「启动皮皮虾.bat」藏到后台跑, 屏幕上不闪控制台窗口。
' 真正的启动逻辑全部在那只 .bat 里 (已单独验证), 这里只负责隐藏窗口 + 失败时提示。
' 停止服务: 双击「停止皮皮虾.bat」。
Option Explicit

Dim fso, sh, root, bat, code
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
bat = root & "\启动皮皮虾.bat"

If Not fso.FileExists(bat) Then
  MsgBox "找不到启动脚本:" & vbCrLf & bat, 16, "皮皮虾 PPXANS-Harness"
  WScript.Quit 1
End If

sh.CurrentDirectory = root

' 0 = 隐藏窗口, True = 等它跑完以便拿到退出码
' q 参数 = 静默模式, .bat 内不等待按键
On Error Resume Next
code = sh.Run("""" & bat & """ q", 0, True)
If Err.Number <> 0 Then code = -1
On Error GoTo 0

If code <> 0 Then
  MsgBox "皮皮虾启动失败, 退出码 " & code & "。" & vbCrLf & vbCrLf & _
         "常见原因: 未安装 Node 20+ / 端口被占用 / 依赖缺失。" & vbCrLf & _
         "排查方法: 双击「启动皮皮虾.bat」查看完整日志," & vbCrLf & _
         "或在项目目录执行  node bin\ppx-web.js", 16, "皮皮虾 PPXANS-Harness"
End If
