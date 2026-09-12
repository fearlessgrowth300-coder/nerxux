const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')

// Check a complete candidate before atomic replacement. Failed syntax never
// destroys the previous file. JSX/TS need the project's own build/check command.
export function fileMutationCommand(name, args, destination) {
  const payload = b64(JSON.stringify({ ...args, name, path: destination }))
  const py = `import os, sys, json, base64, tempfile, subprocess, hashlib, stat
a = json.loads(base64.b64decode(sys.argv[1]))
p = os.path.realpath(a['path'])
os.makedirs(os.path.dirname(p), exist_ok=True)
if a['name'] == 'edit_file':
    src = open(p, encoding='utf-8').read()
    old = a.get('old', '')
    n = src.count(old)
    if not old or n != 1:
        sys.exit('old text must appear exactly once; found %s. No changes made. Read the current section with read_file and use a unique exact snippet.' % n)
    data = src.replace(old, a.get('new', ''), 1).encode('utf-8')
else:
    data = base64.b64decode(a['base64'], validate=True) if 'base64' in a else a.get('content', '').encode('utf-8')
sha = hashlib.sha256(data).hexdigest()
if a.get('sha256') and a['sha256'] != sha: sys.exit('Transfer checksum mismatch; destination unchanged')
if 'bytes' in a and a['bytes'] != len(data): sys.exit('Transfer size mismatch; destination unchanged')
suffix = os.path.splitext(p)[1].lower()
fd, tmp = tempfile.mkstemp(prefix='.nexus-check-', suffix=suffix, dir=os.path.dirname(p))
try:
    with os.fdopen(fd, 'wb') as f: f.write(data)
    syntax = 'not checked; run the project build/checker'
    if suffix == '.py':
        compile(data, p, 'exec'); syntax = 'passed (Python compile)'
    elif suffix in ('.js', '.mjs', '.cjs'):
        subprocess.run(['node', '--check', tmp], check=True, capture_output=True); syntax = 'passed (node --check)'
    elif suffix in ('.sh', '.bash'):
        subprocess.run(['bash', '-n', tmp], check=True, capture_output=True); syntax = 'passed (bash -n)'
    elif suffix == '.json':
        json.loads(data); syntax = 'passed (JSON parse)'
    mode = stat.S_IMODE(os.stat(p).st_mode) if os.path.exists(p) else 0o644
    os.chmod(tmp, mode)
    os.replace(tmp, p)
    actual = open(p, 'rb').read()
    if hashlib.sha256(actual).hexdigest() != sha or len(actual) != len(data): sys.exit('Post-write checksum mismatch')
    print(('edited ' if a['name'] == 'edit_file' else 'wrote ') + p)
    print(json.dumps({'path': p, 'bytes': len(actual), 'sha256': sha, 'syntax': syntax}))
except subprocess.CalledProcessError as e:
    sys.stderr.write(e.stderr.decode(errors='replace')); sys.exit('Syntax check failed; original file unchanged')
finally:
    if os.path.exists(tmp): os.unlink(tmp)
`
  return `PY=""; for c in python3 python; do "$c" -c pass >/dev/null 2>&1 && PY="$c" && break; done; [ -n "$PY" ] || { echo 'python not available' >&2; exit 1; }; printf '%s' ${q(b64(py))} | base64 -d | "$PY" - ${q(payload)}`
}
