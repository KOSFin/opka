"""Capture one existing pilot run; never dispatch or repeat checks."""
import datetime,json,pathlib,subprocess,sys
from actions_dataset import write_json,read_json
ROOT=pathlib.Path(__file__).resolve().parent
RUN=int(sys.argv[1]) if len(sys.argv)>1 else 45075379341
REPO='KOSFin/opka'
def api(path):
    return json.loads(subprocess.check_output(['gh','api',f'repos/{REPO}/{path}'],timeout=60))
def seconds(start,end):
    return (datetime.datetime.fromisoformat(end.replace('Z','+00:00'))-datetime.datetime.fromisoformat(start.replace('Z','+00:00'))).total_seconds()
run=api(f'actions/runs/{RUN}')
write_json(ROOT/'pilot-run.json',run)
jobs=api(f'actions/runs/{RUN}/attempts/{run["run_attempt"]}/jobs?per_page=100')
assert jobs['total_count']==len(jobs['jobs'])<=100,'Refusing truncated job data'
write_json(ROOT/'pilot-jobs.json',jobs)
write_json(ROOT/'pilot-artifacts.json',api(f'actions/runs/{RUN}/artifacts?per_page=100'))
summary={'runId':RUN,'attempt':run['run_attempt'],'sha':run['head_sha'],'workflow':run['path'],'event':run['event'],'status':run['status'],'conclusion':run['conclusion'],'url':run['html_url'],'createdAt':run['created_at'],'jobCount':len(jobs['jobs'])}
if run['status']=='completed':
    active=[j for j in jobs['jobs'] if j['conclusion']!='skipped' and j['started_at'] and j['completed_at']]
    summary['runnerBusyMinutes']=sum(seconds(j['started_at'],j['completed_at']) for j in active)/60
    summary['diagnosticRunnerMinutes']=sum(seconds(j['started_at'],j['completed_at']) for j in active if j['name'].startswith('Aggregate diagnostic'))/60
    summary['firstRunnerQueueSeconds']=min(seconds(run['created_at'],j['started_at']) for j in active)
    summary['jobQueueSumSeconds']=sum(max(0,seconds(j['created_at'],j['started_at'])) for j in active)
    gates=[j for j in active if j['name']=='PR checks passed']
    assert len(gates)==1,'Missing or ambiguous production aggregate'
    gate=gates[0]
    summary['verifyJobId']=gate['id']
    summary['verifyConclusion']=gate['conclusion']
    summary['verifyDurationSeconds']=seconds(gate['started_at'],gate['completed_at'])
    summary['aggregateElapsedSeconds']=seconds(run['created_at'],gate['completed_at'])
    summary['jobDurations']=[{'name':j['name'],'seconds':seconds(j['started_at'],j['completed_at']),'conclusion':j['conclusion']} for j in active]
    if gate['conclusion']=='success':
        destination=ROOT/'pilot-qualification';destination.mkdir(exist_ok=True)
        proof=destination/'qualification.json'
        if not proof.exists():
            subprocess.run(['gh','run','download',str(RUN),'--repo',REPO,'--name',f'opka-ci-proof-{RUN}-{run["run_attempt"]}','--dir',str(destination)],check=True,timeout=60)
        value=json.loads(proof.read_text())
        assert value['runId']==RUN and value['attempt']==run['run_attempt'] and value['event']==run['event']
        assert value['head']==run['head_sha'] and value['tree']==subprocess.check_output(['git','rev-parse',run['head_sha']+'^{tree}'],text=True).strip()
        summary['verifiedQualification']={'head':value['head'],'tree':value['tree'],'event':value['event'],'selectedLanes':[lane for lane in ['static','regression','desktop','electron','installers','android'] if value['scope'][lane]]}
        summary['pullRequestQualification']=run['event']=='pull_request'
write_json(ROOT/'pilot-summary.json',summary)
print(json.dumps(summary,indent=2))
