"""Bounded public Actions metadata collector; no logs, artifacts or credentials."""
import datetime, json, pathlib, subprocess, time
from actions_dataset import has_json,read_json,write_json
ROOT=pathlib.Path(__file__).resolve().parent
REPO='repos/KOSFin/opka'
def api(endpoint):
    p=subprocess.Popen(['gh','api',f'{REPO}/{endpoint}'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    cg=pathlib.Path(f'/proc/{p.pid}/cgroup').read_text()
    (ROOT/'actions-cgroup.txt').write_text(f'Observed real gh child PID {p.pid}\n{cg}')
    out,err=p.communicate()
    if p.returncode: raise RuntimeError(err.decode())
    return json.loads(out)
def save(name,data):
    write_json(ROOT/name,data)
def slimrun(r):
    keys=['id','name','path','event','head_sha','head_branch','run_attempt','run_number','status','conclusion','created_at','updated_at','run_started_at','html_url','pull_requests','referenced_workflows']
    return {k:r.get(k) for k in keys}
runs=read_json(ROOT/'actions-run-list-page1.json')['workflow_runs']
for page in [2,3]:
    filename=ROOT/f'actions-run-list-page{page}.json'
    data=read_json(filename) if has_json(filename) else api(f'actions/runs?per_page=100&page={page}')
    save(filename.name,data)
    runs+=data['workflow_runs']
# Every PR/main/release in latest 100; no unqualified history or source enumeration.
selected=[r for r in runs[:100] if r['path'] in ['.github/workflows/pr.yml','.github/workflows/opka-release.yml']]
extra_ids={41209854471,40321585038,40317953946,40347442770,40353171792,39868258423}
selected += [r for r in runs[100:] if r['id'] in extra_ids]
save('actions-runs.json',[slimrun(r) for r in selected])
for i,r in enumerate(selected):
    for attempt in range(1,r['run_attempt']+1):
        dest=ROOT/f'actions-jobs-{r["id"]}-{attempt}.json'
        if has_json(dest): continue
        data=api(f'actions/runs/{r["id"]}/attempts/{attempt}/jobs?per_page=100')
        if data['total_count']>100: raise RuntimeError('Pagination required, refusing truncated jobs')
        # Runner identifiers are irrelevant; public timestamps/steps and labels suffice.
        keys=['id','name','head_sha','run_attempt','status','conclusion','created_at','started_at','completed_at','html_url','labels','steps']
        save(dest.name,{'total_count':data['total_count'],'jobs':[{k:j.get(k) for k in keys} for j in data['jobs']]})
    print(i+1,len(selected),r['id'],r['conclusion'],flush=True)
