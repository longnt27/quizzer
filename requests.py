import urllib.request

class _Response:
    def __init__(self, resp):
        self._resp = resp
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, tb):
        self._resp.close()
    def raise_for_status(self):
        code = getattr(self._resp, "status", 200)
        if code >= 400:
            raise RuntimeError(f"HTTP {code}")
    def iter_content(self, chunk_size=1024*1024):
        while True:
            chunk = self._resp.read(chunk_size)
            if not chunk:
                break
            yield chunk

class Session:
    def __init__(self):
        self.headers = {}
    def get(self, url, timeout=120, allow_redirects=True, stream=True):
        req = urllib.request.Request(url, headers=self.headers)
        return _Response(urllib.request.urlopen(req, timeout=min(timeout, 15)))
