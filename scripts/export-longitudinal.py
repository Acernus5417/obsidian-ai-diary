"""Readable exports of actual fictional-life API output; does not score or call a model."""
import csv
import json
from pathlib import Path
import sys

workspace = Path(__file__).resolve().parent.parent
root = (workspace / 'test-results' / (sys.argv[1] if len(sys.argv) > 1 else 'two-months')).resolve()
root.relative_to(workspace / 'test-results')
fiction = json.loads((root / 'fiction.json').read_text('utf-8'))
days = {d['date']: d for d in fiction['life']}
requests = [json.loads(line) for line in (root / 'requests.jsonl').read_text('utf-8').splitlines() if line.strip()]
transport = [r for r in requests if 'request' in r]
results = []
partial_reads = []
for file in sorted((root / 'days').glob('*.json')):
    try:
        result = json.loads(file.read_text('utf-8'))
    except json.JSONDecodeError:
        partial_reads.append(file.name)
        continue
    results.append(result)
    day = days[result['date']]
    audit = result.get('audit') or {}
    lines = [f"# {result['date']} · {day['title']}", '', '> 全部生活为虚构；问答、日记与观察来自实际 API。模拟用户不是本人，辅助评分也不是独立人工验收。', '',
             f"状态：{result['status']}；归档：{result.get('archived')}。", '',
             f"问答版本：{result.get('conversationPromptVersion', result.get('promptVersion'))}；正文版本：{result.get('writingPromptVersion', result.get('promptVersion'))}；观察版本：{result.get('observationPromptVersion', result.get('promptVersion'))}。", '',
             '## 隐藏的虚构生活原稿', '', day['truth'], '', '## 实际问答', '']
    for index, message in enumerate(result.get('dialogue', []), 1):
        lines.extend([f"### {index}. {'AI' if message['role'] == 'assistant' else '模拟用户'}", '', message['text'], ''])
    lines.extend(['## 生成日记', '', result.get('body') or '未完成', '', '## AI 观察', '', result.get('observations') or '未完成', ''])
    baseline = result.get('baselineObservationSameInput') or result.get('baselineObservation')
    if baseline:
        lines.extend(['## 旧提示词对照', '', baseline.get('text') or json.dumps(baseline, ensure_ascii=False), ''])
    lines.extend(['## 辅助审阅（须由 Agent 复核）', '', '| 维度 | 分数 |', '| --- | --- |'])
    for key, value in (audit.get('scores') or {}).items():
        lines.append(f'| {key} | {value} |')
    lines.extend(['', audit.get('assessment', ''), '', audit.get('strength', ''), '', '### 提示与原句', ''])
    for flag in audit.get('flags') or []:
        lines.extend([f"- 原句：{flag.get('quote', '')}", f"  复核：{flag.get('reason', '')}", f"  对照：{flag.get('sourceQuote', '')}", ''])
    lines.extend(['### 模拟用户偏离', ''])
    for flag in audit.get('simulationIssues') or []:
        lines.extend([f"- {flag.get('quote', '')}：{flag.get('reason', '')}", ''])
    lines.extend(['## 错误与来源', '', json.dumps(result.get('errors', []), ensure_ascii=False, indent=2), '',
                  f"观察可参考的历史日期：{', '.join(str(d) for d in result.get('historyDates', [])) or '无'}。", '',
                  '完整输入、输出、引用与来源映射见同名 JSON；请求状态和重试见 requests.jsonl。'])
    file.with_suffix('.md').write_text('\n'.join(lines) + '\n', 'utf-8')
for file in (root / 'period-audits').glob('*.json') if (root / 'period-audits').exists() else []:
    result = json.loads(file.read_text('utf-8'))
    lines = [f"# {result['path']} 辅助审阅", '', result['body'], '', '## 审阅记录', '', '```json', json.dumps(result.get('audit'), ensure_ascii=False, indent=2), '```', '']
    file.with_suffix('.md').write_text('\n'.join(lines), 'utf-8')
summary = {
    'fictionDays': len(days), 'completedDays': sum(r.get('status') == 'complete' for r in results),
    'archivedDays': sum(bool(r.get('archived')) for r in results),
    'actualUserAnswers': sum(sum(m['role'] == 'user' for m in r.get('dialogue', [])) for r in results),
    'pendingAuxiliaryDailyAudits': [r['date'] for r in results if r.get('audit', {}).get('pending')],
    'checkpointFilesBeingWritten': partial_reads,
    'actualHttpRequests': len(transport), 'httpSuccess': sum(200 <= r.get('status', 0) < 300 for r in transport),
    'failedRequestsRetained': [dict((k, r[k]) for k in ['date', 'task', 'request', 'status', 'error', 'time'] if k in r) for r in transport if not 200 <= r.get('status', 0) < 300],
    'weeklyFiles': [p.relative_to(root).as_posix() for p in sorted((root / 'vault' / '周记').rglob('*.md'))],
    'monthlyFiles': [p.relative_to(root).as_posix() for p in sorted((root / 'vault' / '月记').rglob('*.md'))],
    'scoreMeaning': '辅助模型的主观评分，未经 Agent 复核不能当质量保证；无历史日的长期联系维度不适合直接平均。',
}
(root / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), 'utf-8')
with (root / 'scores.csv').open('w', encoding='utf-8-sig', newline='') as stream:
    fields = ['date', 'status', 'auditStatus', 'factFaithfulness', 'emotionalFidelity', 'insight', 'longitudinalGrounding', 'recallCoverage', 'flags', 'simulationIssues', 'observationCharacters']
    writer = csv.DictWriter(stream, fieldnames=fields, extrasaction='ignore'); writer.writeheader()
    for result in results:
        audit = result.get('audit') or {}
        writer.writerow({'date': result['date'], 'status': result['status'], 'auditStatus': 'pending' if audit.get('pending') else 'returned', **(audit.get('scores') or {}), 'flags': '' if audit.get('pending') else len(audit.get('flags') or []),
                         'simulationIssues': len(audit.get('simulationIssues') or []), 'observationCharacters': len(result.get('observations') or '')})
index = ['# 两个月真实交互输出索引', '', f"{summary['completedDays']}/62 天完成，{summary['archivedDays']} 份日记归档，{len(summary['weeklyFiles'])} 份周记，{len(summary['monthlyFiles'])} 份月记。", '',
         '全部素材为虚构；未完成或失败不计成功。辅助评分和模拟用户有偏差，见 Agent 复核报告。', '', '## 每日完整记录', '']
for result in results:
    date = result['date']; index.append(f"- [{date} · {days[date]['title']}](days/{date}.md) · [JSON](days/{date}.json) · {result['status']}")
index.extend(['', '## 周记与月记', ''])
for path in summary['weeklyFiles'] + summary['monthlyFiles']:
    index.append(f'- [{path}]({path})')
index.extend(['', '## 其他记录', '', '- [Agent 全量复核与主观评分](AGENT-REVIEW.md)', '- [后续定向真实对照](../two-months-targeted/README.md)', '- [完整虚构生活](fiction.json)', '- [实际请求和重试](requests.jsonl)', '- [评分原始表](scores.csv)', '- [计数和失败汇总](summary.json)',
              '- prompts-*.json：实际各版本提示词与模拟/审阅说明。', '- variants/3.0.0：第一周修改前原稿，后续复测不覆盖它。', '- period-audits：周月回顾辅助审阅及全部事实输入。', ''])
(root / 'README.md').write_text('\n'.join(index), 'utf-8')
print(json.dumps({k: v for k, v in summary.items() if k not in ['failedRequestsRetained', 'weeklyFiles', 'monthlyFiles', 'scoreMeaning']}, ensure_ascii=False))
