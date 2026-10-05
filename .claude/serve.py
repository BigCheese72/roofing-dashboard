import functools
import http.server
import os
import pathlib

port = int(os.environ.get("PORT", 8766))
root = pathlib.Path(__file__).resolve().parent.parent
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
http.server.ThreadingHTTPServer(("0.0.0.0", port), handler).serve_forever()
