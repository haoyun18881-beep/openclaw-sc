#!/usr/bin/env python3
import json, urllib.request, re, time

sse = urllib.request.urlopen('http://127.0.0.1:18790/sse')
sse.readline()  # event: endpoint
data_line = sse.readline().decode()
session_id = re.search(r'sessionId=([^\s]+)', data_line).group(1)
print(f'Session: {session_id}')

msg_url = f'http://127.0.0.1:18790/messages?sessionId={session_id}'
req = urllib.request.Request(msg_url, data=json.dumps({
    'jsonrpc': '2.0', 'id': 'list-all', 'method': 'tools/list', 'params': {}
}).encode(), headers={'Content-Type': 'application/json'})
urllib.request.urlopen(req)

for _ in range(60):
    line = sse.readline().decode(errors='replace')
    if 'list-all' in line:
        data = json.loads(line[6:])
        tools = data['result']['tools']
        names = [t['name'] for t in tools]
        dupes = [n for n in names if names.count(n) > 1]
        print(f'Total: {len(tools)}, Unique: {len(set(names))}')
        if dupes:
            print(f'Duplicates ({len(set(dupes))}): {sorted(set(dupes))}')
        else:
            print('No duplicates!')
        print('First 5 tools:')
        for t in tools[:5]:
            js = json.dumps(t.get('inputSchema', {}))[:100]
            print(f'  {t["name"]}: {js}')
        break
    time.sleep(0.3)
sse.close()
