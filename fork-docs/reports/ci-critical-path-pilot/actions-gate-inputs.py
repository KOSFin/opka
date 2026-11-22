"""Recover exact historical gate env from public job logs; save only gate JSON."""
import io,json,pathlib,re,subprocess,zipfile
from actions_dataset import read_json
ROOT=pathlib.Path(__file__).resolve().parent
runs={r['id']:r for r in read_json(ROOT/'actions-runs.json')}
for rid in [43628616296,43242425126]:
 jobs=read_json(ROOT/f'actions-jobs-{rid}-1.json')['jobs']
 job=next(j for j in jobs if j['name']=='PR checks passed')
 p=subprocess.run(['gh','api',f'repos/KOSFin/opka/actions/jobs/{job["id"]}/logs'],capture_output=True,text=True,check=True)
 plain='\n'.join(re.sub(r'^\d{4}-\S+Z ', '',line) for line in p.stdout.splitlines())
 decoder=json.JSONDecoder()
 needs=decoder.raw_decode(plain.split('OPKA_CI_RESULTS:',1)[1].lstrip())[0]
 scope=decoder.raw_decode(plain.split('OPKA_CI_SCOPE:',1)[1].lstrip())[0]
 result={'run':rid,'attempt':1,'url':runs[rid]['html_url'],'workflow':runs[rid]['path'],'run_head_sha':runs[rid]['head_sha'],'checked_merge_sha':scope['head'],'source':'Exact gate environment as emitted in public verify job log, not reconstructed results','gate_job_id':job['id'],'gate_conclusion':job['conclusion'],'scope':scope,'needs':needs}
 (ROOT/f'actions-gate-input-{rid}.json').write_text(json.dumps(result,indent=2)+'\n')
 print(rid,job['conclusion'],{k:v['result'] for k,v in needs.items()})
 # Artifacts whose retention remains valid; never download installer archives.
 listing=subprocess.run(['gh','api',f'repos/KOSFin/opka/actions/runs/{rid}/artifacts'],capture_output=True,text=True,check=True)
 arts=json.loads(listing.stdout)
 (ROOT/f'actions-artifact-index-{rid}.json').write_text(json.dumps({'run':rid,'artifacts':[{k:a[k] for k in ['id','name','size_in_bytes','expired','created_at','expires_at']} for a in arts['artifacts']]},indent=2)+'\n')
 for a in arts['artifacts']:
  if a['name']==f'opka-ci-proof-{rid}-1' and not a['expired']:
   assert a['size_in_bytes']<20000
   raw=subprocess.run(['gh','api',f'repos/KOSFin/opka/actions/artifacts/{a["id"]}/zip'],capture_output=True,check=True).stdout
   archive=zipfile.ZipFile(io.BytesIO(raw));proof=json.loads(archive.read('qualification.json'))
   (ROOT/f'actions-proof-{rid}.json').write_text(json.dumps(proof,indent=2)+'\n')
