"""Extract per-revision workflows from local named commits, without ref fan-out."""
import gzip,hashlib,json,pathlib,subprocess,yaml
from actions_dataset import read_json,write_json
ROOT=pathlib.Path(__file__).resolve().parent
runs=read_json(ROOT/'actions-runs.json'); snapshots={}; rows=[]
for r in runs:
 sha=r['head_sha']; root=r['path']; seen=set(); todo=[root]; files={}
 while todo:
  path=todo.pop()
  if path in seen: continue
  seen.add(path)
  q=subprocess.run(['git','show',f'{sha}:{path}'],capture_output=True,text=True)
  if q.returncode:
   files[path]={'error':'revision/path missing locally; not fetched'}; continue
  content=q.stdout; digest=hashlib.sha256(content.encode()).hexdigest(); snapshots[digest]=content
  data=yaml.safe_load(content); jobs={}
  for key,j in data.get('jobs',{}).items():
   fields=['name','needs','if','uses','runs-on','strategy','timeout-minutes']
   jobs[key]={f:j[f] for f in fields if f in j}
   jobs[key]['steps']=[{'name':s.get('name'),'uses':s.get('uses'),'if':s.get('if')} for s in j.get('steps',[])]
   uses=j.get('uses','')
   if uses.startswith('./.github/workflows/'): todo.append(uses[2:])
  files[path]={'sha256':digest,'jobs':jobs,'trigger':data.get('on',data.get(True))}
 rows.append({'run':r['id'],'source_sha':sha,'event':r['event'],'files':files})
write_json(ROOT/'actions-dags.json',rows)
dest=ROOT/'actions-workflows';dest.mkdir(exist_ok=True)
for k,v in snapshots.items(): (dest/f'{k}.yml.gz').write_bytes(gzip.compress(v.encode(),mtime=0))
print('Runs',len(rows),'unique workflow files',len(snapshots),'missing',sum('error' in f for row in rows for f in row['files'].values()))
