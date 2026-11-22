"""Measured elapsed times, with parallel jobs counted once for wall time."""
import collections,datetime,json,math,pathlib,re
from actions_dataset import has_json,read_json,write_json
ROOT=pathlib.Path(__file__).resolve().parent
runs=read_json(ROOT/'actions-runs.json')
def stamp(v): return datetime.datetime.fromisoformat(v.replace('Z','+00:00')).timestamp() if v else None
def duration(a,b):
 return max(0,stamp(b)-stamp(a)) if a and b else None
def category(name):
 if re.search(r'cache|restore|verification record',name,re.I):return 'cache_explicit'
 if re.search(r'install-node-dependencies|install-mobile-dependencies|Setup|Set up|Checkout|checkout|Install|Prepare|Initialize',name,re.I):return 'setup_install_composite'
 if re.search(r'upload|download-artifact|evidence|Preserve|receipts|provenance|Save ',name,re.I):return 'artifacts_provenance'
 if re.search(r'Build|Compile|Package|bundle|Cross-build',name,re.I):return 'build'
 if re.search(r'Test|Check|Verify|Exercise|Qualify|Validate|Require|Reject|Resolve',name,re.I):return 'test_check'
 return 'other'
def percentile(xs,p):
 s=sorted(x for x in xs if x is not None)
 return s[max(0,math.ceil(p*len(s))-1)] if s else None
rows=[]; stages=[]
for r in runs:
 origin=stamp(r['created_at']); alljobs=[]; attempts=[]; seen_execution=set(); previous_completion=None
 for attempt in range(1,r['run_attempt']+1):
  path=ROOT/f'actions-jobs-{r["id"]}-{attempt}.json'
  if not has_json(path):continue
  jobs=read_json(path)['jobs']; alljobs+=jobs
  reported_active=[j for j in jobs if j['conclusion']!='skipped' and j['started_at'] and j['completed_at']]
  active=[]
  for j in reported_active:
   key=(j['name'],j['started_at'],j['completed_at'],j['conclusion'])
   if key not in seen_execution: active.append(j)
   seen_execution.add(key)
  elapsed=[duration(j['started_at'],j['completed_at']) for j in active]
  failed=[stamp(s['completed_at']) for j in active for s in j['steps'] if s['conclusion']=='failure' and s.get('completed_at')]
  failed += [stamp(j['completed_at']) for j in active if j['conclusion']=='failure' and j.get('completed_at')]
  verify=next((j for j in jobs if j['name']=='PR checks passed'),None)
  # Release publish completion is delivery-ready; deliberately separate from PR verify.
  publish=next((j for j in jobs if j['name']=='Publish the complete verified beta'),None)
  completion=max([stamp(j['completed_at']) for j in active],default=None)
  endjobs=[j for j in reported_active if j['name']!='PR checks passed']
  critical=max(endjobs,key=lambda j:stamp(j['completed_at']),default=None)
  stage=collections.defaultdict(float)
  for j in active:
   for s in j['steps']:
    if s['conclusion']=='skipped':continue
    sec=duration(s.get('started_at'),s.get('completed_at'))
    if sec is None:continue
    stage[category(s['name'])]+=sec
    stages.append({'run':r['id'],'attempt':attempt,'sha':r['head_sha'],'job':j['name'],'step':s['name'],'conclusion':s['conclusion'],'started_at':s['started_at'],'completed_at':s['completed_at'],'seconds':sec,'category':category(s['name'])})
  attempts.append({'attempt':attempt,'jobs':len(jobs),'executed_jobs':len(active),'carried_previous_job_records':len(reported_active)-len(active),'retry_gap_before_execution_s':max(0,min([stamp(j['started_at']) for j in active],default=origin)-previous_completion) if previous_completion else None,'runner_busy_minutes':sum(elapsed)/60,'rounded_runner_minutes_estimate':sum(math.ceil(s/60) for s in elapsed),'initial_queue_from_run_created_s':min([stamp(j['started_at']) for j in active],default=origin)-origin if attempt == 1 and active else None,'first_new_execution_elapsed_from_original_run_created_s':min(stamp(j['started_at']) for j in active)-origin if active else None,'job_queue_sum_s':sum(duration(j.get('created_at'),j.get('started_at')) or 0 for j in active),'first_error_from_run_created_s':min(failed)-origin if failed else None,'aggregate_from_run_created_s':stamp(verify['completed_at'])-origin if verify and verify['conclusion']=='success' else None,'aggregate_conclusion':verify['conclusion'] if verify else None,'publish_from_run_created_s':stamp(publish['completed_at'])-origin if publish and publish['conclusion']=='success' else None,'last_job_from_run_created_s':completion-origin if completion else None,'last_prerequisite_job':critical['name'] if critical else None,'last_prerequisite_completed_at':critical['completed_at'] if critical else None,'runner_step_seconds_by_category':dict(stage)})
  previous_completion=completion or previous_completion
 rows.append({'run':r['id'],'url':r['html_url'],'sha':r['head_sha'],'path':r['path'],'event':r['event'],'conclusion':r['conclusion'],'created_at':r['created_at'],'attempt_count':r['run_attempt'],'attempts':attempts})
summary={}
for label,pred,field in [
 ('PR successful aggregate',lambda r:r['event']=='pull_request','aggregate_from_run_created_s'),
 ('main successful aggregate',lambda r:r['event']=='push','aggregate_from_run_created_s'),
 ('release successful publish',lambda r:r['path']=='.github/workflows/opka-release.yml','publish_from_run_created_s'),
 ('PR first error',lambda r:r['event']=='pull_request','first_error_from_run_created_s')]:
 values=[min(a[field] for a in r['attempts'] if a[field] is not None) for r in rows if pred(r) and any(a[field] is not None for a in r['attempts'])] if field == 'first_error_from_run_created_s' else [a[field] for r in rows if pred(r) for a in r['attempts'][-1:] if a[field] is not None]
 summary[label]={'n':len(values),'p50_seconds':percentile(values,.5),'p95_seconds':percentile(values,.95),'min_seconds':min(values) if values else None,'max_seconds':max(values) if values else None}
for label,pred in [('PR',lambda r:r['event']=='pull_request'),('main',lambda r:r['event']=='push'),('release',lambda r:r['path']=='.github/workflows/opka-release.yml')]:
 values=[sum(a['runner_busy_minutes'] for a in r['attempts']) for r in rows if pred(r)]
 summary[label+' runner busy minutes']={'n':len(values),'p50':percentile(values,.5),'p95':percentile(values,.95),'sum_all_attempts':sum(a['runner_busy_minutes'] for r in rows if pred(r) for a in r['attempts'])}
counts=collections.Counter(a['last_prerequisite_job'] for r in rows if r['event']=='pull_request' for a in r['attempts'][-1:] if a['aggregate_from_run_created_s'] is not None)
summary['PR successful critical predecessor counts']=dict(counts)
natural_ids={r['id'] for r in read_json(ROOT/'actions-run-list-page1.json')['workflow_runs']}
cohort={}
for label,pred,field in [('PR aggregate',lambda r:r['event']=='pull_request','aggregate_from_run_created_s'),('PR first error',lambda r:r['event']=='pull_request','first_error_from_run_created_s'),('main aggregate',lambda r:r['event']=='push','aggregate_from_run_created_s'),('release publish',lambda r:r['path']=='.github/workflows/opka-release.yml','publish_from_run_created_s')]:
 values=[min(a[field] for a in r['attempts'] if a[field] is not None) for r in rows if r['run'] in natural_ids and pred(r) and any(a[field] is not None for a in r['attempts'])] if field == 'first_error_from_run_created_s' else [a[field] for r in rows if r['run'] in natural_ids and pred(r) for a in r['attempts'][-1:] if a[field] is not None]
 cohort[label]={'n':len(values),'p50_seconds':percentile(values,.5),'p95_seconds':percentile(values,.95)}
for label,pred in [('PR',lambda r:r['event']=='pull_request'),('main',lambda r:r['event']=='push'),('release',lambda r:r['path']=='.github/workflows/opka-release.yml')]:
 values=[a['initial_queue_from_run_created_s'] for r in rows if r['run'] in natural_ids and pred(r) for a in r['attempts'][:1] if a['initial_queue_from_run_created_s'] is not None]
 cohort[label+' attempt1 initial scheduling']={'n':len(values),'p50_seconds':percentile(values,.5),'p95_seconds':percentile(values,.95)}
summary['latest_100_repo_runs_cohort']=cohort
first_steps={}
pr_ids={r['run'] for r in rows if r['run'] in natural_ids and r['event']=='pull_request'}
for step in stages:
 if step['run'] in pr_ids and step['conclusion']=='failure':
  current=first_steps.get(step['run'])
  if current is None or step['completed_at'] < current['completed_at']: first_steps[step['run']]=step
summary['natural_PR_first_failing_steps']={'n':len(first_steps),'counts':dict(collections.Counter(step['step'] for step in first_steps.values()))}
summary['sample']={'runs':len(rows),'attempts_collected':sum(len(r['attempts']) for r in rows),'conclusions':dict(collections.Counter(r['conclusion'] for r in rows)),'window_start':min(r['created_at'] for r in rows),'window_end':max(r['created_at'] for r in rows),'percentile_method':'nearest rank; seconds from run.created_at proxy for push receipt (push timestamp unavailable); retry idle time included'}
write_json(ROOT/'actions-metrics.json',{'summary':summary,'runs':rows})
write_json(ROOT/'actions-summary.json',summary)
write_json(ROOT/'actions-step-timings.json',stages)
print(json.dumps(summary,indent=2))
