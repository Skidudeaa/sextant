import json, subprocess, sys

def run_scan(paths):
    proc = subprocess.run(['python3', 'scan_transcripts.py'] + paths, capture_output=True, text=True)
    return json.loads(proc.stdout)

import glob
sub_paths = subprocess.run(['find', '/root/.claude/projects', '-path', '*/subagents/*', '-name', '*.jsonl'], capture_output=True, text=True).stdout.strip().split('\n')
# exclude workflow journal.jsonl and workflow agent files - we'll separate below
sub_paths = [p for p in sub_paths if p]
wf_only = [p for p in sub_paths if '/workflows/' in p]
task_subagents = [p for p in sub_paths if '/workflows/' not in p]

print(f"Task subagents (non-workflow): {len(task_subagents)}")
print(f"Workflow-scoped agent/journal files: {len(wf_only)}")
