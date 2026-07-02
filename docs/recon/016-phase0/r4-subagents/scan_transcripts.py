import json, sys, glob, os

def scan_file(path):
    result = {
        'path': path,
        'total_lines': 0,
        'attachment_records': 0,
        'hook_attachment_records': 0,  # attachment.type startswith hook_
        'hook_events_seen': set(),
        'has_codebase_intel_in_attachment': False,
        'has_codebase_retrieval_in_attachment': False,
        'has_codebase_intel_anywhere': False,
        'has_codebase_retrieval_anywhere': False,
        'codebase_intel_in_user_msg': False,  # inherited/quoted in prompt
        'codebase_intel_in_system_msg': False,
        'record_types': {},
        'error': None,
    }
    try:
        with open(path, 'r', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                result['total_lines'] += 1
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                t = d.get('type')
                result['record_types'][t] = result['record_types'].get(t, 0) + 1
                s = None
                if t == 'attachment':
                    result['attachment_records'] += 1
                    att = d.get('attachment', {})
                    atype = att.get('type', '')
                    if isinstance(atype, str) and atype.startswith('hook'):
                        result['hook_attachment_records'] += 1
                        he = att.get('hookEvent')
                        if he:
                            result['hook_events_seen'].add(he)
                    content = json.dumps(att)
                    if 'codebase-intelligence' in content:
                        result['has_codebase_intel_in_attachment'] = True
                    if 'codebase-retrieval' in content:
                        result['has_codebase_retrieval_in_attachment'] = True
                elif t == 'user':
                    msg = json.dumps(d.get('message', {}))
                    if 'codebase-intelligence' in msg:
                        result['codebase_intel_in_user_msg'] = True
                    if 'codebase-retrieval' in msg:
                        result['codebase_intel_in_user_msg'] = True
                elif t == 'system':
                    content = json.dumps(d.get('content', ''))
                    if 'codebase-intelligence' in content or 'codebase-retrieval' in content:
                        result['codebase_intel_in_system_msg'] = True
    except Exception as e:
        result['error'] = str(e)
    # anywhere check via raw grep-like fallback
    result['hook_events_seen'] = sorted(result['hook_events_seen'])
    return result

if __name__ == '__main__':
    paths = sys.argv[1:]
    out = []
    for p in paths:
        out.append(scan_file(p))
    print(json.dumps(out, indent=2))
