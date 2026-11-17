@echo off
setlocal
rem dsh-ctx launcher: pins the DSH bundled Node (v24, needs zstd), falls back to PATH node.
set "DSH_NODE=C:\Users\MyPC\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%DSH_NODE%" set "DSH_NODE=node"
"%DSH_NODE%" "C:\Users\MyPC\Documents\deepseek-harness\default-workspace\dsh-ctx-meter\bin\dsh-ctx.js" %*
