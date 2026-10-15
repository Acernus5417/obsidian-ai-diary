"""Check real-run artifacts, dates and provenance; not semantic/psychological grading."""
import calendar
from datetime import date, timedelta
import json
from pathlib import Path
import re
import sys

workspace = Path(__file__).resolve().parent.parent
root = workspace / 'test-results/two-months'
partial = '--partial' in sys.argv
fiction = json.loads((root / 'fiction.json').read_text('utf-8'))
dates = [d['date'] for d in fiction['life']]
expected_dates = [(date(2026, 7, 1) + timedelta(days=i)).isoformat() for i in range(62)]
assert dates == expected_dates
records = []
for file in sorted((root / 'days').glob('*.json')):
    try:
        r = json.loads(file.read_text('utf-8'))
    except json.JSONDecodeError:
        if partial:
            continue
        raise
    if partial and r['status'] != 'complete':
        continue
    records.append(r)
if not partial:
    assert [r['date'] for r in records] == dates
assert all(r['status'] == 'complete' and r['archived'] for r in records)
lines = (root / 'requests.jsonl').read_text('utf-8').splitlines()
requests = []
for i, line in enumerate(lines):
    try:
        requests.append(json.loads(line))
    except json.JSONDecodeError:
        if partial and i == len(lines) - 1:
            break
        raise
body_start, body_end = '<!-- ai-diary-body:start -->', '<!-- ai-diary-body:end -->'
obs_start, obs_end = '<!-- ai-diary-observations:start -->', '<!-- ai-diary-observations:end -->'
for r in records:
    d = r['date']; path = root / 'vault/日记' / d[:4] / d[5:7] / f'{d}.md'
    text = path.read_text('utf-8')
    assert text.count(body_start) == text.count(body_end) == 1
    body = text.split(body_start, 1)[1].split(body_end, 1)[0].strip()
    assert body == r['body'].strip(), d
    observation = text.split(obs_start, 1)[1].split(obs_end, 1)[0].strip()
    observation = re.sub(r'^## AI 观察\s*', '', observation).strip()
    assert observation == r['observations'].strip(), d
    transcript = (root / 'vault/原始问答' / d[:4] / d[5:7] / f'{d}.md').read_text('utf-8')
    assert all(m['text'] in transcript for m in r['dialogue']), d
    assert '\n\n'.join(p['paragraph'] for p in r['sourceMap']) == r['body'], d
    calls = [q for q in requests if q.get('task') in ['write-natural', 'write-narrative'] and q.get('input', {}).get('date') == d and isinstance(q.get('output'), dict) and q['output'].get('bodyMarkdown') == r['body'] and q['output'].get('sourceMap') == r['sourceMap']]
    assert calls, f'No recorded actual writing output: {d}'
    source_ids = {s['id'] for s in calls[-1]['input']['sources']}
    assert all(set(p['sourceIds']) <= source_ids for p in r['sourceMap']), d
checked_evidence = 0
by_date = {r['date']: r for r in records}
final_history_entries = 0
for r in records:
    if r.get('observationPromptVersion') != '3.0.3':
        if partial:
            continue
        raise AssertionError(f"Final observation missing: {r['date']}")
    assert r.get('audit'), r['date']
    assert r['observationInput']['currentBody'] == r['body']
    for e in r['observationInput']['evidence']:
        assert e['date'] < r['date']
        assert e['date'] in by_date and e['text'] == by_date[e['date']]['body'], (r['date'], e['date'])
        final_history_entries += 1
for row in requests:
    task, data = row.get('task'), row.get('input')
    if not isinstance(data, dict):
        continue
    if task == 'observations':
        for e in data['evidence']:
            assert e['date'] is None or e['date'] < data['date'], (data['date'], e['date'])
            assert obs_start not in e['text'] and '<!-- ai-diary-period:' not in e['text']
            checked_evidence += 1
    if task in ['week-review', 'month-review']:
        period = data['period']
        for e in data['currentPeriod']:
            assert period['start'] <= e['date'] <= period['end']
            assert obs_start not in e['text'] and '<!-- ai-diary-period:' not in e['text']
            checked_evidence += 1
        assert all(e['date'] < period['start'] for e in data['history'])
weeks = sorted((root / 'vault/周记').rglob('*.md'))
months = sorted((root / 'vault/月记').rglob('*.md'))
if not partial:
    assert len(weeks) == 9 and len(months) == 2
coverage = []
for file in weeks + months:
    text = file.read_text('utf-8')
    start = date.fromisoformat(re.search(r'^开始: (\d{4}-\d{2}-\d{2})$', text, re.M)[1])
    end = date.fromisoformat(re.search(r'^结束: (\d{4}-\d{2}-\d{2})$', text, re.M)[1])
    count = int(re.search(r'^记录天数: (\d+)$', text, re.M)[1])
    if partial and records and end.isoformat() > records[-1]['date']:
        continue
    supplied = sum(start.isoformat() <= d <= end.isoformat() for d in dates)
    assert count == supplied
    if file.is_relative_to(root / 'vault/周记'):
        assert start.weekday() == 0 and end - start == timedelta(days=6)
    else:
        assert start.day == 1 and end.day == calendar.monthrange(end.year, end.month)[1] and start.month == end.month
    # Known protocol IDs should be human-readable links, not implementation text.
    if '<!-- ai-diary-prompt:' in text:
        assert not re.search(r'\bp-[0-9a-f]{16}\b', text)
    for link in re.findall(r'\[\[([^\]|]+)(?:\|[^\]]+)?\]\]', text):
        assert link.startswith('日记/')
        assert (root / 'vault' / (link + '.md')).is_file(), link
    coverage.append({'path': file.relative_to(root).as_posix(), 'start': start.isoformat(), 'end': end.isoformat(), 'recordedDays': count})
http = [r for r in requests if 'request' in r]
report = {'passed': True, 'mode': 'partial' if partial else 'complete', 'fictionDays': 62, 'checkedArchivedDays': len(records),
          'dailyBodiesAndObservationsMatch': True, 'originalDialoguesPreserved': True, 'recordedSourceMapsValid': True,
          'evidenceEntriesChecked': checked_evidence, 'futureEvidenceFound': False, 'AIObservationMarkersAsFactsFound': False,
          'finalHistoryEntriesMatchArchivedBodies': final_history_entries,
          'pendingAuxiliaryDailyAudits': [r['date'] for r in records if r.get('audit', {}).get('pending')],
          'weeklyCount': len(weeks), 'monthlyCount': len(months), 'coverage': coverage,
          'actualHttpRequests': len(http), 'failedRequestsRetained': sum(not 200 <= r.get('status', 0) < 300 for r in http),
          'semanticQuality': 'Not proved by these checks. See actual daily/period audits and Agent review; source IDs do not establish psychological truth.'}
(root / ('integrity-partial.json' if partial else 'integrity.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2), 'utf-8')
print(json.dumps({k: v for k, v in report.items() if k not in ['coverage', 'semanticQuality']}, ensure_ascii=False))
