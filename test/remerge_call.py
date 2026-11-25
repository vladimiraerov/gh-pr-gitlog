# Sends one native-messaging request to the host and prints a summary of the reply.
# usage: python3 test/remerge_call.py native/remerge_host.py '{"owner":"o","repo":"r","pr":1,"sha":"abc1234"}'
# REMERGE_CONFIG overrides ~/.remerge/repos.json.
import json, os, struct, subprocess, sys

msg = json.dumps(json.loads(sys.argv[2])).encode()
env = {'PATH': '/usr/bin:/bin'}
if os.environ.get('REMERGE_CONFIG'):
    env['REMERGE_CONFIG'] = os.environ['REMERGE_CONFIG']
env['HOME'] = os.environ.get('HOME', '')
p = subprocess.run([sys.executable, sys.argv[1]], input=struct.pack('=I', len(msg)) + msg, capture_output=True, env=env)
(n,) = struct.unpack('=I', p.stdout[:4])
r = json.loads(p.stdout[4:4 + n])
if r.get('diff') is not None:
    d = r.pop('diff')
    r['diffBytes'] = len(d)
    r['files'] = [l.split(' b/', 1)[-1] for l in d.splitlines() if l.startswith('diff --git')]
print(json.dumps(r))
