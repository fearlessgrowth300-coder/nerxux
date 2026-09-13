// Fetch inside the sandbox, with DNS addresses validated and pinned for each
// redirect. No server credentials, cookies or browser session are forwarded.
export function webPageCode(url) {
  const encoded = Buffer.from(JSON.stringify(String(url || ''))).toString('base64')
  return `import base64, json, socket, ssl, ipaddress, http.client
from urllib.parse import urlsplit, urljoin
from html.parser import HTMLParser
url = json.loads(base64.b64decode('${encoded}'))
class Text(HTMLParser):
    def __init__(self):
        super().__init__(); self.hidden = 0; self.parts = []
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'noscript'): self.hidden += 1
    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'noscript'): self.hidden = max(0, self.hidden - 1)
    def handle_data(self, data):
        if not self.hidden and data.strip(): self.parts.append(data.strip())
for redirect in range(6):
    p = urlsplit(url)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password:
        raise ValueError('Use a public HTTP(S) URL without credentials')
    port = p.port or (443 if p.scheme == 'https' else 80)
    if port not in (80, 443): raise ValueError('Page reader permits public web ports 80 and 443 only')
    addresses = socket.getaddrinfo(p.hostname, port, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError('Page reader does not access private or local network addresses')
    family, kind, proto, _, address = addresses[0]
    def connect(*args, **kwargs):
        sock = socket.socket(family, kind, proto); sock.settimeout(15); sock.connect(address); return sock
    conn = http.client.HTTPSConnection(p.hostname, port, timeout=15, context=ssl.create_default_context()) if p.scheme == 'https' else http.client.HTTPConnection(p.hostname, port, timeout=15)
    conn._create_connection = connect
    try:
        conn.request('GET', (p.path or '/') + ('?' + p.query if p.query else ''), headers={'User-Agent':'Nexus-page-reader/1.0', 'Accept-Encoding':'identity'})
        response = conn.getresponse()
        if response.status in (301, 302, 303, 307, 308):
            location = response.getheader('Location')
            if not location: raise ValueError('Redirect lacks Location')
            url = urljoin(url, location); continue
        if response.status < 200 or response.status >= 300: raise ValueError('HTTP status ' + str(response.status))
        mime = response.getheader('Content-Type', '').lower()
        if not (mime.startswith('text/') or 'json' in mime or 'xml' in mime): raise ValueError('Unsupported document type: ' + mime)
        raw = response.read(1048577)
        truncated = len(raw) > 1048576
        body = raw[:1048576].decode('utf-8', errors='replace')
        if 'html' in mime:
            parser = Text(); parser.feed(body); body = '\\n'.join(parser.parts)
        print(json.dumps({'url':url, 'status':response.status, 'contentType':mime, 'truncated':truncated or len(body)>18000, 'text':body[:18000]}))
        break
    finally: conn.close()
else: raise ValueError('Too many redirects')
`
}
