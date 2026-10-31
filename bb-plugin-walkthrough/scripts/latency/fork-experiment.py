import json,subprocess,sys,time,re
import os
src=os.environ['SOURCE_THREAD']  # an idle scratch thread to fork; its model and reasoning level are what is measured
HERE=os.path.dirname(os.path.abspath(__file__))
variant=sys.argv[1]  # e.g. idle-medium@new  # idle|imm|imm-low|imm-medium|imm-fast|prompt
def sh(*a,inp=None):
    return subprocess.run(a,capture_output=True,text=True,input=inp).stdout
t0=time.time()
args=['bb','thread','fork',src,'--visibility','hidden','--title','uat4-ux exp '+variant,'--json']
if variant=='forkprompt': args+=['--prompt-file',HERE+'/prompt.txt']
out=json.loads(sh(*args)); tid=out.get('id') or out['thread']['id']
tf=time.time()-t0
prompt=open(HERE+'/prompt-%s.txt'%(variant.split('@')[1] if '@' in variant else '')).read() if '@' in variant else open(HERE+'/prompt.txt').read()
tell=['bb','thread','tell',tid,'--message-file','-','--mode','queue']
if '-' in variant and variant.split('-')[0] in('imm','idle'):
    v=variant.split('-',1)[1].split('@')[0]
    if v=='fast': tell+=['--service-tier','fast']
    else: tell+=['--reasoning-level',v]
if variant.startswith('idle'):
    while True:
        s=sh('bb','thread','show',tid)
        if 'Status: idle' in s: break
        time.sleep(0.5)
tready=time.time()-t0
if variant!='forkprompt': sh(*tell,inp=prompt)
ts=time.time()-t0
# wait for completion
while True:
    s=sh('bb','thread','show',tid)
    if 'Status: idle' in s and time.time()-t0>ts+2: break
    time.sleep(1)
t=sh('bb','thread','log',tid,'--json','--limit','100000'); ev=json.loads(t[t.index('['):])
base=None
for e in ev:
    if e['type']=='client/turn/requested' and e['data'].get('source') in ('tell','fork','spawn') and e['data'].get('input'): base=e['createdAt']
tst=None; rows=[]; first=None; firsttool=None; end=None; ttext=None
for e in ev:
    it=e['data'].get('item') or {}
    if e['type']=='turn/started' : tst=e['createdAt']
    if e['type']=='item/started' and it.get('type')=='agentMessage' and first is None and e['createdAt']>= (base or 0): first=e['createdAt']
    if e['type']=='item/started' and it.get('type') in('commandExecution','fileRead') and firsttool is None and e['createdAt']>=(base or 0): firsttool=e['createdAt']
    if e['type']=='turn/completed': end=e['createdAt']
print(variant,'fork=%.1f idleAt=%.1f told@%.1f'%(tf,tready,ts),'| from send: turnstart %.1f firstText %.1f firstTool %.1f end %.1f'%tuple(((x-base)/1000 if x else -1) for x in (tst,first,firsttool,end)))
tools=sum(1 for e in ev if e['type']=='item/started' and (e['data'].get('item') or {}).get('type') in('commandExecution','fileRead') and e['createdAt']>=(base or 0))
rounds=sum(1 for e in ev if e['type']=='item/started' and (e['data'].get('item') or {}).get('type')=='reasoning' and e['createdAt']>=(base or 0))
print('tools',tools,'reasoningBlocks',rounds)
print('thread',tid)
