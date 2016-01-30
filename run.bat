@echo off
cls

taskkill /F /IM node.exe > nul
rem node-debug -p 5859 server
rem set DEBUG=compression
node . localhost:8082
