@echo off
rem Double-click friendly wrapper for usn-probe.ps1.
rem It forwards any arguments, for example: usn-probe.cmd -Root "C:\Users\me"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0usn-probe.ps1" %*
