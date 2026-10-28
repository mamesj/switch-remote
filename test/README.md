# Tests

Runs the extension against a pretend Switch on this machine: a mock sys-botbase and homebrew
menu netloader (`mocks.js`) and a real FTP server over a fake SD card (`ftpserver.py`).

```
pip install pyftpdlib
bash test/run.sh
```

`run.sh` builds a fake SD card in a temporary folder, starts both servers, and calls every
tool through `client.js` (a minimal MCP client), printing each result.
