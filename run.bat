@echo off
cls

taskkill /F /IM node.exe > nul
rem node-debug -p 5859 server
rem set DEBUG=compression
forever -w index.js localhost:8082
