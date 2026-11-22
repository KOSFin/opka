"""Source-only comparison of extracted policy; no tests/build/dependencies."""
import json,pathlib,subprocess
BASE='7d7a8ffa83fdff34df5211a294f6b076bbee44b4'
def original(path):
    return subprocess.check_output(['git','show',f'{BASE}:{path}'],text=True)
old=original('config/scripts/opka-ci-component-scope.mjs')
new=pathlib.Path('config/scripts/opka-ci-aggregate.mjs').read_text()
before=old[old.index('export function evaluateCiResults'):old.index('export function describeCiScope')].strip()
after=new[new.index('export function evaluateCiResults'):new.index('export function writeQualification')].strip()
assert before==after,'Aggregate policy changed'
old=original('config/scripts/opka-ci-followup-proof.mjs')
before=old[old.index('const SHA'):old.index('\nfunction runGit')].replace("const WORKFLOW = '.github/workflows/pr.yml'\n",'').strip()
new=pathlib.Path('config/scripts/opka-ci-followup-policy.mjs').read_text()
after=new[:new.index('\nexport {')].strip()
assert before==after,'Follow-up policy changed'
print(json.dumps({'baseline':BASE,'evaluatorByteEqual':True,'followupPolicyByteEqual':True}))
