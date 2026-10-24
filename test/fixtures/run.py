import json, os, sys, hashlib, socket
piece = json.load(open('/job/piece.json'))
data = open('/job/in/data.txt', 'rb').read()
print('PROGRESS 10 read input')
x = 0
for i in range(6_000_000): x += i * i          # burn a little cpu so cpu.stat has something to say
h = hashlib.sha256(data).hexdigest()
try:
    open('/etc/evil', 'w').write('x'); ro = False
except OSError:
    ro = True
open('/tmp/scratch', 'w').write('ok')
try:
    socket.create_connection(('1.1.1.1', 443), timeout=3); net = 'REACHED'
except OSError as e:
    net = 'blocked: %s' % type(e).__name__
os.makedirs('/job/out/sub', exist_ok=True)
json.dump({'args': piece['args'], 'input_bytes': len(data), 'sha256': h, 'env_threads': os.environ.get('THREADS'),
           'home': os.environ.get('HOME'), 'cwd': os.getcwd(), 'uid': os.getuid(), 'sees_host_env': 'VERSUM_NODE_HOME' in os.environ,
           'rootfs_readonly': ro, 'network': net, 'env_count': len(os.environ)}, open('/job/out/result.json', 'w'))
open('/job/out/sub/hello.txt', 'w').write('hello from piece %s\n' % piece['piece_id'])
sys.stderr.write('a stderr line\n')
print('PROGRESS 100 done')
