@echo off
cls

rem taskkill /F /IM node.exe > nul
rem node-debug -p 5859 server
rem set DEBUG=compression
forever start -o out.log -e err.log . localhost:8082
