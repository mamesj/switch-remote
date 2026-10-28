import sys
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer

root = sys.argv[1]
auth = DummyAuthorizer()
auth.add_user("claude", "s3cret", root, perm="elradfmwMT")
h = FTPHandler
h.authorizer = auth
h.passive_ports = range(30000, 30100)
FTPServer(("127.0.0.1", 2121), h).serve_forever()
